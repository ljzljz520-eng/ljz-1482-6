import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { fmt } from './Studio.jsx';

export default function PublicSite({ notify }) {
  const [stories, setStories] = useState([]);
  const [sel, setSel] = useState(null);
  const [gone, setGone] = useState(null);
  const load = async () => setStories((await api.get('/public/stories')).body);
  useEffect(() => { load(); }, []);
  const open = async (p) => {
    setGone(null);
    const r = await api.get(`/public/stories/${p.public_id}`);
    if (r.status === 410) setGone(r.body); else setSel(r.body);
  };
  return (
    <div className="grid2" style={{ gridTemplateColumns: '280px 1fr' }}>
      <div className="card">
        <h3>对外公开页面（只读公开库）</h3>
        {stories.length === 0 && <div className="muted">尚无已发布且未撤回的公开稿。</div>}
        {stories.map((p) => (
          <div key={p.public_id} className="list-item" onClick={() => open(p)}>
            <b>{p.title}</b>
            <div><span className="pill blue">{p.kind === 'adoption_flyer' ? '招领片' : '故事'}</span></div>
            <div className="muted">{p.animal?.public_name} · {fmt(p.published_at)}</div>
          </div>
        ))}
        <button className="btn ghost" style={{ width: '100%' }} onClick={load}>刷新</button>
      </div>
      <div>
        {gone && (
          <div className="card" style={{ borderColor: 'var(--err)' }}>
            <h3>该公开稿已撤回（HTTP 410 Gone）</h3>
            <p>撤回原因：<b>{gone.reason === 'animal_adopted' ? '动物已领养完成' : gone.reason === 'media_license_revoked' ? '照片许可撤销' : gone.reason}</b>；{fmt(gone.at)}</p>
            <p className="muted">公开库不再提供内容；已经下载过旧包的外部副本无法由本系统删除，只能撤销其后续下载授权。</p>
          </div>
        )}
        {sel && <PublicStory s={sel} />}
        {!sel && !gone && <div className="card muted">点击左侧查看公开片段。每个片段下方都会展示来源记录与批准依据。</div>}
      </div>
    </div>
  );
}

function PublicStory({ s }) {
  return (
    <div className="story-card">
      <h2>{s.title}</h2>
      <div className="muted">{s.kind === 'adoption_flyer' ? '招领片' : '救助故事'} · 主角 {s.animal?.public_name}（{s.animal?.species}/{s.animal?.breed}）</div>
      <p>{s.content?.summary}</p>

      {s.content?.subtitles?.length > 0 && <>
        <h4>字幕</h4>
        {s.content.subtitles.map((x, i) => <div key={i} className="small"><span className="muted mono">{x.at}</span> {x.text}</div>)}
      </>}
      {s.content?.narration?.length > 0 && <>
        <h4>旁白</h4>
        {s.content.narration.map((x, i) => <div key={i} className="small"><span className="muted mono">{x.at}</span> {x.text}</div>)}
      </>}
      {s.content?.checklist?.length > 0 && <>
        <h4>清单</h4>
        <ul className="small">{s.content.checklist.map((x, i) => <li key={i}>{x.text}</li>)}</ul>
      </>}

      <div className="provenance">
        <h4 style={{ marginTop: 0 }}>📎 来源记录（内部系统引用，已按白名单投影）</h4>
        {(s.sources || []).map((src, i) => (
          <div key={i} className="source-card">
            {src.kind === 'event'
              ? <><b>救助时间线</b>（{src.record?.at}）：{src.record?.note_public} <div className="muted mono">来源ID {src.ref_id} · 类型 {src.record?.type}</div></>
              : <><b>叙事角色 · {src.record?.role}</b>：{src.record?.display_name} — {src.record?.bio_public} <div className="muted mono">来源ID {src.ref_id}</div></>}
          </div>
        ))}
        <h4>✅ 批准依据</h4>
        <div className="small">
          批准人：<b>{s.approval?.by}</b> · 时间：{fmt(s.approval?.at)}
          <div>依据：{s.approval?.basis}</div>
          <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
            <li>公开字段白名单已核对：{s.approval?.checklist?.fields_whitelist_confirmed ? '是' : '否'}</li>
            <li>四个文本面（正文/字幕/旁白/清单）+ 照片元数据检测报告已核对：{s.approval?.checklist?.text_scan_confirmed ? '是' : '否'}</li>
            <li>人脸 / 声音 / 背景 已人工复核：{s.approval?.checklist?.face_confirmed ? '✓' : '✘'} / {s.approval?.checklist?.voice_confirmed ? '✓' : '✘'} / {s.approval?.checklist?.background_confirmed ? '✓' : '✘'}</li>
          </ul>
        </div>
        <div className="muted mono">内容哈希：{s.approval_hash || '（见导出包）'} · 发布于 {fmt(s.published_at)}</div>
        <div className="muted" style={{ marginTop: 4 }}>{s.notice}</div>
      </div>
    </div>
  );
}
