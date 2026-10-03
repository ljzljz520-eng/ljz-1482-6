import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api.js';
import { fmt } from '../pages/Studio.jsx';

const KIND = [['adoption_flyer', '招领片'], ['story', '救助故事'], ['update', '进展更新']];

export default function Segments({ animal, actor, notify }) {
  const [segs, setSegs] = useState([]);
  const [selId, setSelId] = useState(null);
  const [seg, setSeg] = useState(null);
  const [events, setEvents] = useState([]);
  const [chars, setChars] = useState([]);
  const [media, setMedia] = useState([]);

  const loadSegs = useCallback(async () => {
    const r = await api.get(`/animals/${animal.id}/segments`);
    setSegs(r.body);
    if (!selId && r.body[0]) setSelId(r.body[0].id);
  }, [animal.id, selId]);

  useEffect(() => { loadSegs(); api.get(`/animals/${animal.id}/events`).then((r) => setEvents(r.body));
    api.get(`/animals/${animal.id}/characters`).then((r) => setChars(r.body));
    api.get(`/animals/${animal.id}/media`).then((r) => setMedia(r.body));
    const t = setInterval(loadSegs, 1500); return () => clearInterval(t);
  }, [animal.id]);
  useEffect(() => { setSeg(segs.find((s) => s.id === selId) || null); }, [segs, selId]);

  const create = async () => {
    const r = await api.post(`/animals/${animal.id}/segments`, {
      kind: 'story', title: '新片段', actor,
      working: { summary: '', subtitles: [], narration: [], checklist: [], media_refs: [], sources: [], photo_meta: {} },
    });
    setSelId(r.body.id); loadSegs();
  };
  const reload = () => loadSegs();

  return (
    <div className="grid2" style={{ gridTemplateColumns: '240px 1fr' }}>
      <div>
        {segs.map((s) => (
          <div key={s.id} className={`list-item ${selId === s.id ? 'active' : ''}`} onClick={() => setSelId(s.id)}>
            <b>{s.title}</b>
            <div><span className="pill blue">{Object.fromEntries(KIND)[s.kind]}</span>{' '}
              {s.withdrawn ? <span className="pill red">已撤回</span>
                : s.approval?.status === 'approved' ? <span className="pill green">已批准</span>
                : <span className="pill amber">草稿</span>}</div>
            {s.published_at && <div className="muted">已发布 {fmt(s.published_at)}</div>}
          </div>
        ))}
        <button className="btn ghost" style={{ width: '100%' }} onClick={create}>+ 新建片段</button>
      </div>
      <div>{seg ? <SegmentEditor key={seg.id} seg={seg} animal={animal} actor={actor} notify={notify} reload={reload}
        events={events} chars={chars} media={media} /> : <div className="muted">选择或新建片段</div>}</div>
    </div>
  );
}

