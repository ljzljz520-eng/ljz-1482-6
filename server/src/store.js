// 持久化层：内部记录库(internal.json)与公开稿库(public.json)物理分离。
// 公开接口永远只能读取 public.json；internal.json 含内部备注、联系方式等敏感内容。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const INTERNAL_FILE = path.join(DATA_DIR, 'internal.json');
const PUBLIC_FILE = path.join(DATA_DIR, 'public.json');

export const emptyInternal = () => ({
  seq: 1,
  animals: [],
  events: [],
  characters: [],
  media: [],
  segments: [],
  review_items: [],
  jobs: [],
  packages: [],
  grants: [],
  audit: [],
});
export const emptyPublic = () => ({ published: [] });

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback();
  }
}
function atomicWrite(file, obj) {
  ensureDir();
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

let internal = readJson(INTERNAL_FILE, emptyInternal);
let pub = readJson(PUBLIC_FILE, emptyPublic);

export function getInternal() { return internal; }
export function getPublic() { return pub; }
export function saveInternal() { atomicWrite(INTERNAL_FILE, internal); }
export function savePublic() { atomicWrite(PUBLIC_FILE, pub); }
export function resetInternal(data) {
  internal = data || emptyInternal();
  saveInternal();
}
export function resetPublic(data) {
  pub = data || emptyPublic();
  savePublic();
}
export const newId = (prefix) => {
  const id = `${prefix}_${internal.seq++}`;
  return id;
};
export const now = () => new Date().toISOString();
export const token = (n = 24) => crypto.randomBytes(n).toString('hex');

export function audit(action, detail = {}, actor = 'system') {
  internal.audit.unshift({
    id: newId('audit'), at: now(), actor, action, detail,
  });
  saveInternal();
}

// 集合查询小工具
export const find = (col, id) => internal[col].find((x) => x.id === id) || null;
export const mustFind = (col, id) => {
  const row = find(col, id);
  if (!row) {
    const e = new Error(`${col} ${id} 不存在`);
    e.status = 404;
    throw e;
  }
  return row;
};
