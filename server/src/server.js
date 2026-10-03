import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import {
  getInternal, getPublic, saveInternal, savePublic,
  resetInternal, resetPublic, emptyInternal, emptyPublic,
  newId, now, token, audit, mustFind, find,
} from './store.js';
import {
  sanitizeWorking, sanitizePhotoMeta, ANIMAL_PUBLIC_FIELDS,
} from './redact.js';
import {
  startWorker, stopWorker, enqueue, requestCancel, listJobs,
  cancelQueuedForSegment, cancelQueuedForMedia, processOnceForTest, drain,
} from './worker.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---------- 演示种子数据 ----------
export function seedIfEmpty() {
  const db = getInternal();
  if (db.animals.length) return;
  db.seq = 100;
  db.animals.push({
    id: 'anm_1', version: 1, public_name: '橘座', species: '猫', breed: '中华田园猫',
    age_estimate: '约2岁', sex: '公（已绝育）', status: 'in_shelter',
    public_story: '在小区停车场被发现时后腿受伤，治愈后性格亲人。',
    internal_notes: '救助人王姐 13800138000，暂住朝阳区幸福路88号幸福花园3栋2单元501室，勿公开。',
    real_name: '大橘（救助人对它的称呼）', chip_no: '900123456789012',
    medical_detail: '右后腿骨裂，已愈', foster_address: '朝阳区幸福路88号幸福花园3栋2单元501室',
    created_at: now(), updated_at: now(),
  });
  db.events.push({
    id: 'evt_1', animal_id: 'anm_1', at: '2026-09-01', type: 'rescue',
    note_public: '雨夜在停车场被救助，右后腿受伤。',
    note_internal: '救助人垫付医药费，联系电话 13800138000；发现地点 GPS 39.908700,116.397500',
    created_at: now(),
  });
  db.characters.push({
    id: 'chr_1', animal_id: 'anm_1', role: '救助人', display_name: '王姐',
    bio_public: '长期参与社区流浪猫TNR的志愿者。',
    bio_internal: '真实姓名王秀兰，住址同救助点附近，微信: wx_wangxiu_lan99',
    created_at: now(),
  });
  db.media.push({
    id: 'med_1', animal_id: 'anm_1', kind: 'photo', license_status: 'granted',
    caption: '住院期间的橘座', preview_url: '/demo/cat1.jpg',
    meta: {
      Width: 3024, Height: 4032, Make: 'Apple', Model: 'iPhone 13',
      DateTime: '2026:09:01 22:14:03', GPSLatitude: '39 deg 54\' 31.32" N',
      GPSLongitude: '116 deg 23\' 51.00" E', Artist: '王秀兰', Software: '美图秀秀',
    },
    face_suspected: false, voice_suspected: false, background_suspected: true,
    created_at: now(),
  });
  db.segments.push({
    id: 'seg_1', animal_id: 'anm_1', kind: 'adoption_flyer', title: '橘座找家招领片',
    working: {
      summary: '橘座，亲人小橘猫，寻长期饭票！联系电话 13800138000。',
      subtitles: [{ at: '00:03', text: '它叫橘座，电话 138-0013-8000 联系领养' }],
      narration: [{ at: '00:00', text: '大家好，我住在朝阳区幸福路88号幸福花园3栋，捡到了它。' }],
      checklist: [{ text: '片尾字幕放上救助人微信 wx_wangxiu_lan99' }],
      media_refs: [{ media_id: 'med_1', face: false, voice: false, background: true }],
      photo_meta: { med_1: { ...db.media[0].meta } },
      sources: [{ kind: 'event', ref_id: 'evt_1' }, { kind: 'character', ref_id: 'chr_1' }],
    },
    approval: null, approved_preview: null, withdrawn: false,
    published_at: null, last_preview: null, created_at: now(), updated_at: now(),
  });
  saveInternal();
}