function SegmentEditor({ seg: initial, animal, actor, notify, reload, events, chars, media }) {
  const [seg, setSeg] = useState(initial);
  const [jobs, setJobs] = useState([]);
  const [items, setItems] = useState([]);
  const [checklist, setChecklist] = useState({});
  const [privateNote, setPrivateNote] = useState(initial.private_note || '');
  useEffect(() => { setSeg(initial); setPrivateNote(initial.private_note || ''); }, [initial.id, initial.version, initial.updated_at]);

  const w = seg.working || {};
  const refreshJobs = useCallback(async () => setJobs((await api.get(`/segments/${seg.id}/jobs`)).body), [seg.id]);
  const refreshItems = useCallback(async () => setItems((await api.get(`/review-items?segment=${seg.id}`)).body), [seg.id]);
  useEffect(() => { refreshJobs(); refreshItems(); const t = setInterval(() => { refreshJobs(); refreshItems(); }, 1200); return () => clearInterval(t); }, [seg.id]);

  const update = (patch) => setSeg({ ...seg, working: { ...seg.working, ...patch } });
  const save = async () => {
    const r = await api.put(`/segments/${seg.id}`, { working: seg.working, title: seg.title, actor });
    if (r.ok) { notify({ kind: 'ok', title: '工作稿已保存', msg: '内容改动后批准状态已重置' }); reload(); }
  };
  const savePrivate = async () => {
    const r = await api.put(`/segments/${seg.id}`, { private_note: privateNote, actor });
    if (r.ok) { notify({ kind: 'warn', title: '私密备注已存为内部字段', msg: '它不属于公开白名单，不会进入快照/导出包；导出排队中补入也不会泄露' }); reload(); }
  };
  const enqueueJob = async (type) => {
    const r = await api.post(`/segments/${seg.id}/jobs`, { type, actor });
    if (r.body.duplicated) notify({ kind: 'warn', title: '重复投稿任务已合并', msg: `复用排队/运行中的任务 ${r.body.job.id}` });
    refreshJobs();
  };
  const approve = async () => {
    const r = await api.post(`/segments/${seg.id}/approve`, { checklist, by: actor });
    if (r.status === 409) {
      if (r.body.error === 'review_open') notify({ kind: 'err', title: `还有 ${r.body.count} 项人工复核未处理`, msg: '人脸/声音/背景必须由人逐项确认后才能批准' });
      else if (r.body.error === 'checklist') notify({ kind: 'err', title: '批准清单未逐项勾选', msg: `缺: ${r.body.missing.join(', ')}` });
      else notify({ kind: 'err', title: '无法批准', msg: r.body.message });
    } else { notify({ kind: 'ok', title: '片段已批准', msg: `批准依据哈希 ${r.body.approval.content_hash.slice(0, 12)}… 已冻结` }); reload(); }
  };
  const withdraw = async () => {
    await api.post(`/segments/${seg.id}/withdraw`, { reason: 'manual', actor });
    notify({ kind: 'warn', title: '片段已撤回，排队任务已取消' }); reload(); refreshJobs();
  };

  const openItems = items.filter((i) => i.status !== 'resolved');
  const lastPreview = seg.last_preview;

  return (
    <div>
      <div className="card">
        <div className="row">
          <label className="f" style={{ width: 260 }}>片段标题
            <input value={seg.title} onChange={(e) => setSeg({ ...seg, title: e.target.value })} /></label>
          <label className="f" style={{ width: 160 }}>类型
            <select value={seg.kind} onChange={(e) => setSeg({ ...seg, kind: e.target.value })}>
              {KIND.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select>
          </label>
          <button className="btn" onClick={save}>保存工作稿</button>
          {!seg.withdrawn && <button className="btn danger" onClick={withdraw}>撤回片段</button>}
        </div>
        {seg.withdrawn && <div className="finding" style={{ borderLeftColor: 'var(--err)' }}>已撤回（{seg.withdrawn_reason}，{fmt(seg.withdrawn_at)}），不能编辑/导出/发布。</div>}
        {seg.approval?.invalid_reason === 'media_license_revoked' && <div className="finding" style={{ borderLeftColor: 'var(--err)' }}>批准已因照片许可撤销而失效，需处理后重新批准。</div>}
      </div>

      <div className="grid2">
        <div className="card">
          <div className="section-title">编辑工作稿（四个文本面全部参与脱敏扫描）</div>
          <label className="f">正文 <textarea value={w.summary || ''} onChange={(e) => update({ summary: e.target.value })} /></label>
          <LineEditor label="字幕" rows={w.subtitles} atKey="at" onChange={(rows) => update({ subtitles: rows })} placeholder="联系电话 13800138000" />
          <LineEditor label="旁白脚本" rows={w.narration} atKey="at" onChange={(rows) => update({ narration: rows })} placeholder="我们在朝阳区幸福路…" />
          <LineEditor label="附带清单" rows={w.checklist} noAt onChange={(rows) => update({ checklist: rows })} placeholder="片尾放上微信号…" />

          <div className="section-title">引用媒体（机器盲区随引用进入复核队列）</div>
          {(w.media_refs || []).map((r, idx) => {
            const m = media.find((x) => x.id === r.media_id);
            return (
              <div key={idx} className="source-card">
                <b>{m?.caption || r.media_id}</b>{' '}
                {m?.license_status !== 'granted' && <span className="pill red">许可已撤销</span>}
                <div className="row" style={{ marginTop: 4 }}>
                  <label className="small"><input type="checkbox" checked={!!r.face} onChange={(e) => patchRef(w, update, idx, { face: e.target.checked })} /> 人脸</label>
                  <label className="small"><input type="checkbox" checked={!!r.voice} onChange={(e) => patchRef(w, update, idx, { voice: e.target.checked })} /> 声音</label>
                  <label className="small"><input type="checkbox" checked={!!r.background} onChange={(e) => patchRef(w, update, idx, { background: e.target.checked })} /> 背景</label>
                </div>
              </div>
            );
          })}
          <select onChange={(e) => {
            if (!e.target.value) return;
            const m = media.find((x) => x.id === e.target.value);
            update({
              media_refs: [...(w.media_refs || []), { media_id: e.target.value, face: !!m.face_suspected, voice: !!m.voice_suspected, background: !!m.background_suspected }],
              photo_meta: { ...(w.photo_meta || {}), [e.target.value]: media.find((x) => x.id === e.target.value) ? rawMetaFor(m) : {} },
            });
            e.target.value = '';
          }}>
            <option value="">+ 引用媒体…</option>
            {media.map((m) => <option key={m.id} value={m.id}>{m.caption || m.id}（{m.license_status === 'granted' ? '授权' : '已撤销'}）</option>)}
          </select>
          <div className="muted" style={{ marginTop: 4 }}>引用照片的 EXIF 元数据在任务中按白名单再剥离一次，只留尺寸/机型/时间。</div>

          <div className="section-title">来源（批准后会随公开稿展示来源与依据）</div>
          {(w.sources || []).map((s, i) => (
            <div key={i} className="source-card">
              {s.kind === 'event' ? `时间线事件 ${s.ref_id}：${events.find((e) => e.id === s.ref_id)?.note_public || ''}`
                : `叙事角色 ${s.ref_id}：${chars.find((c) => c.id === s.ref_id)?.display_name || ''}`}
            </div>
          ))}
          <div className="row">
            <select onChange={(e) => { const v = e.target.value; if (!v) return; update({ sources: [...(w.sources || []), { kind: 'event', ref_id: v }] }); e.target.value = ''; }}>
              <option value="">+ 时间线来源</option>
              {events.map((e) => <option key={e.id} value={e.id}>{e.at} {e.note_public.slice(0, 14)}</option>)}
            </select>
            <select onChange={(e) => { const v = e.target.value; if (!v) return; update({ sources: [...(w.sources || []), { kind: 'character', ref_id: v }] }); e.target.value = ''; }}>
              <option value="">+ 角色来源</option>
              {chars.map((c) => <option key={c.id} value={c.id}>{c.role} {c.display_name}</option>)}
            </select>
          </div>

          <hr />
          <label className="f"><span className="tag-internal" style={{ display: 'inline-block', padding: '0 6px', borderRadius: 4, width: 'fit-content' }}>内部 · 私密备注（永不导出）</span>
            <textarea value={privateNote} onChange={(e) => setPrivateNote(e.target.value)} placeholder="例：领养协调人私下说明，勿进入任何公开包" />
          </label>
          <button className="btn ghost" onClick={savePrivate}>仅存私密备注（内部）</button>
        </div>

        <div>
          <div className="card">
            <div className="section-title">异步媒体任务</div>
            <div className="row">
              <button className="btn" onClick={() => enqueueJob('sanitize')}>生成脱敏预览</button>
              <button className="btn blue" disabled={seg.approval?.status !== 'approved'} onClick={() => enqueueJob('export')}>排队导出包</button>
              <button className="btn ok" disabled={seg.approval?.status !== 'approved'} onClick={() => enqueueJob('publish')}>发布到公开站点</button>
            </div>
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>任务</th><th>状态</th><th>结果/错误</th><th></th></tr></thead>
              <tbody>
                {jobs.slice(0, 6).map((j) => (
                  <tr key={j.id}>
                    <td className="mono">{j.id}<div className="muted">{j.type}{j.duplicate_requests ? ` · 重复投稿×${j.duplicate_requests + 1}` : ''}</div></td>
                    <td><JobPill s={j.status} /></td>
                    <td className="small">{j.error ? <span style={{ color: 'var(--err)' }}>{j.error}</span>
                      : j.result ? <span className="mono">{typeof j.result === 'object' ? JSON.stringify(j.result).slice(0, 90) : j.result}</span> : '—'}
                      {j.cancel_reason && <div className="muted">取消原因：{j.cancel_reason}</div>}</td>
                    <td>{['queued', 'running'].includes(j.status) && <button className="btn ghost small" onClick={async () => { await api.post(`/jobs/${j.id}/cancel`, { actor }); refreshJobs(); }}>取消</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <div className="section-title">脱敏预览（白名单 + 文本检测组合策略）</div>
            {lastPreview ? (
              <>
                <pre className="preview-box">{JSON.stringify(lastPreview.preview, null, 2)}</pre>
                <h4>机器自动打码 {lastPreview.findings?.length || 0} 处</h4>
                {(lastPreview.findings || []).map((f, i) => (
                  <div key={i} className="finding">
                    <b>{typeName(f.type)}</b>（{f.surface}{f.key ? `·${f.key}` : ''}）：
                    <span className="mono"> {f.match || f.value_preview || ''}</span> → {f.masked_to || '剥离'}
                    {f.context && <div className="muted">上下文：…{f.context}…</div>}
                    {f.reason && <div className="muted">{f.reason}</div>}
                  </div>
                ))}
                <div className="flag-zone">
                  <b>机器无法可靠判断，必须人工复核：</b>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    <li><b>人脸</b>：画面肖像是否打码/裁切；</li>
                    <li><b>声音</b>：录音中自报的姓名电话、声纹是否需变声（转写可能漏字）；</li>
                    <li><b>背景信息</b>：门牌、快递单、聊天界面、校徽、地标等；</li>
                    <li>以及多字段<b>组合推断</b>（时间+地点+品种可能定位到人）。</li>
                  </ul>
                </div>
              </>
            ) : <div className="muted">先运行「生成脱敏预览」任务。提示：电话号码/地址检测覆盖正文、字幕、旁白脚本、附带清单和照片元数据。</div>}
          </div>

          <div className="card">
            <div className="section-title">人工复核队列（{openItems.length} 待处理）</div>
            {items.length === 0 && <div className="muted">暂无复核项。引用媒体并勾选人脸/声音/背景后，运行脱敏任务会生成复核项。</div>}
            {items.map((it) => (
              <div key={it.id} className="finding" style={{ borderLeftColor: it.status === 'resolved' ? 'var(--ok)' : 'var(--warn)' }}>
                <b>{typeName(it.type)}</b> · {it.surface} — {it.reason}
                {it.status === 'resolved'
                  ? <div className="muted">已处理：{it.resolution}（{it.resolved_by} {fmt(it.resolved_at)}）{it.note ? ` · ${it.note}` : ''}</div>
                  : <div className="row" style={{ marginTop: 5 }}>
                      {['masked', 'removed', 'confirmed_safe'].map((res) => (
                        <button key={res} className="btn ghost small" onClick={async () => {
                          await api.post(`/review-items/${it.id}/resolve`, { resolution: res, by: actor, note: '人工逐项确认' });
                          refreshItems();
                        }}>{res === 'masked' ? '已打码' : res === 'removed' ? '已移除' : '确认安全'}</button>
                      ))}
                    </div>}
              </div>
            ))}
          </div>

          <div className="card">
            <div className="section-title">批准（公开依据冻结）</div>
            {seg.approval?.status === 'approved' ? (
              <div>
                <span className="pill green">已批准</span> <span className="muted">由 {seg.approval.by} 于 {fmt(seg.approval.at)}</span>
                <div className="mono small" style={{ marginTop: 4 }}>内容哈希：{seg.approval.content_hash}</div>
                <div className="muted">依据：{seg.approval.basis}</div>
              </div>
            ) : (
              <>
                {[
                  ['fields_whitelist_confirmed', '已确认只用公开字段白名单（内部备注/联系方式/住址/芯片号不出现）'],
                  ['text_scan_confirmed', '已确认文本检测报告：正文/字幕/旁白脚本/附带清单/照片元数据中的电话、地址等均已打码'],
                  ['face_confirmed', '已逐帧人工确认人脸'],
                  ['voice_confirmed', '已人工听音复核声音（自报信息与声纹）'],
                  ['background_confirmed', '已人工看图确认背景信息（门牌/快递单/地标）'],
                ].map(([k, t]) => (
                  <label key={k} className="checkline"><input type="checkbox" checked={!!checklist[k]} onChange={(e) => setChecklist({ ...checklist, [k]: e.target.checked })} /> {t}</label>
                ))}
                <button className="btn ok" onClick={approve}>批准并冻结公开快照</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function LineEditor({ label, rows, atKey, noAt, onChange, placeholder }) {
  const setRow = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () => onChange([...rows, noAt ? { text: '' } : { [atKey]: '', text: '' }]);
  const del = (i) => onChange(rows.filter((_, j) => j !== i));
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="muted small">{label}</div>
      {rows.map((r, i) => (
        <div key={i} className="row" style={{ alignItems: 'flex-start' }}>
          {!noAt && <input style={{ width: 88 }} value={r[atKey] || ''} onChange={(e) => setRow(i, { [atKey]: e.target.value })} placeholder="00:00" />}
          <input value={r.text || ''} onChange={(e) => setRow(i, { text: e.target.value })} placeholder={placeholder} />
          <button className="btn ghost" onClick={() => del(i)}>×</button>
        </div>
      ))}
      <button className="btn ghost small" onClick={add}>+ {label}一行</button>
    </div>
  );
}

function patchRef(w, update, idx, patch) {
  update({ media_refs: w.media_refs.map((r, j) => (j === idx ? { ...r, ...patch } : r)) });
}
function rawMetaFor(m) {
  // 演示：服务端任务会再做一次剥离，这里把媒体登记时的安全元数据带入
  return { ...(m.meta || {}) };
}
const typeName = (t) => ({
  phone: '电话号码', email: '邮箱', id_card: '身份证号', bank_card: '银行卡号',
  address: '家庭住址', gps: 'GPS定位', wechat: '微信号', plate: '车牌',
  photo_meta: '照片元数据', face: '人脸（人工）', voice: '声音（人工）',
  voice_similarity: '声纹（人工）', background: '背景信息（人工）', context: '组合推断（人工）',
})[t] || t;
function JobPill({ s }) {
  const cls = { succeeded: 'green', failed: 'red', canceled: 'gray', queued: 'amber', running: 'blue' }[s] || 'gray';
  const t = { succeeded: '成功', failed: '失败', canceled: '已取消', queued: '排队中', running: '处理中' }[s] || s;
  return <span className={`pill ${cls}`}>{t}</span>;
}
