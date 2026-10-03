import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import Segments from './Segments.jsx';
import { fmt } from '../pages/Studio.jsx';

export default function AnimalDetail({ animal, actor, notify, refresh }) {
  const [tab, setTab] = useState('profile');
  return (
    <div className="card">
      <div className="row" style={{ gap: 4 }}>
        {[['profile', '档案字段'], ['timeline', '救助时间线'], ['chars', '叙事角色'], ['media', '媒体素材'], ['segments', '叙事片段']].map(([k, t]) => (
          <button key={k} className={`tab ${tab === k ? 'active' : ''}`} style={tab === k ? {} : { color: '#374151' }} onClick={() => setTab(k)}>{t}</button>
        ))}
      </div>
      <hr />
      {tab === 'profile' && <Profile animal={animal} actor={actor} notify={notify} refresh={refresh} />}
      {tab === 'timeline' && <Timeline animal={animal} actor={actor} notify={notify} />}
      {tab === 'chars' && <Chars animal={animal} actor={actor} notify={notify} />}
      {tab === 'media' && <Media animal={animal} actor={actor} notify={notify} />}
      {tab === 'segments' && <Segments animal={animal} actor={actor} notify={notify} />}
    </div>
  );
}

function Profile({ animal, actor, notify, refresh }) {
  const [f, setF] = useState(animal);
  useEffect(() => setF(animal), [animal.id, animal.version]);
  const set = (k, v) => setF({ ...f, [k]: v });
  const save = async () => {
    const fields = ['public_name', 'species', 'breed', 'age_estimate', 'sex', 'public_story',
      'internal_notes', 'real_name', 'chip_no', 'medical_detail', 'foster_address'];
    const body = Object.fromEntries(fields.filter((k) => f[k] !== animal[k]).map((k) => [k, f[k]]));
    const r = await api.put(`/animals/${animal.id}`, { ...body, actor }, animal.version);
    if (r.status === 409) notify({ kind: 'err', title: '版本冲突', msg: r.body.message });
    else { notify({ kind: 'ok', title: '档案已更新' }); refresh(); }
  };
  return (
    <div className="grid2">
      <div>
        <div className="section-title tag-public" style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 6 }}>公开字段（白名单内，可进入公开稿）</div>
        <label className="f">公开用名 <input value={f.public_name || ''} onChange={(e) => set('public_name', e.target.value)} /></label>
        <div className="grid2">
          <label className="f">物种 <input value={f.species || ''} onChange={(e) => set('species', e.target.value)} /></label>
          <label className="f">品种 <input value={f.breed || ''} onChange={(e) => set('breed', e.target.value)} /></label>
          <label className="f">估龄 <input value={f.age_estimate || ''} onChange={(e) => set('age_estimate', e.target.value)} /></label>
          <label className="f">性别/绝育 <input value={f.sex || ''} onChange={(e) => set('sex', e.target.value)} /></label>
        </div>
        <label className="f">公开故事 <textarea value={f.public_story || ''} onChange={(e) => set('public_story', e.target.value)} /></label>
      </div>
      <div>
        <div className="section-title tag-internal" style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 6 }}>内部记录（永不进公开稿/导出包）</div>
        <label className="f">内部备注（联系人/电话/住址）<textarea value={f.internal_notes || ''} onChange={(e) => set('internal_notes', e.target.value)} /></label>
        <label className="f">真实称呼 <input value={f.real_name || ''} onChange={(e) => set('real_name', e.target.value)} /></label>
        <label className="f">芯片号 <input value={f.chip_no || ''} onChange={(e) => set('chip_no', e.target.value)} /></label>
        <label className="f">医疗细节（内部） <textarea value={f.medical_detail || ''} onChange={(e) => set('medical_detail', e.target.value)} /></label>
        <label className="f">寄养家庭地址 <input value={f.foster_address || ''} onChange={(e) => set('foster_address', e.target.value)} /></label>
        <button className="btn" onClick={save}>保存字段修改</button>
      </div>
    </div>
  );
}

function Timeline({ animal, actor, notify }) {
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({ type: 'rescue', at: new Date().toISOString().slice(0, 10), note_public: '', note_internal: '' });
  const load = async () => (await api.get(`/animals/${animal.id}/events`)).ok && setRows((await api.get(`/animals/${animal.id}/events`)).body);
  useEffect(() => { load(); }, [animal.id]);
  const add = async () => {
    await api.post(`/animals/${animal.id}/events`, { ...f, actor });
    setF({ type: 'rescue', at: new Date().toISOString().slice(0, 10), note_public: '', note_internal: '' });
    load(); notify({ kind: 'ok', title: '时间线事件已记录' });
  };
  return (
    <div>
      <div className="grid2">
        {rows.map((e) => (
          <div key={e.id} className="source-card">
            <b>{e.at} · {typeLabel(e.type)}</b>
            <div className="tag-public" style={{ display: 'inline-block', padding: '0 6px', borderRadius: 4, marginTop: 4 }}>公开</div>
            <div>{e.note_public}</div>
            <div className="tag-internal" style={{ display: 'inline-block', padding: '0 6px', borderRadius: 4, marginTop: 6 }}>内部</div>
            <div className="muted">{e.note_internal || '—'}</div>
          </div>
        ))}
      </div>
      <hr />
      <h4>新增事件</h4>
      <div className="row">
        <label className="f" style={{ width: 150 }}>日期 <input type="date" value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} /></label>
        <label className="f" style={{ width: 160 }}>类型
          <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            {[['rescue', '救助'], ['medical', '医疗'], ['foster', '寄养'], ['adopt_apply', '领养申请'], ['adopt_done', '领养完成'], ['note', '备注']].map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        </label>
      </div>
      <label className="f">公开记录 <textarea value={f.note_public} onChange={(e) => setF({ ...f, note_public: e.target.value })} /></label>
      <label className="f">内部记录（电话/GPS 等写这里） <textarea value={f.note_internal} onChange={(e) => setF({ ...f, note_internal: e.target.value })} /></label>
      <button className="btn" onClick={add}>记录事件</button>
    </div>
  );
}
const typeLabel = (t) => ({ rescue: '救助', medical: '医疗', foster: '寄养', adopt_apply: '领养申请', adopt_done: '领养完成', note: '备注' })[t] || t;

