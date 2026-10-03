// 端到端验收：启动真实 HTTP 服务（测试库隔离到 data-test），覆盖全部指定场景。
import assert from 'node:assert/strict';
process.env.DATA_DIR = new URL('../data-test', import.meta.url).pathname;
process.env.PORT = '4099';
process.env.JOB_TICK_MS = '80';
process.env.JOB_DELAY_MS = '20';

import fs from 'node:fs';
if (fs.existsSync(process.env.DATA_DIR)) fs.rmSync(process.env.DATA_DIR, { recursive: true });

const { start } = await import('../src/server.js');
const { stopWorker } = await import('../src/worker.js');
const srv = start(4099);
await new Promise((r) => setTimeout(r, 200));

const B = process.env.DATA_DIR;
const base = 'http://localhost:4099/api';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra ?? ''); }
};
const j = async (u, o) => {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(base + u, { headers: { connection: 'close', 'content-type': 'application/json' }, ...o });
      const text = await r.text();
      let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { status: r.status, body };
    } catch (e) {
      lastErr = e;
      await sleep(150);
    }
  }
  console.error('FETCH FAIL', u, lastErr?.message);
  throw lastErr;
};
const post = (u, body) => j(u, { method: 'POST', body: JSON.stringify(body) });
const put = (u, body, v) => j(u, { method: 'PUT', headers: { 'content-type': 'application/json', ...(v != null ? { 'If-Match': String(v) } : {}) }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(segId, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await sleep(150);
    const { body } = await j(`/jobs?segment=${segId}`);
    if (!body.some((x) => ['queued', 'running'].includes(x.status))) return body;
  }
}

try {
  console.log('\n=== 脱敏组合策略：四个文本面 + 照片元数据全覆盖 ===');
  const seg = (await post('/animals/anm_1/segments', { kind: 'adoption_flyer', title: '测试片段', working: {
    summary: '电话13800138000',
    subtitles: [{ at: '0:01', text: '拨打 138-0013-8000' }],
    narration: [{ at: '0:02', text: '我家在朝阳区幸福路88号幸福花园3栋2单元501室' }],
    checklist: [{ text: '加微信 wx_secret_001' }],
    media_refs: [{ media_id: 'med_1', face: true, voice: true, background: true }],
    photo_meta: { med_1: { Width: 100, GPSLatitude: '39N', Artist: '王某', Software: 'PS' } },
    sources: [{ kind: 'event', ref_id: 'evt_1' }],
  } })).body;
  await post(`/segments/${seg.id}/jobs`, { type: 'sanitize' });
  let jobs = await settle(seg.id);
  const sjob = jobs.find((x) => x.type === 'sanitize');
  ok('脱敏任务成功', sjob.status === 'succeeded', sjob.error);
  const pv = sjob.result.preview;
  ok('正文电话被打码', pv.summary.includes('***电话***') && !pv.summary.includes('13800138000'));
  ok('字幕中的分隔符电话被打码', pv.subtitles[0].text.includes('***电话***'));
  ok('旁白脚址中的家庭住址被打码', pv.narration[0].text.includes('***家庭住址***'));
  ok('附带清单中的微信号被打码', pv.checklist[0].text.includes('***微信号***'));
  ok('照片元数据白名单保留 Width', String(pv.photo_meta.med_1.Width) === '100');
  ok('照片元数据剥离 GPS/Artist/Software', !pv.photo_meta.med_1.GPSLatitude && !pv.photo_meta.med_1.Artist);
  const findings = sjob.result.findings;
  ok('检测报告标注了照片元数据剥离项', findings.some((f) => f.type === 'photo_meta' && f.key === 'GPSLatitude'));
  ok('人脸/声音/背景进入人工复核队列', sjob.result.review_items.map((r) => r.type).sort().join() === 'background,face,voice');
  ok('机器盲区清单明确列出人脸/声音/背景', sjob.result.machine_limitations.some((x) => x.type === 'face')
    && sjob.result.machine_limitations.some((x) => x.type === 'voice')
    && sjob.result.machine_limitations.some((x) => x.type === 'background'));
  const items = (await j(`/review-items?segment=${seg.id}`)).body;
  ok('复核项落库且为 pending', items.length === 3 && items.every((x) => x.status === 'pending'));

  console.log('\n=== 复核未关闭不能批准 ===');
  const bad = await post(`/segments/${seg.id}/approve`, { checklist: {} });
  ok('复核项开放时批准返回 409', bad.status === 409 && bad.body.error === 'review_open');
  for (const it of items) await post(`/review-items/${it.id}/resolve`, { resolution: 'masked', by: 'tester' });
  const bad2 = await post(`/segments/${seg.id}/approve`, { checklist: {} });
  ok('复核关闭但清单未勾选仍 409', bad2.status === 409 && bad2.body.error === 'checklist');

  const CHK = { fields_whitelist_confirmed: true, text_scan_confirmed: true, face_confirmed: true, voice_confirmed: true, background_confirmed: true };
  const ap = await post(`/segments/${seg.id}/approve`, { checklist: CHK, by: 'tester' });
  ok('勾选全部依据后批准成功', ap.status === 200 && ap.body.approval.status === 'approved');

  console.log('\n=== 场景① 两人同时改动物状态（乐观锁） ===');
  const a = (await post('/animals', { public_name: '并发狗' })).body;
  const rA = await put(`/animals/${a.id}`, { status: 'fostered' }, 1);
  const rB = await put(`/animals/${a.id}`, { status: 'adopted' }, 1);
  ok('A 基于 v1 提交成功→v2', rA.status === 200 && rA.body.version === 2);
  ok('B 基于过期 v1 提交被拒 409', rB.status === 409 && rB.body.current.version === 2);
  const finalA = (await j(`/animals/${a.id}`)).body;
  ok('最终状态为 A 的 fostered，未被覆盖', finalA.status === 'fostered' && finalA.version === 2);

  console.log('\n=== 领养完成联动：撤回招领片 + 取消旧发布任务（不能只改档案） ===');
  // seg 已批准的招领片：排队导出与发布，然后动物改 adopted
  await post(`/segments/${seg.id}/jobs`, { type: 'export' });
  await post(`/segments/${seg.id}/jobs`, { type: 'publish' });
  const upd = await put('/animals/anm_1', { status: 'adopted' }, undefined);
  ok('领养更新返回联动效果', Array.isArray(upd.body.adoption_cascade) && upd.body.adoption_cascade.some((e) => e.segment_id === seg.id));
  jobs = (await j(`/jobs?segment=${seg.id}`)).body;
  const canceled = jobs.filter((x) => ['export', 'publish'].includes(x.type) && x.status === 'canceled');
  ok('排队中的导出/发布任务被联动取消（至少2个）', canceled.length >= 2, canceled.map((x) => `${x.type}:${x.status}`));
  const segAfter = (await j('/segments/' + seg.id)).body || (await j('/animals/anm_1/segments')).body.find((x) => x.id === seg.id);
  const segs1 = (await j('/animals/anm_1/segments')).body;
  ok('招领片本身已标记 withdrawn', segs1.find((x) => x.id === seg.id).withdrawn === true);
  // 再次尝试导出，运行时闸门必须拦截
  const re = await post(`/segments/${seg.id}/jobs`, { type: 'export' });
  await settle(seg.id);
  jobs = (await j(`/jobs?segment=${seg.id}`)).body;
  ok('领养后新导出任务被闸门判失败', jobs[0].status === 'failed' && /领养|撤回/.test(jobs[0].error || ''), jobs[0].error);

  console.log('\n=== 场景② 照片许可撤销 ===');
  // 新动物新片段，脱敏任务引用 med 不可跨动物，这里直接造一个动物并上传新媒体
  const a2 = (await post('/animals', { public_name: '许可猫' })).body;
  const med = (await post(`/animals/${a2.id}/media`, { caption: '许可测试照', meta: { Width: 9, GPSLatitude: 'x' }, background_suspected: true })).body;
  const seg2 = (await post(`/animals/${a2.id}/segments`, { kind: 'story', title: '许可故事', working: {
    summary: '故事', subtitles: [], narration: [], checklist: [],
    media_refs: [{ media_id: med.id, face: false, voice: false, background: true }],
    photo_meta: { [med.id]: med.meta }, sources: [],
  } })).body;
  await post(`/segments/${seg2.id}/jobs`, { type: 'sanitize' });
  await post(`/segments/${seg2.id}/jobs`, { type: 'sanitize', payload: { q: 2 } });
  const rev = await post(`/media/${med.id}/revoke`, {});
  ok('撤销许可返回受影响片段', rev.body.affected_segments.includes(seg2.id));
  await settle(seg2.id);
  jobs = (await j(`/jobs?segment=${seg2.id}`)).body;
  ok('引用该照片的在途任务被取消/失败', jobs.every((x) => ['canceled', 'failed', 'succeeded'].includes(x.status))
    && jobs.some((x) => x.status === 'canceled' || (x.status === 'failed' && /许可/.test(x.error || ''))),
    jobs.map((x) => `${x.type}:${x.status}:${x.error || ''}`));

  console.log('\n=== 场景③ 导出排队中补入私密备注 ===');
  const a3 = (await post('/animals', { public_name: '备注猫', internal_notes: '内部电话13900000000' })).body;
  const seg3 = (await post(`/animals/${a3.id}/segments`, { kind: 'story', title: '备注故事', working: {
    summary: '干净的公开文本', subtitles: [], narration: [], checklist: [], media_refs: [], sources: [],
  } })).body;
  await post(`/segments/${seg3.id}/jobs`, { type: 'sanitize' });
  await settle(seg3.id);
  await post(`/segments/${seg3.id}/approve`, { checklist: CHK, by: 'tester' });
  const ej = await post(`/segments/${seg3.id}/jobs`, { type: 'export' });
  await put(`/segments/${seg3.id}`, { private_note: '秘密：领养人是张医生 13700001111 朝阳区某小区' });
  await settle(seg3.id);
  jobs = (await j(`/jobs?segment=${seg3.id}`)).body;
  const exportJob = jobs.find((x) => x.type === 'export');
  ok('导出任务在补备注后仍成功（备注不影响快照）', exportJob.status === 'succeeded', exportJob.error);
  const pkg = (await j(`/packages/${exportJob.result.package_id}`)).body;
  const flat = JSON.stringify(pkg.snapshot);
  ok('包内无私密备注内容', !flat.includes('张医生') && !flat.includes('private_note'));
  ok('包内无内部字段与未打码电话', !/internal_notes|real_name|chip_no|foster_address|bio_internal|note_internal|13900000000/.test(flat));
  ok('包内动物仅含白名单字段', Object.keys(pkg.snapshot.animal).every((k) => ['id','public_name','species','breed','age_estimate','sex','status','public_story'].includes(k)));
  ok('包内含批准依据', !!pkg.snapshot.approval && !!pkg.snapshot.approval.content_hash);

  console.log('\n=== 场景④ 重复投稿任务幂等去重 ===');
  const a4 = (await post('/animals', { public_name: '去重猫' })).body;
  const seg4 = (await post(`/animals/${a4.id}/segments`, { kind: 'story', title: '去重', working: { summary: 'x', subtitles: [], narration: [], checklist: [], media_refs: [], sources: [] } })).body;
  const d1 = await post(`/segments/${seg4.id}/jobs`, { type: 'sanitize', payload: { k: 1 } });
  const d2 = await post(`/segments/${seg4.id}/jobs`, { type: 'sanitize', payload: { k: 1 } });
  const d3 = await post(`/segments/${seg4.id}/jobs`, { type: 'sanitize', payload: { k: 2 } });
  ok('相同载荷重复投稿合并到同一任务', d2.body.duplicated === true && d2.body.job.id === d1.body.job.id);
  ok('不同载荷产生新任务', d3.body.duplicated === false && d3.body.job.id !== d1.body.job.id);

  console.log('\n=== 公开库：来源/批准依据展示、撤回 410、内部库物理隔离 ===');
  // 用 seg3 发布
  await post(`/segments/${seg3.id}/jobs`, { type: 'publish' });
  await settle(seg3.id);
  const list = (await j('/public/stories')).body;
  const pub = list.find((x) => x.segment_id === seg3.id);
  ok('发布后公开列表可见', !!pub);
  const pd = (await j(`/public/stories/${pub.public_id}`)).body;
  ok('公开详情含来源与批准依据', pd.approval?.by === 'tester' && Array.isArray(pd.sources));
  ok('公开详情不暴露内部结构', !('private_note' in pd) && !(pd.animal && 'internal_notes' in pd.animal));
  // 物理隔离：直接读 public.json 不应含任何内部字段
  const pubFile = JSON.parse(fs.readFileSync(B + '/../data-test/public.json', 'utf8'));
  const pubFlat = JSON.stringify(pubFile);
  ok('公开库文件不含任何内部备注/真实姓名/私密备注', !/内部电话|张医生|private_note|chip_no|bio_internal/.test(pubFlat));

  console.log('\n=== 下载授权：签发 / 撤销后 403 / 不声称删除外部副本 ===');
  const g = (await post(`/packages/${pkg.id}/grant`, { grantee: '外部协调员' })).body;
  const dl1 = await j(`/external/download/${g.token}`);
  ok('有效授权可下载快照', dl1.status === 200 && dl1.body.segment_id === seg3.id);
  await post(`/grants/${g.id}/revoke`, {});
  const dl2 = await j(`/external/download/${g.token}`);
  ok('撤销授权后下载返回 403', dl2.status === 403 && dl2.body.error === 'revoked');
  ok('撤销不删除旧包文件本身（仍在内部包列表）', !!(await j(`/packages/${pkg.id}`)).body.snapshot);

  console.log(`\n======== 结果: ${pass} 通过 / ${fail} 失败 ========`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('测试执行异常:', e);
  process.exitCode = 1;
} finally {
  await sleep(300);
  stopWorker();
  srv.srv.close();
}