// ================= 动物档案 =================
app.get('/api/animals', (req, res) => {
  res.json(getInternal().animals);
});
app.get('/api/animals/:id', (req, res) => {
  const a = getInternal().animals.find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'not_found' });
  res.json(a);
});
app.post('/api/animals', (req, res) => {
  const b = req.body || {};
  const a = {
    id: newId('anm'), version: 1,
    public_name: b.public_name || '未命名', species: b.species || '', breed: b.breed || '',
    age_estimate: b.age_estimate || '', sex: b.sex || '', status: 'in_shelter',
    public_story: b.public_story || '',
    internal_notes: b.internal_notes || '', real_name: b.real_name || '',
    chip_no: b.chip_no || '', medical_detail: b.medical_detail || '', foster_address: b.foster_address || '',
    created_at: now(), updated_at: now(),
  };
  getInternal().animals.push(a); saveInternal();
  audit('animal.create', { id: a.id }, b.actor);
  res.status(201).json(a);
});

// 两人同时改动物状态：乐观锁 If-Match=version
app.put('/api/animals/:id', (req, res) => {
  const a = mustFind('animals', req.params.id);
  const expected = req.header('If-Match') ? Number(req.header('If-Match')) : undefined;
  if (expected !== undefined && expected !== a.version) {
    return res.status(409).json({
      error: 'conflict', message: '档案已被他人修改，请刷新后重试',
      current: { version: a.version, status: a.status, updated_at: a.updated_at },
    });
  }
  const b = req.body || {};
  const before = { status: a.status };
  for (const f of ['public_name', 'species', 'breed', 'age_estimate', 'sex', 'status',
    'public_story', 'internal_notes', 'real_name', 'chip_no', 'medical_detail', 'foster_address']) {
    if (b[f] !== undefined) a[f] = b[f];
  }
  a.version += 1; a.updated_at = now();
  saveInternal();
  audit('animal.update', { id: a.id, before, after: { status: a.status }, version: a.version }, b.actor);

  // 领养完成联动：撤回所有招领片 + 取消其排队任务（旧发布任务不得继续完成）
  if (before.status !== 'adopted' && a.status === 'adopted') {
    const effects = [];
    for (const seg of getInternal().segments) {
      if (seg.animal_id === a.id && seg.kind === 'adoption_flyer' && !seg.withdrawn) {
        seg.withdrawn = true; seg.withdrawn_reason = 'animal_adopted'; seg.withdrawn_at = now();
        const n = cancelQueuedForSegment(seg.id, 'animal_adopted');
        // 已公开的招领片在公开库标记撤回
        const pub = getPublic().published.find((p) => p.segment_id === seg.id);
        if (pub && !pub.withdrawn) { pub.withdrawn = true; pub.withdrawn_reason = 'animal_adopted'; pub.withdrawn_at = now(); }
        effects.push({ segment_id: seg.id, canceled_jobs: n });
      }
    }
    savePublic(); saveInternal();
    audit('adoption.cascade_withdraw', { animal_id: a.id, effects }, b.actor);
    return res.json({ animal: a, adoption_cascade: effects });
  }
  res.json(a);
});

// ================= 时间线事件 =================
app.get('/api/animals/:id/events', (req, res) => {
  res.json(getInternal().events.filter((e) => e.animal_id === req.params.id));
});
app.post('/api/animals/:id/events', (req, res) => {
  mustFind('animals', req.params.id);
  const b = req.body || {};
  const e = {
    id: newId('evt'), animal_id: req.params.id, at: b.at || now().slice(0, 10),
    type: b.type || 'note', note_public: b.note_public || '', note_internal: b.note_internal || '',
    created_at: now(),
  };
  getInternal().events.push(e); saveInternal();
  audit('event.create', { id: e.id }, b.actor);
  res.status(201).json(e);
});

// ================= 叙事角色 =================
app.get('/api/animals/:id/characters', (req, res) => {
  res.json(getInternal().characters.filter((c) => c.animal_id === req.params.id));
});
app.post('/api/animals/:id/characters', (req, res) => {
  mustFind('animals', req.params.id);
  const b = req.body || {};
  const c = {
    id: newId('chr'), animal_id: req.params.id, role: b.role || '志愿者',
    display_name: b.display_name || '匿名志愿者', bio_public: b.bio_public || '',
    bio_internal: b.bio_internal || '', created_at: now(),
  };
  getInternal().characters.push(c); saveInternal();
  audit('character.create', { id: c.id }, b.actor);
  res.status(201).json(c);
});

