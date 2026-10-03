import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { fmt } from './Studio.jsx';

export default function Packages({ actor, notify }) {
  const [pkgs, setPkgs] = useState([]);
  const [grants, setGrants] = useState([]);
  const [dl, setDl] = useState(null);

  const load = async () => {
    setPkgs((await api.get('/packages')).body);
    setGrants((await api.get('/grants')).body);
  };
  useEffect(() => { load(); }, []);

  const grant = async (p, grantee) => {
    const r = await api.post(`/packages/${p.id}/grant`, { grantee: grantee || '外部领养协调员', actor });
    notify({ kind: 'ok', title: '下载授权已签发', msg: '请通过安全渠道把链接发给被授权人' });
    load();
  };
  const revoke = async (g) => {
    await api.post(`/grants/${g.id}/revoke`, { actor });
    notify({ kind: 'warn', title: '旧包下载授权已撤销', msg: '之后该链接返回 403；但对方在撤销前已下载到本地的副本，本系统无法删除（不应声称已删除）。' });
    load();
  };
  const testDownload = async (g) => {
    const r = await fetch(`/api/external/download/${g.token}`);
    if (r.ok) setDl({ ok: true, body: await r.json(), token: g.token });
    else setDl({ ok: false, status: r.status, body: await r.json() });
  };
  return (
    <div>
      <div className="card">
        <h3>导出包（只含批准时冻结的公开快照）</h3>
        {pkgs.length === 0 && <div className="muted">还没有导出包。到创作台批准片段后排队「导出包」任务。</div>}
        <table>
          <thead><tr><th>包</th><th>片段</th><th>生成时间</th><th>内容哈希</th><th>授权</th></tr></thead>
          <tbody>
            {pkgs.map((p) => {
              const gs = grants.filter((g) => g.package_id === p.id);
              return (
                <tr key={p.id}>
                  <td className="mono">{p.id}</td>
                  <td>{p.segment_id}</td>
                  <td>{fmt(p.created_at)}</td>
                  <td className="mono small">{p.content_hash.slice(0, 16)}…</td>
                  <td>
                    {gs.map((g) => (
                      <div key={g.id} style={{ marginBottom: 6 }}>
                        <span className={`pill ${g.active ? 'green' : 'red'}`}>{g.active ? '授权有效' : '已撤销'}</span>
                        <span className="small"> {g.grantee} · {fmt(g.created_at)}</span>
                        <div className="small"><button className="btn ghost" onClick={() => testDownload(g)}>试下载</button>{' '}
                          {g.active && <button className="btn danger" onClick={() => revoke(g)}>撤销授权</button>}</div>
                        {g.active && <div className="codeurl mono small">{location.origin}/api/external/download/{g.token}</div>}
                      </div>
                    ))}
                    <button className="btn ghost" onClick={() => grant(p, prompt('授予给谁？', '外部领养协调员'))}>签发下载授权</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {dl && (
        <div className="card">
          <h3>外部下载测试结果</h3>
          {dl.ok
            ? <>
                <span className="pill green">200 授权有效，可下载</span>
                <pre className="preview-box">{JSON.stringify(dl.body, null, 2)}</pre>
                <div className="muted">检查：快照中不应出现 internal_notes / private_note / real_name / chip_no / foster_address 等字段。</div>
              </>
            : <><span className="pill red">{dl.status} 授权已撤销或过期</span><pre className="preview-box">{JSON.stringify(dl.body, null, 2)}</pre></>}
        </div>
      )}

      <div className="card">
        <h3>边界说明</h3>
        <ul className="small">
          <li>撤销授权只能阻止<b>后续</b>下载，外部下载者在撤销前已保存的副本无法由平台删除——页面与话术都不得声称"已删除对方持有的副本"。</li>
          <li>动物领养完成后，招领片自动撤回；已生成的旧包文件仍在，但可以、且应当逐包撤销下载授权。</li>
        </ul>
      </div>
    </div>
  );
}
