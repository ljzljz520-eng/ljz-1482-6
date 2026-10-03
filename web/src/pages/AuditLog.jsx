import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { fmt } from './Studio.jsx';

export default function AuditLog() {
  const [rows, setRows] = useState([]);
  useEffect(() => { api.get('/audit').then((r) => setRows(r.body)); }, []);
  return (
    <div className="card">
      <h3>审计日志（最近 200 条）</h3>
      <table>
        <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>详情</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="small mono">{fmt(r.at)}</td>
              <td className="small">{r.actor}</td>
              <td><span className="pill gray">{r.action}</span></td>
              <td className="mono small" style={{ wordBreak: 'break-all' }}>{JSON.stringify(r.detail)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