// ================= 媒体 =================
app.get('/api/animals/:id/media', (req, res) => {
  res.json(getInternal().media.filter((m) => m.animal_id === req.params.id));
});
app.post('/api/animals/:id/media', (req, res) => {
  mustFind('animals', req.params.id);
  const b = req.body || {};
  // 上传即做元数据白名单剥离（原始元数据不写入任何公开可用结构）
  const meta = b.meta || {};
  const sm = sanitizePhotoMeta(meta);
  const m = {
    id: newId('med'), animal_id: req.params.id, kind: b.kind || 'photo',
    license_status: 'granted', caption: b.caption || '',
    preview_url: b.preview_url || '/demo/placeholder.jpg',
    meta: sm.kept, // 入库的已经是剥离后的安全版本
    meta_stripped: sm.stripped,
    face_suspected: !!b.face_suspected, voice_suspected: !!b.voice_suspected,
    background_suspected: !!b.background_suspected,
    created_at: now(),
  };
  getInternal().media.push(m); saveInternal();
  audit('media.upload', { id: m.id, stripped_keys: sm.stripped.map((x) => x.key) }, b.actor);
  res.status(201).json(m);
});
// 撤销照片许可：引用它的排队任务取消、已批准片段标记需复审
app.post('/api/media/:mid/revoke', (req, res) => {
  const m = mustFind('media', req.params.mid);
  if (m.license_status === 'revoked') return res.json(m);
  m.license_status = 'revoked'; m.revoked_at = now();
  const affected = [];
  for (const seg of getInternal().segments) {
    if ((seg.working?.media_refs || []).some((r) => r.media_id === m.id)) {
      affected.push(seg.id);
      if (seg.approval?.status === 'approved') {
        seg.approval.invalid_reason = 'media_license_revoked';
      }
      const pub = getPublic().published.find((p) => p.segment_id === seg.id && !p.withdrawn);
      if (pub) { pub.withdrawn = true; pub.withdrawn_reason = 'media_license_revoked'; pub.withdrawn_at = now(); }
    }
  }
  const canceled = cancelQueuedForMedia(m.id, 'media_license_revoked');
  savePublic(); saveInternal();
  audit('media.revoke', { media_id: m.id, affected_segments: affected, canceled_jobs: canceled }, req.body?.actor);
  res.json({ media: m, affected_segments: affected, canceled_jobs: canceled });
});

// ================= 叙事片段（工作稿） =================
app.get('/api/animals/:id/segments', (req, res) => {
  res.json(getInternal().segments.filter((s) => s.animal_id === req.params.id));
});
app.post('/api/animals/:id/segments', (req, res) => {
  mustFind('animals', req.params.id);
  const b = req.body || {};
  const seg = {
    id: newId('seg'), animal_id: req.params.id,
    kind: b.kind || 'story', title: b.title || '未命名片段',
    working: b.working || { summary: '', subtitles: [], narration: [], checklist: [], media_refs: [], sources: [] },
    approval: null, approved_preview: null, withdrawn: false,
    published_at: null, last_preview: null, created_at: now(), updated_at: now(),
  };
  getInternal().segments.push(seg); saveInternal();
  audit('segment.create', { id: seg.id, kind: seg.kind }, b.actor);
  res.status(201).json(seg);
});
app.put('/api/segments/:sid', (req, res) => {
  const seg = mustFind('segments', req.params.sid);
  if (seg.withdrawn) return res.status(409).json({ error: 'withdrawn', message: '片段已撤回，不能再编辑' });
  const b = req.body || {};
  if (b.title !== undefined) seg.title = b.title;
  if (b.working !== undefined) { seg.working = b.working; seg.approval = null; seg.approved_preview = null; }
  // 导出排队中补入私密备注：private_note 仅内部字段，永远不进入 working/快照
  if (b.private_note !== undefined) seg.private_note = b.private_note;
  seg.updated_at = now(); saveInternal();
  audit('segment.update', { id: seg.id, edited_content: b.working !== undefined, had_private_note: b.private_note !== undefined }, b.actor);
  res.json(seg);
});
app.post('/api/segments/:sid/withdraw', (req, res) => {
  const seg = mustFind('segments', req.params.sid);
  seg.withdrawn = true; seg.withdrawn_reason = req.body?.reason || 'manual'; seg.withdrawn_at = now();
  cancelQueuedForSegment(seg.id, seg.withdrawn_reason, req.body?.actor);
  const pub = getPublic().published.find((p) => p.segment_id === seg.id);
  if (pub) { pub.withdrawn = true; pub.withdrawn_reason = seg.withdrawn_reason; pub.withdrawn_at = now(); }
  savePublic(); saveInternal();
  audit('segment.withdraw', { segment_id: seg.id, reason: seg.withdrawn_reason }, req.body?.actor);
  res.json(seg);
});

