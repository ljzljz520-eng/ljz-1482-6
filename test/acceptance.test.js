// 验收测试：
//  1. 两人同时改动物状态 → 乐观锁，后到者 409
//  2. 照片被撤销许可 → 引用它的排队发布任务被取消，导出排除该媒体
//  3. 导出排队中补入私密备注 → 导出包不含该备注
//  4. 重复投稿任务 → 幂等键去重，只执行一次
//  5. 脱敏覆盖字幕/旁白/附带清单，不止页面文本
//  6. 白名单拦截非公开字段；元数据剥离
//  7. 领养完成 → 已批准招领片撤回 + 旧发布任务取消（不允许带病完成）
//  8. 下载授权可撤销，且响应诚实声明无法删除外部副本
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { createDb } = require('../server/db');
const svc = require('../server/services');
const queue = require('../server/queue');
const S = require('../server/sanitize');

function seedAnimal(db, opts = {}) {
  const id = db.prepare(`INSERT INTO animals(alias,species,breed,rescuer_phone,rescue_address,internal_notes,updated_by)
    VALUES (?,?,?,?,?,?,?)`).run(
    opts.alias || '咪咪', '猫', '橘猫', '13812345678', '上海市浦东新区张杨路500号',
    opts.notes || '在小区花园救助，联系电话13812345678', 'seed').lastInsertRowid;
  db.prepare(`INSERT INTO timeline_events(animal_id,event_date,title,body_internal,subtitle_text,narration_script)
    VALUES (?,?,?,?,?,?)`).run(id, '2026-09-01', '雨夜救助',
    '在浦东张杨路500号附近发现', '字幕：发现于张杨路500号', '旁白：请联系13812345678');
  db.prepare(`INSERT INTO characters(animal_id,real_name,public_alias,role,contact_phone) VALUES (?,?,?,?,?)`)
    .run(id, '张三', '张姐', '救助人', '13998765432');
  return id;
}
function approveAll(db, animalId) {
  svc.buildPublicFragments(db, animalId, 'editor-a');
  for (const f of db.prepare(`SELECT id FROM public_fragments WHERE animal_id=?`).all(animalId))
    svc.approveFragment(db, f.id, 'reviewer-1', 'whitelist_pass+scan_clean');
}

test('验收1：两人同时改动物状态，后到者收到409冲突', () => {
  const db = createDb();
  const id = seedAnimal(db);
  const v = db.prepare('SELECT version FROM animals WHERE id=?').get(id).version;
  svc.updateAnimalStatus(db, id, 'adoptable', v, 'editor-a');          // 第一人成功
  assert.throws(() => svc.updateAnimalStatus(db, id, 'adopted', v, 'editor-b'),  // 第二人用旧版本
    e => e.code === 409);
  const a = db.prepare('SELECT * FROM animals WHERE id=?').get(id);
  assert.equal(a.status, 'adoptable');   // 以先提交者为准
  assert.equal(a.version, v + 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM animal_status_history WHERE animal_id=?').get(id).c, 1);
});

test('验收2：照片被撤销许可 → 排队发布任务取消，导出排除该媒体', () => {
  const db = createDb();
  const id = seedAnimal(db);
  const mid = db.prepare(`INSERT INTO media_assets(animal_id,kind,filename,caption_internal,exif_json,license_status)
    VALUES (?,?,?,?,?, 'granted')`).run(id, 'photo', 'cat.jpg', '康复照', '{"GPSLatitude":31.2,"Make":"Sony"}').lastInsertRowid;
  approveAll(db, id);
  const { task } = svc.submitTask(db, 'export_package', id, 'export-key-1', 'editor-a');
  assert.equal(task.status, 'queued');
  svc.revokeMediaLicense(db, mid, 'editor-b');                    // 许可撤销
  const res = queue.processNextTask(db);                          // 队列继续跑
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id);
  assert.equal(t.status, 'done_with_exclusions');                 // 完成但排除被撤销媒体
  const pkg = JSON.parse(fs.readFileSync(t.result_path, 'utf8'));
  assert.ok(!pkg.fragments.some(f => f.source_type === 'media' && f.source_id === mid), '导出包不含被撤销媒体');
  assert.ok(JSON.parse(t.exclusions_json).some(e => /许可(被|已)撤销/.test(e.reason)));
  // 媒体片段本身也应被撤回
  assert.equal(db.prepare(`SELECT status FROM public_fragments WHERE source_type='media' AND source_id=?`).get(mid).status, 'withdrawn');
});

test('验收3：导出排队中补入私密备注 → 导出包不含该备注', () => {
  const db = createDb();
  const id = seedAnimal(db);
  approveAll(db, id);
  const { task } = svc.submitTask(db, 'export_package', id, 'export-key-2', 'editor-a');
  svc.addPrivateNote(db, id, '内部：疑似前主人电话 13700001111，勿公开', 'editor-b');  // 排队期间补备注
  queue.processNextTask(db);
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id);
  const raw = fs.readFileSync(t.result_path, 'utf8');
  assert.ok(!raw.includes('13700001111'), '导出包不得包含排队期间新增的私密备注');
  assert.ok(!raw.includes('私密') && !JSON.parse(raw).private_notes, '导出包结构上无私密备注字段');
});

