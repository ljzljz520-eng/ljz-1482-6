import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api.js';
import AnimalDetail from '../components/AnimalDetail.jsx';

const STATUS = [
  ['in_shelter', '在站待领养'],
  ['fostered', '寄养中'],
  ['adoption_pending', '领养审核中'],
  ['adopted', '领养完成'],
  ['lost', '走失'],
  ['deceased', '离世'],
];

export default function Studio({ actor, notify }) {
  const [animals, setAnimals] = useState([]);
  const [selId, setSelId] = useState(null);
  const [sel, setSel] = useState(null);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const r = await api.get('/animals');
    setAnimals(r.body);
    if (!selId && r.body[0]) setSelId(r.body[0].id);
  }, [selId]);

  const loadOne = useCallback(async (id) => {
    if (!id) return;
    const r = await api.get(`/animals/${id}`);
    if (r.ok) { setSel(r.body); setStatus(r.body.status); setConflict(null); }
  }, []);

  useEffect(() => { load(); }, []);
  useEffect(() => { loadOne(selId); }, [selId]);

  const saveStatus = async () => {
    setSaving(true);
    const r = await api.put(`/animals/${sel.id}`, { status, actor }, sel.version);
    setSaving(false);
    if (r.status === 409) {
      setConflict(r.body.current);
      notify({ kind: 'err', title: '保存冲突（两人同时改动物状态）', msg: `${r.body.message}。对方已改为「${label(r.body.current.status)}」v${r.body.current.version}，你仍在编辑 v${sel.version}` });
      return;
    }
    setSel(r.body.animal || r.body);
    setStatus((r.body.animal || r.body).status);
    load();
    if (r.body.adoption_cascade?.length) {
      notify({ kind: 'warn', title: '领养完成联动撤回', msg: `已自动撤回 ${r.body.adoption_cascade.length} 个招领片并取消其排队任务` });
    } else {
      notify({ kind: 'ok', title: '已保存', msg: `档案版本升至 v${(r.body.animal || r.body).version}` });
    }
  };

  const refresh = () => { load(); loadOne(selId); };
  const create = async (data) => {
    const r = await api.post('/animals', { ...data, actor });
    if (r.ok) { setSelId(r.body.id); setCreating(false); load(); notify({ kind: 'ok', title: '档案已建立' }); }
  };

  return (
    <div className="grid2" style={{ gridTemplateColumns: '260px 1fr' }}>
      <div>
        <div className="card">
          <h3>动物档案（内部库）</h3>
          {animals.map((a) => (
            <div key={a.id} className={`list-item ${selId === a.id ? 'active' : ''}`} onClick={() => setSelId(a.id)}>
              <b>{a.public_name}</b> <span className="muted">{a.species} · v{a.version}</span>
              <div><StatusPill s={a.status} /></div>
            </div>
          ))}
          <button className="btn ghost" style={{ width: '100%', marginTop: 6 }} onClick={() => setCreating(true)}>+ 新建档案</button>
        </div>
        {creating && <CreateCard onCancel={() => setCreating(false)} onCreate={create} />}
      </div>

      <div>
        {sel ? (
          <>
            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h3 style={{ margin: 0 }}>{sel.public_name}
                  <span className="muted"> {sel.id} · v{sel.version} · 更新于 {fmt(sel.updated_at)}</span>
                </h3>
                <button className="btn ghost" onClick={refresh}>刷新</button>
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <label className="f" style={{ width: 260 }}>
                  领养状态（持续变化）
                  <select value={status} onChange={(e) => setStatus(e.target.value)}>
                    {STATUS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                  </select>
                </label>
                <button className="btn" disabled={saving || status === sel.status} onClick={saveStatus}>
                  {saving ? '保存中…' : '保存状态（带版本号乐观锁）'}
                </button>
                {conflict && (
                  <button className="btn ghost" onClick={() => loadOne(sel.id)}>放弃我的改动并同步最新 v{conflict.version}</button>
                )}
              </div>
              {conflict && (
                <div className="flag-zone" style={{ marginTop: 8 }}>
                  <b>⚠ 并发冲突：</b>服务器当前版本 v{conflict.version}，状态「{label(conflict.status)}」（{fmt(conflict.updated_at)}）。
                  你的修改基于 v{sel.version}，已被拒绝，避免覆盖他人修改。
                </div>
              )}
              {sel.status === 'adopted' && (
                <div className="finding" style={{ borderLeftColor: 'var(--err)' }}>
                  该动物已<b>领养完成</b>：所有招领片已自动撤回、排队中的发布/导出任务已取消，旧包授权可单独撤销。
                </div>
              )}
            </div>
            <AnimalDetail animal={sel} actor={actor} notify={notify} refresh={refresh} />
          </>
        ) : <div className="card muted">请选择一个动物</div>}
      </div>
    </div>
  );
}

function CreateCard({ onCreate, onCancel }) {
  const [f, setF] = useState({ public_name: '', species: '猫' });
  return (
    <div className="card">
      <h3>新建动物档案</h3>
      <label className="f">公开用名 <input value={f.public_name} onChange={(e) => setF({ ...f, public_name: e.target.value })} /></label>
      <label className="f">物种 <input value={f.species} onChange={(e) => setF({ ...f, species: e.target.value })} /></label>
      <div className="row">
        <button className="btn" onClick={() => f.public_name && onCreate(f)}>创建</button>
        <button className="btn ghost" onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

export function StatusPill({ s }) {
  const cls = { adopted: 'green', in_shelter: 'gray', fostered: 'blue', adoption_pending: 'amber' }[s] || 'red';
  return <span className={`pill ${cls}`}>{label(s)}</span>;
}
export const label = (s) => Object.fromEntries(STATUS)[s] || s;
export const fmt = (s) => s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '';