// 同步试算脱敏（不建任务，快速预览）
app.post('/api/segments/:sid/redact-preview', (req, res) => {
  const seg = mustFind('segments', req.params.sid);
  const r = sanitizeWorking(seg.working);
  res.json(r);
});

// 批准：复核项全部关闭 + 批准清单逐项确认
app.post('/api/segments/:sid/approve', (req, res) => {
  const seg = mustFind('segments', req.params.sid);
  if (seg.withdrawn) return res.status(409).json({ error: 'withdrawn', message: '片段已撤回' });
  const db = getInternal();
  const revoked = (seg.working?.media_refs || []).filter((r) => {
    const mm = db.media.find((x) => x.id === r.media_id);
    return mm && mm.license_status !== 'granted';
  });
  if (revoked.length) return res.status(409).json({ error: 'license', message: `照片许可已撤销: ${revoked.map((r) => r.media_id).join(',')}` });
  const open = db.review_items.filter((r) => r.segment_id === seg.id && r.status !== 'resolved');
  if (open.length) return res.status(409).json({ error: 'review_open', count: open.length, items: open });
  const b = req.body || {};
  const required = ['fields_whitelist_confirmed', 'text_scan_confirmed', 'face_confirmed', 'voice_confirmed', 'background_confirmed'];
  const checklist = b.checklist || b; // 兼容勾选项直接放在顶层
  const missing = required.filter((k) => !checklist[k]);
  if (missing.length) return res.status(409).json({ error: 'checklist', missing });
  const trial = sanitizeWorking(seg.working);
  // 文本命中的 PII 已由检测层自动打码；真正的阻断条件是：仍有开放的人工复核项（上面已拦截）。
  // 这里对打码后的文本再自检一遍，确认没有活的电话号码/地址残留。
  const flat = JSON.stringify(trial.preview);
  if (/1[3-9](?:[-\s]?\d){9}/.test(flat)) {
    return res.status(409).json({ error: 'pii_live', message: '打码后仍检测到手机号' });
  }
  seg.approved_preview = trial.preview;
  seg.approval = {
    status: 'approved', at: now(), by: b.by || 'anonymous',
    basis: b.basis || '编辑台人工核对白名单+检测报告+复核队列',
    checklist, content_hash: crypto.createHash('sha256').update(JSON.stringify(trial.preview)).digest('hex'),
  };
  seg.updated_at = now(); saveInternal();
  audit('segment.approve', { segment_id: seg.id, by: seg.approval.by }, b.by);
  res.json(seg);
});

// ================= 复核队列（人脸/声音/背景人工） =================
app.get('/api/review-items', (req, res) => {
  let items = getInternal().review_items;
  if (req.query.segment) items = items.filter((r) => r.segment_id === req.query.segment);
  if (req.query.status) items = items.filter((r) => r.status === req.query.status);
  res.json(items);
});
app.post('/api/review-items/:rid/resolve', (req, res) => {
  const r = mustFind('review_items', req.params.rid);
  r.status = 'resolved'; r.resolved_at = now();
  r.resolution = req.body?.resolution || 'confirmed_safe'; // masked|removed|confirmed_safe
  r.resolved_by = req.body?.by || 'anonymous'; r.note = req.body?.note || '';
  saveInternal();
  audit('review.resolve', { item_id: r.id, resolution: r.resolution }, r.resolved_by);
  res.json(r);
});

// ================= 异步任务 =================
app.get('/api/jobs', (req, res) => res.json(listJobs(req.query.segment)));
app.post('/api/segments/:sid/jobs', (req, res) => {
  const type = (req.body?.type || 'sanitize');
  if (!['sanitize', 'export', 'publish'].includes(type)) return res.status(400).json({ error: 'bad_type' });
  const r = enqueue({ type, segment_id: req.params.sid, payload: req.body?.payload || {}, actor: req.body?.actor });
  res.status(202).json(r);
});
app.post('/api/jobs/:jid/cancel', (req, res) => res.json(requestCancel(req.params.jid, req.body?.actor)));
app.post('/api/jobs/tick', (req, res) => { processOnceForTest().then(() => res.json({ ok: true })); });
app.post('/api/jobs/drain', async (req, res) => { await drain(); res.json({ ok: true }); });

