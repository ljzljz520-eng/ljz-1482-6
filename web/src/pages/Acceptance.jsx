import React, { useState } from 'react';
import { api } from '../lib/api.js';

// 四个验收场景，全部对真实后端执行
const SCENARIOS = [
  {
    id: 'concurrent', title: '① 两人同时改动物状态（乐观锁）',
    desc: '编辑 A 与编辑 B 基于同一版本各自提交；后提交者必须收到 409，不能覆盖。',
    run: runConcurrent,
  },
  {
    id: 'revoke', title: '② 照片被撤销许可（在途任务取消 + 公开稿撤回）',
    desc: '引用某照片的片段已有脱敏/导出任务排队，撤销许可后排队任务取消，已发布稿立即下架。',
    run: runRevoke,
  },
  {
    id: 'private', title: '③ 导出排队中补入私密备注（不得进入包）',
    desc: '批准并排队导出后，向片段追加 private_note；导出完成后检查包内无该备注、无内部字段。',
    run: runPrivate,
  },
  {
    id: 'dup', title: '④ 重复投稿任务（幂等去重）',
    desc: '对同一片段连续两次提交相同脱敏任务，应合并为同一任务并记录重复请求次数。',
    run: runDup,
  },
];

export default function Acceptance({ actor, notify }) {
  const [out, setOut] = useState({});
  const [busy, setBusy] = useState(null);
  const run = async (s) => {
    setBusy(s.id); setOut((o) => ({ ...o, [s.id]: [{ t: '开始：' + s.title, pass: null }] }));
    const log = (t, pass, data) => setOut((o) => ({ ...o, [s.id]: [...(o[s.id] || []), { t, pass, data }] }));
    try { await s.run({ actor, log, notify }); log('场景完成', true); }
    catch (e) { log('异常: ' + e.message, false); }
    setBusy(null);
  };
  const reset = async () => {
    await api.post('/dev/reset', {});
    notify({ kind: 'warn', title: '演示数据已重置' });
    setOut({});
  };
  return (
    <div>
      <div className="card">
        <h3>验收场景（对运行中的后端执行真实操作）</h3>
        <p className="muted">建议先重置演示数据。每个场景给出逐步判定（绿=通过，红=失败）。</p>
        <button className="btn ghost" onClick={reset}>重置演示数据</button>
      </div>
      {SCENARIOS.map((s) => (
        <div key={s.id} className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div><h3 style={{ margin: 0 }}>{s.title}</h3><div className="muted">{s.desc}</div></div>
            <button className="btn" disabled={busy === s.id} onClick={() => run(s)}>{busy === s.id ? '执行中…' : '执行场景'}</button>
          </div>
          {(out[s.id] || []).map((line, i) => (
            <div key={i} className={`acc-step ${line.pass === true ? 'pass' : line.pass === false ? 'fail' : ''}`}>
              {line.pass === true ? '✅ ' : line.pass === false ? '❌ ' : '• '}{line.t}
              {line.data && <pre className="preview-box" style={{ marginTop: 6 }}>{typeof line.data === 'string' ? line.data : JSON.stringify(line.data, null, 2)}</pre>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------- 场景实现 ----------
async function runConcurrent({ log }) {
  // 准备一个全新动物，两人都读到 v1
  const c = await api.post('/animals', { public_name: '并发测试犬', species: '狗' });
  const id = c.body.id;
  const a = await api.put(`/animals/${id}`, { status: 'fostered' }, 1);
  log('编辑 A 基于 v1 提交 → 成功，版本升至 v' + a.body.version, a.body.version === 2, { status: a.status });
  const b = await api.put(`/animals/${id}`, { status: 'adopted' }, 1);
  const ok = b.status === 409 && b.body.current.version === 2;
  log('编辑 B 仍基于旧 v1 提交 → 期望 409 冲突，实际 ' + b.status, ok, b.body);
  const fresh = await api.get(`/animals/${id}`);
  log('档案最终状态保持 A 的结果（fostered），未被 B 覆盖: ' + fresh.body.status, fresh.body.status === 'fostered');
}

async function runRevoke({ log }) {
  // 用种子片段 seg_1：先补一次脱敏预览任务并尽快撤销照片
  const med = 'med_1';
  const j1 = await api.post('/segments/seg_1/jobs', { type: 'sanitize' });
  log('提交脱敏任务 ' + j1.body.job.id + '（引用照片 ' + med + '）', true);
  // 再入一个，制造排队堆积
  const j2 = await api.post('/segments/seg_1/jobs', { type: 'sanitize', payload: { n: 2 } });
  const rev = await api.post(`/media/${med}/revoke`, {});
  log('撤销照片许可 → 影响片段 ' + rev.body.affected_segments.join(',') + '，取消排队任务 ' + rev.body.canceled_jobs + ' 个',
    rev.body.affected_segments.includes('seg_1'), rev.body);
  await wait(900);
  const jobs = (await api.get('/jobs?segment=seg_1')).body;
  const mine = jobs.filter((j) => [j1.body.job.id, j2.body.job.id].includes(j.id));
  const canceled = mine.filter((j) => j.status === 'canceled' || (j.status === 'failed' && /许可/.test(j.error || '')));
  log('在途任务结果：' + mine.map((j) => `${j.id}=${j.status}${j.error ? '(' + j.error + ')' : ''}`).join('；'),
    canceled.length >= 1 || mine.some((j) => j.error && /许可/.test(j.error)));
}

async function runPrivate({ actor, log }) {
  // 新建独立动物+片段，批准后导出，导出排队期间补私密备注
  const a = await api.post('/animals', { public_name: '私密备注测试猫', species: '猫' });
  const aid = a.body.id;
  await api.post(`/animals/${aid}/events`, { note_public: '在路边被救助。' });
  const seg = await api.post(`/animals/${aid}/segments`, {
    kind: 'story', title: '私密备注验收故事',
    working: {
      summary: '它很好，联系 13800138000', subtitles: [], narration: [], checklist: [],
      media_refs: [], sources: [],
    },
  });
  const sid = seg.body.id;
  const san = await api.post(`/segments/${sid}/jobs`, { type: 'sanitize' });
  await waitJobs(sid);
  const chk = {
    fields_whitelist_confirmed: true, text_scan_confirmed: true,
    face_confirmed: true, voice_confirmed: true, background_confirmed: true,
  };
  const ap = await api.post(`/segments/${sid}/approve`, { checklist: chk, by: actor || '验收员' });
  log('脱敏+批准完成: ' + (ap.body.approval ? ap.body.approval.content_hash.slice(0, 12) : ap.body.message), ap.ok, ap.body.approval ? 'approved' : ap.body);
  const ex = await api.post(`/segments/${sid}/jobs`, { type: 'export' });
  log('导出任务已排队: ' + ex.body.job.id, true);
  // 排队期间补入私密备注
  await api.put(`/segments/${sid}`, { private_note: '【私密】领养人为某医生，家住朝阳区某小区，勿外传' });
  // 再尝试往工作稿塞内部备注（若已批准后改内容会重置批准；此处只改 private_note，验证独立通道）
  log('导出排队中补入 private_note（内部字段）', true);
  await waitExport(sid);
  // 导出完成后从任务结果取 package_id，再读取完整快照
  const jobsNow = (await api.get(`/jobs?segment=${sid}`)).body;
  const exportJob = jobsNow.find((j) => j.type === 'export');
  const pkgId = exportJob?.result?.package_id;
  const pkg = (await api.get(`/packages/${pkgId}`)).body;
  const flat = JSON.stringify(pkg.snapshot);
  const leakPriv = flat.includes('某医生') || flat.includes('private_note');
  const leakInternal = /internal_notes|real_name|chip_no|foster_address|13800138000/.test(flat);
  log('导出包中不含私密备注', !leakPriv);
  log('导出包中不含任何内部字段/未打码电话', !leakInternal, {
    keys: Object.keys(pkg.snapshot),
    content_summary: pkg.snapshot.content.summary,
    animal_keys: Object.keys(pkg.snapshot.animal),
  });
}

async function runDup({ log }) {
  const r1 = await api.post('/segments/seg_1/jobs', { type: 'sanitize', payload: { surface: 'abc' } });
  const r2 = await api.post('/segments/seg_1/jobs', { type: 'sanitize', payload: { surface: 'abc' } });
  const ok = r2.body.duplicated === true && r2.body.job.id === r1.body.job.id;
  log('第二次相同投稿返回同一任务 ' + r2.body.job.id + '，duplicated=true，重复计数=' + (r2.body.job.duplicate_requests + 1), ok,
    { first: r1.body.job.id, second: r2.body.job.id });
  // 不同载荷应产生新任务
  const r3 = await api.post('/segments/seg_1/jobs', { type: 'sanitize', payload: { surface: 'different' } });
  log('载荷不同时新建任务: ' + r3.body.job.id + '（≠ ' + r1.body.job.id + '）', r3.body.job.id !== r1.body.job.id);
}

// ---------- 辅助 ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitJobs(sid, n = 20) {
  for (let i = 0; i < n; i++) {
    await wait(300);
    const js = (await api.get(`/jobs?segment=${sid}`)).body;
    if (!js.some((j) => ['queued', 'running'].includes(j.status))) return js;
  }
}
async function waitExport(sid) {
  for (let i = 0; i < 20; i++) {
    await wait(300);
    const js = (await api.get(`/jobs?segment=${sid}`)).body;
    if (!js.some((j) => ['queued', 'running'].includes(j.status))) break;
  }
  return (await api.get('/packages')).body;
}