function Chars({ animal, actor, notify }) {
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({ role: '救助人', display_name: '', bio_public: '', bio_internal: '' });
  const load = async () => setRows((await api.get(`/animals/${animal.id}/characters`)).body);
  useEffect(() => { load(); }, [animal.id]);
  const add = async () => { await api.post(`/animals/${animal.id}/characters`, { ...f, actor }); setF({ role: '救助人', display_name: '', bio_public: '', bio_internal: '' }); load(); notify({ kind: 'ok', title: '角色已添加' }); };
  return (
    <div>
      <div className="grid2">
        {rows.map((c) => (
          <div key={c.id} className="source-card">
            <b>{c.display_name}</b> <span className="pill gray">{c.role}</span>
            <div style={{ marginTop: 4 }}><span className="tag-public" style={{ padding: '0 6px', borderRadius: 4 }}>公开简介</span> {c.bio_public}</div>
            <div style={{ marginTop: 4 }}><span className="tag-internal" style={{ padding: '0 6px', borderRadius: 4 }}>内部资料</span> <span className="muted">{c.bio_internal || '—'}</span></div>
          </div>
        ))}
      </div>
      <hr /><h4>新增叙事角色</h4>
      <div className="grid2">
        <label className="f">角色定位 <input value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} /></label>
        <label className="f">公开显示名 <input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></label>
      </div>
      <label className="f">公开简介 <textarea value={f.bio_public} onChange={(e) => setF({ ...f, bio_public: e.target.value })} /></label>
      <label className="f">内部资料（真实姓名/微信等） <textarea value={f.bio_internal} onChange={(e) => setF({ ...f, bio_internal: e.target.value })} /></label>
      <button className="btn" onClick={add}>添加角色</button>
    </div>
  );
}

function Media({ animal, actor, notify }) {
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({ caption: '', metaText: '{\n  "Width": 4032,\n  "Height": 3024,\n  "GPSLatitude": "39 deg 54\' 31.32\\" N",\n  "Artist": "王秀兰",\n  "Software": "美图秀秀"\n}', background: true });
  const load = async () => setRows((await api.get(`/animals/${animal.id}/media`)).body);
  useEffect(() => { load(); }, [animal.id]);
  const upload = async () => {
    let meta = {};
    try { meta = JSON.parse(f.metaText || '{}'); } catch { notify({ kind: 'err', title: '元数据 JSON 解析失败' }); return; }
    const r = await api.post(`/animals/${animal.id}/media`, {
      caption: f.caption, meta, face_suspected: f.face, voice_suspected: f.voice, background_suspected: f.background, actor,
    });
    notify({ kind: 'ok', title: '媒体已登记', msg: `剥离元数据字段 ${r.body.meta_stripped?.length || 0} 项（GPS/作者/软件等）` });
    load();
  };
  const revoke = async (m) => {
    const r = await api.post(`/media/${m.id}/revoke`, { actor });
    notify({ kind: 'warn', title: '照片许可已撤销', msg: `影响片段 ${r.body.affected_segments.length} 个，取消排队任务 ${r.body.canceled_jobs} 个` });
    load();
  };
  return (
    <div>
      <table>
        <thead><tr><th>媒体</th><th>许可</th><th>入库元数据（已剥离）</th><th>机器盲区标记</th><th></th></tr></thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td><b>{m.caption || m.id}</b><div className="muted mono">{m.id}</div></td>
              <td>{m.license_status === 'granted'
                ? <span className="pill green">授权有效</span>
                : <span className="pill red">已撤销许可 {fmt(m.revoked_at)}</span>}</td>
              <td className="mono small">{JSON.stringify(m.meta)}</td>
              <td>
                {m.face_suspected && <span className="badge-machine">人脸?</span>}{' '}
                {m.voice_suspected && <span className="badge-machine">声音?</span>}{' '}
                {m.background_suspected && <span className="badge-machine">背景?</span>}
              </td>
              <td>{m.license_status === 'granted' && <button className="btn danger" onClick={() => revoke(m)}>撤销许可</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <hr /><h4>登记媒体（上传即剥离 EXIF 元数据）</h4>
      <label className="f">说明 <input value={f.caption} onChange={(e) => setF({ ...f, caption: e.target.value })} /></label>
      <label className="f">原始元数据 JSON（GPS/作者/软件 不会入库） <textarea style={{ minHeight: 110, fontFamily: 'monospace' }} value={f.metaText} onChange={(e) => setF({ ...f, metaText: e.target.value })} /></label>
      <div className="row">
        <label className="small"><input type="checkbox" checked={!!f.face} onChange={(e) => setF({ ...f, face: e.target.checked })} /> 疑似人脸</label>
        <label className="small"><input type="checkbox" checked={!!f.voice} onChange={(e) => setF({ ...f, voice: e.target.checked })} /> 疑似可辨识人声</label>
        <label className="small"><input type="checkbox" checked={!!f.background} onChange={(e) => setF({ ...f, background: e.target.checked })} /> 背景有门牌/快递单等</label>
        <button className="btn" onClick={upload}>登记并剥离元数据</button>
      </div>
    </div>
  );
}
