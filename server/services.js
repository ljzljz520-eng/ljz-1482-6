// 核心业务：档案/时间线/角色编辑、公开片段生成与批准、状态联动撤回、
// 异步任务（幂等）、导出快照、下载授权撤销
const crypto = require('crypto');
const { audit } = require('./db');
const S = require('./sanitize');

class ConflictError extends Error { constructor(msg){ super(msg); this.code = 409; } }
class StateError extends Error   { constructor(msg){ super(msg); this.code = 422; } }

// ---------- 档案（乐观锁，验收：两人同时改状态） ----------
function updateAnimalStatus(db, animalId, newStatus, baseVersion, actor) {
  const tx = db.transaction(() => {
    const a = db.prepare('SELECT * FROM animals WHERE id=?').get(animalId);
    if (!a) throw new StateError('animal not found');
    if (a.version !== baseVersion)
      throw new ConflictError(`版本冲突：期望 v${baseVersion}，当前 v${a.version}（${a.updated_by} 已修改），请刷新后重试`);
    db.prepare(`UPDATE animals SET status=?, version=version+1, updated_by=?, updated_at=datetime('now') WHERE id=?`)
      .run(newStatus, actor, animalId);
    db.prepare('INSERT INTO animal_status_history(animal_id,from_status,to_status,actor) VALUES (?,?,?,?)')
      .run(animalId, a.status, newStatus, actor);
    audit(db, actor, 'status_change', 'animal', animalId, { from: a.status, to: newStatus });

    // 关键联动：领养完成 → 撤回已批准招领片 + 取消未完成的发布任务
    // 不能只改档案而让旧发布任务继续完成
    if (newStatus === 'adopted' || newStatus === 'withdrawn') {
      const flyers = db.prepare(
        `SELECT id FROM public_fragments WHERE animal_id=? AND purpose='adoption_flyer' AND status='approved'`).all(animalId);
      for (const f of flyers) {
        db.prepare(`UPDATE public_fragments SET status='withdrawn', withdrawn_at=datetime('now'), withdraw_reason=? WHERE id=?`)
          .run(`动物状态变更为 ${newStatus}，招领片撤回`, f.id);
        audit(db, actor, 'fragment_withdraw', 'public_fragment', f.id, { reason: newStatus });
      }
      const openTasks = db.prepare(
        `SELECT id FROM tasks WHERE animal_id=? AND status IN ('queued','running')`).all(animalId);
      for (const t of openTasks) {
        db.prepare(`UPDATE tasks SET status='cancelled', cancel_reason=?, finished_at=datetime('now') WHERE id=?`)
          .run(`动物状态变更为 ${newStatus}，发布/导出任务取消`, t.id);
        audit(db, actor, 'task_cancel', 'task', t.id, { reason: newStatus });
      }
      // 撤销含招领片导出包的下载授权（新下载被阻断；不声称删除外部已持有副本）
      const grants = db.prepare(
        `SELECT g.id FROM download_grants g JOIN tasks t ON t.id=g.task_id
         WHERE t.animal_id=? AND g.status='active'`).all(animalId);
      for (const g of grants) {
        db.prepare(`UPDATE download_grants SET status='revoked', revoked_at=datetime('now'), revoke_reason=? WHERE id=?`)
          .run('关联动物状态变更，下载授权撤销（外部已下载副本无法追回）', g.id);
      }
      return { withdrawnFlyers: flyers.length, cancelledTasks: openTasks.length, revokedGrants: grants.length };
    }
    return { withdrawnFlyers: 0, cancelledTasks: 0, revokedGrants: 0 };
  });
  return tx();
}

function updateAnimalProfile(db, animalId, fields, baseVersion, actor) {
  const a = db.prepare('SELECT version FROM animals WHERE id=?').get(animalId);
  if (!a) throw new StateError('animal not found');
  if (a.version !== baseVersion)
    throw new ConflictError(`版本冲突：期望 v${baseVersion}，当前 v${a.version}`);
  const allowed = ['alias','real_name','species','breed','rescuer_phone','rescue_address','internal_notes'];
  const sets = [], vals = [];
  for (const k of allowed) if (k in fields) { sets.push(`${k}=?`); vals.push(fields[k]); }
  if (!sets.length) return { updated: 0 };
  db.prepare(`UPDATE animals SET ${sets.join(',')}, version=version+1, updated_by=?, updated_at=datetime('now') WHERE id=?`)
    .run(...vals, actor, animalId);
  audit(db, actor, 'profile_update', 'animal', animalId, { fields: Object.keys(fields) });
  return { updated: 1 };
}

