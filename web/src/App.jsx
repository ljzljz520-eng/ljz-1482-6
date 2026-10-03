import React, { useEffect, useState } from 'react';
import { api } from './lib/api.js';
import Studio from './pages/Studio.jsx';
import PublicSite from './pages/PublicSite.jsx';
import Packages from './pages/Packages.jsx';
import Acceptance from './pages/Acceptance.jsx';
import AuditLog from './pages/AuditLog.jsx';

const TABS = [
  ['studio', '创作台（内部）'],
  ['public', '公开站点'],
  ['packages', '导出与下载授权'],
  ['acceptance', '验收场景'],
  ['audit', '审计日志'],
];

export default function App() {
  const [tab, setTab] = useState('studio');
  const [toast, setToast] = useState(null);
  const [actor, setActor] = useState('编辑小李');

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">🐾 宠物救助故事创作台</div>
        <nav>
          {TABS.map(([k, label]) => (
            <button key={k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>{label}</button>
          ))}
        </nav>
        <label className="actor">操作者
          <input value={actor} onChange={(e) => setActor(e.target.value)} />
        </label>
      </header>

      <main>
        {tab === 'studio' && <Studio actor={actor} notify={setToast} />}
        {tab === 'public' && <PublicSite notify={setToast} />}
        {tab === 'packages' && <Packages actor={actor} notify={setToast} />}
        {tab === 'acceptance' && <Acceptance actor={actor} notify={setToast} />}
        {tab === 'audit' && <AuditLog />}
      </main>

      {toast && (
        <div className={`toast ${toast.kind || 'info'}`}>
          <b>{toast.title}</b>
          <div>{toast.msg}</div>
        </div>
      )}
    </div>
  );
}

export { api };