// ================= 导出包与下载授权 =================
app.get('/api/packages', (req, res) => res.json(getInternal().packages.map((p) => ({ ...p, snapshot: undefined }))));
app.get('/api/packages/:pid', (req, res) => res.json(mustFind('packages', req.params.pid)));
app.post('/api/packages/:pid/grant', (req, res) => {
  const pkg = mustFind('packages', req.params.pid);
  const g = {
    id: newId('grnt'), package_id: pkg.id, token: token(), grantee: req.body?.grantee || '外部领养协调员',
    created_at: now(), expires_at: req.body?.expires_at || null, active: true, revoked_at: null,
  };
  getInternal().grants.push(g); saveInternal();
  audit('grant.create', { grant_id: g.id, package_id: pkg.id, grantee: g.grantee }, req.body?.actor);
  res.status(201).json(g);
});
app.post('/api/grants/:gid/revoke', (req, res) => {
  const g = mustFind('grants', req.params.gid);
  g.active = false; g.revoked_at = now(); saveInternal();
  audit('grant.revoke', { grant_id: g.id, package_id: g.package_id }, req.body?.actor);
  res.json(g);
});
app.get('/api/grants', (req, res) => res.json(getInternal().grants));
// 外部下载入口：凭授权 token；授权撤销即 403（但无法影响对方此前已下载的副本）
app.get('/api/external/download/:token', (req, res) => {
  const g = getInternal().grants.find((x) => x.token === req.params.token);
  if (!g) return res.status(404).json({ error: 'not_found' });
  if (!g.active) {
    audit('download.blocked_revoked', { grant_id: g.id });
    return res.status(403).json({ error: 'revoked', message: '下载授权已撤销' });
  }
  if (g.expires_at && new Date(g.expires_at) < new Date()) return res.status(403).json({ error: 'expired' });
  const pkg = getInternal().packages.find((p) => p.id === g.package_id);
  if (!pkg) return res.status(404).json({ error: 'package_gone' });
  audit('download.ok', { grant_id: g.id, package_id: pkg.id });
  res.setHeader('Content-Disposition', `attachment; filename="${pkg.id}.json"`);
  res.json(pkg.snapshot);
});

// ================= 公开站点（只读 public.json） =================
app.get('/api/public/stories', (req, res) => {
  res.json(getPublic().published.filter((p) => !p.withdrawn));
});
app.get('/api/public/stories/:pid', (req, res) => {
  const p = getPublic().published.find((x) => x.public_id === req.params.pid || x.segment_id === req.params.pid);
  if (!p) return res.status(404).json({ error: 'not_found' });
  if (p.withdrawn) return res.status(410).json({ error: 'withdrawn', reason: p.withdrawn_reason, at: p.withdrawn_at });
  // 只回公开白名单字段 + 来源与批准依据
  res.json({
    public_id: p.public_id, kind: p.kind, title: p.title, animal: p.animal,
    content: p.content, sources: p.sources,
    approval: p.approval, published_at: p.published_at,
  });
});

// 审计日志
app.get('/api/audit', (req, res) => res.json(getInternal().audit.slice(0, 200)));

// 演示/测试工具：重置
app.post('/api/dev/reset', (req, res) => {
  resetInternal(emptyInternal()); resetPublic(emptyPublic()); seedIfEmpty();
  res.json({ ok: true });
});

// API 未匹配必须返回 JSON，不能回退到前端 HTML
app.use('/api', (req, res) => res.status(404).json({ error: 'api_not_found', path: req.path }));

// 静态资源（构建后的前端）
const webDist = path.join(process.cwd(), '..', 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

export function start(port = 4000) {
  seedIfEmpty();
  startWorker();
  const srv = app.listen(port, () => console.log(`server on http://localhost:${port}`));
  return { app, srv, stop: () => { stopWorker(); srv.close(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start(Number(process.env.PORT || 4000));
}