test('验收4：重复投稿任务 → 幂等去重，只执行一次', () => {
  const db = createDb();
  const id = seedAnimal(db);
  approveAll(db, id);
  const r1 = svc.submitTask(db, 'publish_preview', id, 'post-2026-10-03-01', 'editor-a');
  const r2 = svc.submitTask(db, 'publish_preview', id, 'post-2026-10-03-01', 'editor-b'); // 重复投稿
  assert.equal(r1.deduplicated, false);
  assert.equal(r2.deduplicated, true);
  assert.equal(r1.task.id, r2.task.id);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM tasks WHERE idempotency_key='post-2026-10-03-01'`).get().c, 1);
  queue.drain(db);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM tasks WHERE animal_id=? AND status LIKE 'done%'`).get(id).c, 1);
});

test('验收5：脱敏覆盖正文/字幕/旁白/附带清单所有文本面', () => {
  const hits = S.scanAllSurfaces({
    body: '正文电话13812345678',
    subtitle: '字幕：家住上海市浦东新区张杨路500号',
    narration: '旁白：微信 rescuer_zhang 联系',
    manifest: '清单：身份证310115199001011234，邮箱a@b.com',
  });
  const surfaces = new Set(hits.map(h => h.surface));
  for (const s of ['body', 'subtitle', 'narration', 'manifest']) assert.ok(surfaces.has(s), `缺少${s}面的检测`);
  const types = new Set(hits.map(h => h.type));
  for (const t of ['phone_mobile', 'address_detail', 'id_card', 'email']) assert.ok(types.has(t), `缺少${t}类型`);
});

test('验收6：白名单拦截非公开字段；EXIF元数据剥离GPS/机主', () => {
  const db = createDb();
  const id = seedAnimal(db);
  svc.buildPublicFragments(db, id, 'editor-a');
  const fields = db.prepare('SELECT DISTINCT field FROM public_fragments WHERE animal_id=?').all(id).map(r => r.field);
  for (const f of fields) assert.ok(['alias','species','story_public','status_public','title','body_public','public_alias','role'].includes(f));
  assert.ok(!fields.includes('rescuer_phone') && !fields.includes('rescue_address'), '敏感字段不得生成公开片段');
  // 内部备注里的电话进入白名单字段内容 → 被检测命中 → needs_review + 占位脱敏
  const story = db.prepare(`SELECT * FROM public_fragments WHERE animal_id=? AND field='story_public'`).get(id);
  assert.equal(story.status, 'needs_review');
  assert.ok(story.content.includes('〔已脱敏:手机号码〕'));
  const { clean, stripped } = S.stripMetadata('{"GPSLatitude":31.2,"GPSLongitude":121.4,"OwnerName":"张三","Make":"Sony"}');
  assert.deepEqual(clean, { Make: 'Sony' });
  assert.ok(stripped.includes('GPSLatitude') && stripped.includes('OwnerName'));
});

test('验收7：领养完成 → 已批准招领片撤回 + 旧发布任务取消（不带病完成）', () => {
  const db = createDb();
  const id = seedAnimal(db);
  approveAll(db, id);
  svc.submitTask(db, 'publish_preview', id, 'flyer-post-1', 'editor-a');   // 已排队的旧发布任务
  const flyer = db.prepare(`SELECT * FROM public_fragments WHERE animal_id=? AND purpose='adoption_flyer'`).get(id);
  assert.equal(flyer.status, 'approved');
  const v = db.prepare('SELECT version FROM animals WHERE id=?').get(id).version;
  const r = svc.updateAnimalStatus(db, id, 'adopted', v, 'editor-a');      // 领养完成
  assert.equal(r.withdrawnFlyers, 1);
  assert.equal(r.cancelledTasks, 1);
  assert.equal(db.prepare('SELECT status FROM public_fragments WHERE id=?').get(flyer.id).status, 'withdrawn');
  const t = db.prepare(`SELECT * FROM tasks WHERE idempotency_key='flyer-post-1'`).get();
  assert.equal(t.status, 'cancelled');
  assert.match(t.cancel_reason, /adopted/);
  queue.drain(db);                                                          // 队列继续跑也不应执行它
  assert.equal(db.prepare(`SELECT status FROM tasks WHERE id=?`).get(t.id).status, 'cancelled');
});

test('验收8：下载授权可撤销，响应诚实声明无法删除外部副本', () => {
  const db = createDb();
  const id = seedAnimal(db);
  approveAll(db, id);
  const { task } = svc.submitTask(db, 'export_package', id, 'export-key-3', 'editor-a');
  queue.processNextTask(db);
  const token = svc.createGrant(db, task.id, 'partner-org');
  assert.equal(svc.resolveGrant(db, token).ok, true);
  svc.revokeGrant(db, token, 'editor-a', '合作终止');
  const r = svc.resolveGrant(db, token);
  assert.equal(r.ok, false);
  assert.equal(r.code, 410);
  assert.match(r.message, /无法由本平台删除|无法删除/);   // 诚实声明：不声称已删除外部副本
});

test('人工复核队列：人脸/声音/背景类目自动入队', () => {
  const db = createDb();
  const id = seedAnimal(db);
  const mid = db.prepare(`INSERT INTO media_assets(animal_id,kind,filename) VALUES (?,?,?)`).run(id, 'video', 'rescue.mp4').lastInsertRowid;
  svc.enqueueMediaReview(db, db.prepare('SELECT * FROM media_assets WHERE id=?').get(mid));
  const cats = db.prepare('SELECT category FROM review_queue WHERE media_id=?').all(mid).map(r => r.category);
  assert.ok(cats.includes('image_faces') && cats.includes('audio_voice') && cats.includes('video_background'));
});
