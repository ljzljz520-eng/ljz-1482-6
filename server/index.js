const express = require('express');
const path = require('path');
const { createDb } = require('./db');
const svc = require('./services');
const queue = require('./queue');
const S = require('./sanitize');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data.sqlite');
const db = createDb(DB_FILE);
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const actor = req => req.get('X-Actor') || 'anonymous';
const wrap = fn => (req, res) => {
  try { res.json(fn(req, res)); }
  catch (e) { res.status(e.code || 500).json({ error: e.message, code: e.code }); }
};

// ---- 动物档案 ----
app.post('/api/animals', wrap(req => {
  const { alias, species, breed, real_name, rescuer_phone, rescue_address, internal_notes } = req.body;
  const r = db.prepare(`INSERT INTO animals(alias,species,breed,real_name,rescuer_phone,rescue_address,internal_notes,updated_by)
    VALUES (?,?,?,?,?,?,?,?)`).run(alias, species, breed, real_name, rescuer_phone, rescue_address, internal_notes, actor(req));
  return { id: r.lastInsertRowid };
}));
app.get('/api/animals', wrap(() => db.prepare('SELECT id,alias,species,breed,status,version,updated_by,updated_at FROM animals').all()));
app.get('/api/animals/:id', wrap(req => ({
  animal: db.prepare('SELECT * FROM animals WHERE id=?').get(req.params.id),
  timeline: db.prepare('SELECT * FROM timeline_events WHERE animal_id=?').all(req.params.id),
  characters: db.prepare('SELECT * FROM characters WHERE animal_id=?').all(req.params.id),
  media: db.prepare('SELECT * FROM media_assets WHERE animal_id=?').all(req.params.id),
  private_notes: db.prepare('SELECT * FROM private_notes WHERE animal_id=?').all(req.params.id),
  status_history: db.prepare('SELECT * FROM animal_status_history WHERE animal_id=? ORDER BY id').all(req.params.id),
})));
app.put('/api/animals/:id', wrap(req =>
  svc.updateAnimalProfile(db, +req.params.id, req.body.fields, req.body.baseVersion, actor(req))));
app.put('/api/animals/:id/status', wrap(req =>
  svc.updateAnimalStatus(db, +req.params.id, req.body.status, req.body.baseVersion, actor(req))));

// ---- 时间线 / 角色 / 媒体 ----
app.post('/api/animals/:id/timeline', wrap(req => {
  const { event_date, title, body_internal, subtitle_text, narration_script } = req.body;
  const r = db.prepare(`INSERT INTO timeline_events(animal_id,event_date,title,body_internal,subtitle_text,narration_script)
    VALUES (?,?,?,?,?,?)`).run(req.params.id, event_date, title, body_internal, subtitle_text, narration_script);
  return { id: r.lastInsertRowid };
}));
app.post('/api/animals/:id/characters', wrap(req => {
  const { real_name, public_alias, role, bio_internal, contact_phone, consent_form } = req.body;
  const r = db.prepare(`INSERT INTO characters(animal_id,real_name,public_alias,role,bio_internal,contact_phone,consent_form)
    VALUES (?,?,?,?,?,?,?)`).run(req.params.id, real_name, public_alias, role, bio_internal, contact_phone, consent_form);
  return { id: r.lastInsertRowid };
}));
app.post('/api/animals/:id/media', wrap(req => {
  const { kind, filename, caption_internal, exif } = req.body;
  const r = db.prepare(`INSERT INTO media_assets(animal_id,kind,filename,caption_internal,exif_json)
    VALUES (?,?,?,?,?)`).run(req.params.id, kind, filename, caption_internal, JSON.stringify(exif || {}));
  svc.enqueueMediaReview(db, db.prepare('SELECT * FROM media_assets WHERE id=?').get(r.lastInsertRowid));
  return { id: r.lastInsertRowid };
}));
app.post('/api/media/:id/revoke', wrap(req => svc.revokeMediaLicense(db, +req.params.id, actor(req))));

// ---- 公开片段：生成 / 批准 / 查看（含来源与批准依据） ----
app.post('/api/animals/:id/fragments/build', wrap(req => svc.buildPublicFragments(db, +req.params.id, actor(req))));
app.post('/api/fragments/:id/approve', wrap(req => {
  svc.approveFragment(db, +req.params.id, actor(req), req.body.basis || 'whitelist_pass+scan_clean');
  return { ok: true };
}));
app.get('/api/animals/:id/public', wrap(req => {
  const frags = db.prepare(`
    SELECT f.*, a.approver, a.basis AS approval_basis, a.at AS approved_at
    FROM public_fragments f
    LEFT JOIN approvals a ON a.fragment_id = f.id AND a.revoked_at IS NULL
    WHERE f.animal_id=? ORDER BY f.id`).all(req.params.id);
  // 每个公开片段都带来源（source_type/source_id/field）与批准依据（approver/basis）
  return frags.map(f => ({
    id: f.id, field: f.field, purpose: f.purpose, content: f.content, status: f.status,
    source: { type: f.source_type, id: f.source_id, field: f.field },
    approval: f.approver ? { approver: f.approver, basis: f.approval_basis, at: f.approved_at } : null,
    findings: JSON.parse(f.findings_json || '[]'),
    withdrawn_at: f.withdrawn_at, withdraw_reason: f.withdraw_reason,
  }));
}));

// ---- 任务（幂等键去重） ----
app.post('/api/animals/:id/tasks', wrap(req => {
  const key = req.get('Idempotency-Key') || req.body.idempotency_key;
  if (!key) { const e = new Error('缺少 Idempotency-Key'); e.code = 400; throw e; }
  return svc.submitTask(db, req.body.type, +req.params.id, key, actor(req));
}));
app.get('/api/tasks', wrap(() => db.prepare('SELECT * FROM tasks ORDER BY id DESC').all()));
app.post('/api/tasks/drain', wrap(() => queue.drain(db)));

// ---- 私密备注 ----
app.post('/api/animals/:id/private-notes', wrap(req =>
  ({ id: svc.addPrivateNote(db, +req.params.id, req.body.body, actor(req)) })));

// ---- 人工复核队列 ----
app.get('/api/review-queue', wrap(() =>
  db.prepare('SELECT * FROM review_queue ORDER BY id DESC').all().map(r => ({
    ...r, category_label: (S.MANUAL_REVIEW_CATEGORIES.find(c => c.key === r.category) || {}).label,
  }))));
app.post('/api/review-queue/:id/resolve', wrap(req => {
  db.prepare(`UPDATE review_queue SET status='resolved', resolution=? WHERE id=?`).run(req.body.resolution, req.params.id);
  return { ok: true };
}));
app.get('/api/review-categories', wrap(() => S.MANUAL_REVIEW_CATEGORIES));

// ---- 下载授权 ----
app.post('/api/tasks/:id/grants', wrap(req => ({ token: svc.createGrant(db, +req.params.id, req.body.issued_to || 'unknown') })));
app.post('/api/grants/revoke', wrap(req => { svc.revokeGrant(db, req.body.token, actor(req), req.body.reason); return { ok: true }; }));
app.get('/api/download/:token', (req, res) => {
  const r = svc.resolveGrant(db, req.params.token);
  if (!r.ok) return res.status(r.code).json(r);
  res.json({ ok: true, path: r.path, notice: r.notice });
});

// ---- 审计 ----
app.get('/api/audit', wrap(() => db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all()));

queue.startWorker(db);
const port = process.env.PORT || 3000;
if (require.main === module) app.listen(port, () => console.log(`pet-rescue-story-studio on :${port}`));
module.exports = { app, db };
