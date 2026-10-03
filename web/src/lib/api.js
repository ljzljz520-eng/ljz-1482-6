const j = (r) => r.json().then((b) => ({ ok: r.ok, status: r.status, body: b }));
export const api = {
  get: (u) => fetch(`/api${u}`).then(j),
  post: (u, body) => fetch(`/api${u}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  }).then(j),
  put: (u, body, version) => fetch(`/api${u}`, {
    method: 'PUT', headers: { 'content-type': 'application/json', ...(version != null ? { 'If-Match': String(version) } : {}) },
    body: JSON.stringify(body || {}),
  }).then(j),
};
