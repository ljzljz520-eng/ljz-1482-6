// 数据库层：内部记录与公开稿严格分表
const Database = require('better-sqlite3');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============ 内部记录区（永不直接对外） ============
CREATE TABLE IF NOT EXISTS animals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  alias         TEXT NOT NULL,            -- 对外用化名
  real_name     TEXT,                     -- 内部：真实呼名
  species       TEXT NOT NULL,
  breed         TEXT,
  status        TEXT NOT NULL DEFAULT 'rescue',  -- rescue/foster/adoptable/adopted/withdrawn
  rescuer_phone TEXT,                     -- 内部：救助人电话（敏感）
  rescue_address TEXT,                    -- 内部：救助详细地址（敏感）
  internal_notes TEXT,                    -- 内部备注
  version       INTEGER NOT NULL DEFAULT 1,  -- 乐观锁
  updated_by    TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS animal_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  animal_id INTEGER NOT NULL REFERENCES animals(id),
  from_status TEXT, to_status TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS timeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  animal_id INTEGER NOT NULL REFERENCES animals(id),
  event_date TEXT NOT NULL,
  title TEXT NOT NULL,
  body_internal TEXT,        -- 内部全文（可能含电话/地址）
  subtitle_text TEXT,        -- 字幕稿（也需脱敏）
  narration_script TEXT,     -- 旁白脚本（也需脱敏）
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  animal_id INTEGER NOT NULL REFERENCES animals(id),
  real_name TEXT,            -- 内部：真实姓名
  public_alias TEXT,         -- 公开：化名
  role TEXT NOT NULL,        -- 叙事角色：救助人/领养人/兽医...
  bio_internal TEXT,
  contact_phone TEXT,        -- 内部敏感
  consent_form TEXT          -- 授权书编号
);

CREATE TABLE IF NOT EXISTS media_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  animal_id INTEGER NOT NULL REFERENCES animals(id),
  kind TEXT NOT NULL,        -- photo/video/audio
  filename TEXT NOT NULL,
  caption_internal TEXT,
  license_status TEXT NOT NULL DEFAULT 'granted',  -- granted/revoked/pending
  exif_json TEXT,            -- 原始元数据（含GPS等，内部保存）
  review_status TEXT NOT NULL DEFAULT 'pending'    -- pending/approved/rejected（人脸声音等人工复核）
);

-- 私密备注：任何情况下不进入公开稿与导出包
CREATE TABLE IF NOT EXISTS private_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  animal_id INTEGER NOT NULL REFERENCES animals(id),
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ 公开稿区（白名单字段 + 脱敏后的副本） ============
CREATE TABLE IF NOT EXISTS public_fragments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  animal_id INTEGER NOT NULL REFERENCES animals(id),
  source_type TEXT NOT NULL,   -- profile/timeline/character/media
  source_id INTEGER NOT NULL,
  field TEXT NOT NULL,         -- 白名单字段名
  purpose TEXT NOT NULL DEFAULT 'story',  -- story/adoption_flyer(招领片)
  content TEXT NOT NULL,       -- 脱敏后的内容
  status TEXT NOT NULL DEFAULT 'pending_approval', -- pending_approval/needs_review/approved/withdrawn
  findings_json TEXT,          -- 机器检测命中项
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  withdrawn_at TEXT, withdraw_reason TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fragment_id INTEGER NOT NULL REFERENCES public_fragments(id),
  approver TEXT NOT NULL,
  basis TEXT NOT NULL,         -- 批准依据：whitelist_pass+scan_clean / manual_review:xxx / consent_form:xxx
  at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

-- 人工复核队列：机器无法可靠判断的项
CREATE TABLE IF NOT EXISTS review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  animal_id INTEGER NOT NULL,
  media_id INTEGER,
  category TEXT NOT NULL,      -- image_faces/audio_voice/photo_background/video_background
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- open/resolved
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ 异步任务与导出 ============
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,          -- publish_preview/export_package
  animal_id INTEGER NOT NULL REFERENCES animals(id),
  status TEXT NOT NULL DEFAULT 'queued', -- queued/running/done/done_with_exclusions/cancelled/failed
  idempotency_key TEXT UNIQUE, -- 幂等键：重复投稿去重
  snapshot_json TEXT,          -- 创建时快照（公开片段集合）
  exclusions_json TEXT,        -- 运行时被排除的项及原因
  cancel_reason TEXT,
  result_path TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS download_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  token TEXT NOT NULL UNIQUE,
  issued_to TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active/revoked
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT, revoke_reason TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL, action TEXT NOT NULL,
  entity TEXT NOT NULL, entity_id INTEGER,
  detail TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function createDb(file = ':memory:') {
  const db = new Database(file);
  db.exec(SCHEMA);
  return db;
}

function audit(db, actor, action, entity, entityId, detail) {
  db.prepare(`INSERT INTO audit_log(actor,action,entity,entity_id,detail) VALUES (?,?,?,?,?)`)
    .run(actor, action, entity, entityId, detail ? JSON.stringify(detail) : null);
}

module.exports = { createDb, audit };