// ---------- 公开片段生成：白名单 + 全文本面检测 ----------
function buildPublicFragments(db, animalId, actor) {
  const a = db.prepare('SELECT * FROM animals WHERE id=?').get(animalId);
  if (!a) throw new StateError('animal not found');
  const ins = db.prepare(
    `INSERT INTO public_fragments(animal_id,source_type,source_id,field,purpose,content,status,findings_json)
     VALUES (?,?,?,?,?,?,?,?)`);
  const made = [];
  const push = (sourceType, sourceId, field, purpose, rawContent, surfaces) => {
    if (!S.isFieldPublic(sourceType, field)) {
      audit(db, actor, 'whitelist_block', 'fragment', null, { sourceType, field });
      return; // 第一层：非白名单字段直接不生成公开片段
    }
    const findings = S.scanAllSurfaces(surfaces); // 第二层：正文+字幕+旁白+清单
    const status = findings.length ? 'needs_review' : 'pending_approval';
    const content = findings.length ? S.redactText(rawContent, findings) : rawContent;
    const r = ins.run(animalId, sourceType, sourceId, field, purpose, content, status, JSON.stringify(findings));
    made.push({ id: r.lastInsertRowid, field, status, findings: findings.length });
  };

  // 档案 → 公开故事字段（化名/物种/城市级位置等；电话、详细地址不在白名单）
  push('profile', a.id, 'alias', 'story', a.alias, { body: a.alias });
  push('profile', a.id, 'species', 'story', a.species, { body: a.species });
  push('profile', a.id, 'story_public', 'story', a.internal_notes || '', { body: a.internal_notes || '' });
  push('profile', a.id, 'status_public', 'adoption_flyer',
    `【招领】${a.alias}（${a.species}）等待领养`, { body: a.alias });

  // 时间线：正文 + 字幕 + 旁白脚本全部过检
  for (const ev of db.prepare('SELECT * FROM timeline_events WHERE animal_id=?').all(animalId)) {
    push('timeline', ev.id, 'title', 'story', ev.title, { body: ev.title });
    push('timeline', ev.id, 'body_public', 'story', ev.body_internal || '',
      { body: ev.body_internal, subtitle: ev.subtitle_text, narration: ev.narration_script });
  }
  // 角色：只用化名，真实姓名/电话不进公开稿
  for (const c of db.prepare('SELECT * FROM characters WHERE animal_id=?').all(animalId)) {
    push('character', c.id, 'public_alias', 'story', c.public_alias || '', { body: c.public_alias });
    push('character', c.id, 'role', 'story', c.role, { body: c.role });
  }
  // 媒体：说明文字过检；人脸/声音/背景进人工复核队列（第三层）
  for (const m of db.prepare('SELECT * FROM media_assets WHERE animal_id=?').all(animalId)) {
    push('media', m.id, 'caption_public', 'story', m.caption_internal || '', { body: m.caption_internal });
    enqueueMediaReview(db, m);
  }
  audit(db, actor, 'fragments_built', 'animal', animalId, { count: made.length });
  return made;
}

function enqueueMediaReview(db, m) {
  const cats = m.kind === 'audio' ? ['audio_voice']
    : m.kind === 'video' ? ['image_faces', 'video_background', 'audio_voice']
    : ['image_faces', 'photo_background'];
  const ins = db.prepare('INSERT INTO review_queue(animal_id,media_id,category,detail) VALUES (?,?,?,?)');
  for (const c of cats) {
    const cat = S.MANUAL_REVIEW_CATEGORIES.find(x => x.key === c);
    ins.run(m.animal_id, m.id, c, `${m.filename}：${cat.label}，机器无法可靠判断，需人工复核`);
  }
}

function approveFragment(db, fragmentId, approver, basis) {
  const f = db.prepare('SELECT * FROM public_fragments WHERE id=?').get(fragmentId);
  if (!f) throw new StateError('fragment not found');
  if (f.status === 'withdrawn') throw new StateError('已撤回的片段不能批准');
  db.prepare(`UPDATE public_fragments SET status='approved' WHERE id=?`).run(fragmentId);
  db.prepare('INSERT INTO approvals(fragment_id,approver,basis) VALUES (?,?,?)').run(fragmentId, approver, basis);
  audit(db, approver, 'fragment_approve', 'public_fragment', fragmentId, { basis });
}

// ---------- 异步任务：幂等（验收：重复投稿任务） ----------
function submitTask(db, type, animalId, idempotencyKey, actor) {
  const dup = db.prepare('SELECT * FROM tasks WHERE idempotency_key=?').get(idempotencyKey);
  if (dup) return { task: dup, deduplicated: true };   // 重复投稿 → 返回已有任务，不新建
  const approved = db.prepare(
    `SELECT * FROM public_fragments WHERE animal_id=? AND status='approved'`).all(animalId);
  const snapshot = approved.map(f => ({
    fragment_id: f.id, source_type: f.source_type, source_id: f.source_id,
    field: f.field, purpose: f.purpose, content: f.content,
  }));
  const r = db.prepare(
    `INSERT INTO tasks(type,animal_id,idempotency_key,snapshot_json,created_by) VALUES (?,?,?,?,?)`)
    .run(type, animalId, idempotencyKey, JSON.stringify(snapshot), actor);
  audit(db, actor, 'task_submit', 'task', r.lastInsertRowid, { type, idempotencyKey });
  return { task: db.prepare('SELECT * FROM tasks WHERE id=?').get(r.lastInsertRowid), deduplicated: false };
}

// ---------- 媒体许可撤销（验收：照片被撤销许可） ----------
function revokeMediaLicense(db, mediaId, actor) {
  const tx = db.transaction(() => {
    const m = db.prepare('SELECT * FROM media_assets WHERE id=?').get(mediaId);
    if (!m) throw new StateError('media not found');
    db.prepare(`UPDATE media_assets SET license_status='revoked' WHERE id=?`).run(mediaId);
    db.prepare(`UPDATE public_fragments SET status='withdrawn', withdrawn_at=datetime('now'),
                withdraw_reason='媒体许可被撤销' WHERE source_type='media' AND source_id=? AND status='approved'`).run(mediaId);
    // 取消引用了该媒体、尚未完成的发布任务（publish_preview 直接外发，必须立即取消；
    // export_package 由 worker 运行时二次校验并排除，见 queue.js）
    const open = db.prepare(
      `SELECT id, snapshot_json FROM tasks WHERE animal_id=? AND status IN ('queued','running') AND type='publish_preview'`).all(m.animal_id);
    let cancelled = 0;
    for (const t of open) {
      const snap = JSON.parse(t.snapshot_json || '[]');
      if (snap.some(f => f.source_type === 'media' && f.source_id === mediaId)) {
        db.prepare(`UPDATE tasks SET status='cancelled', cancel_reason=?, finished_at=datetime('now') WHERE id=?`)
          .run(`媒体#${mediaId} 许可被撤销`, t.id);
        cancelled++;
      }
    }
    audit(db, actor, 'media_license_revoke', 'media', mediaId, { cancelledTasks: cancelled });
    return { cancelledTasks: cancelled };
  });
  return tx();
}

// ---------- 私密备注：永不进入公开稿与导出 ----------
function addPrivateNote(db, animalId, body, author) {
  const r = db.prepare('INSERT INTO private_notes(animal_id,body,author) VALUES (?,?,?)').run(animalId, body, author);
  audit(db, author, 'private_note', 'animal', animalId, { noteId: r.lastInsertRowid });
  return r.lastInsertRowid;
}

// ---------- 下载授权 ----------
function createGrant(db, taskId, issuedTo) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO download_grants(task_id,token,issued_to) VALUES (?,?,?)').run(taskId, token, issuedTo);
  return token;
}
function revokeGrant(db, token, actor, reason) {
  db.prepare(`UPDATE download_grants SET status='revoked', revoked_at=datetime('now'), revoke_reason=? WHERE token=?`)
    .run(reason || '手动撤销', token);
  audit(db, actor, 'grant_revoke', 'download_grant', null, { token: token.slice(0, 8) + '…' });
}
// 解析下载授权：诚实声明——可撤销新下载，但无法删除外部已下载副本
function resolveGrant(db, token) {
  const g = db.prepare('SELECT * FROM download_grants WHERE token=?').get(token);
  if (!g) return { ok: false, code: 404, message: '授权不存在' };
  if (g.status === 'revoked') return {
    ok: false, code: 410,
    message: '该下载授权已撤销。注意：撤销仅阻断新的下载，此前已下载到外部的副本无法由本平台删除。',
  };
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(g.task_id);
  return { ok: true, path: t.result_path, notice: '下载后本平台无法控制该副本的进一步传播' };
}

module.exports = {
  ConflictError, StateError,
  updateAnimalStatus, updateAnimalProfile, buildPublicFragments, approveFragment,
  submitTask, revokeMediaLicense, addPrivateNote,
  createGrant, revokeGrant, resolveGrant, enqueueMediaReview,
};
