// 异步任务队列：publish_preview（脱敏预览）/ export_package（导出包）
// 运行时二次校验：快照之后被撤销许可/撤回的片段必须被排除，旧任务不得带病完成
const fs = require('fs');
const path = require('path');
const S = require('./sanitize');
const { audit } = require('./db');

const EXPORTS_DIR = path.join(__dirname, '..', 'exports');

function processNextTask(db) {
  const task = db.prepare(`SELECT * FROM tasks WHERE status='queued' ORDER BY id LIMIT 1`).get();
  if (!task) return null;
  db.prepare(`UPDATE tasks SET status='running' WHERE id=?`).run(task.id);
  try {
    const snapshot = JSON.parse(task.snapshot_json || '[]');
    const exclusions = [];
    const accepted = [];

    for (const frag of snapshot) {
      // 二次校验 1：片段本身是否已被撤回（带出撤回原因，便于审计）
      const cur = db.prepare('SELECT status, withdraw_reason FROM public_fragments WHERE id=?').get(frag.fragment_id);
      if (!cur || cur.status !== 'approved') {
        exclusions.push({ fragment_id: frag.fragment_id, reason: cur?.withdraw_reason || '片段已撤回或批准失效' });
        continue;
      }
      // 二次校验 2：媒体许可是否仍有效
      if (frag.source_type === 'media') {
        const m = db.prepare('SELECT license_status FROM media_assets WHERE id=?').get(frag.source_id);
        if (!m || m.license_status !== 'granted') {
          exclusions.push({ fragment_id: frag.fragment_id, reason: `媒体#${frag.source_id} 许可已撤销` });
          continue;
        }
      }
      accepted.push(frag);
    }

    if (task.type === 'publish_preview') {
      if (!accepted.length && snapshot.length) {
        db.prepare(`UPDATE tasks SET status='cancelled', cancel_reason='全部片段失效', exclusions_json=?, finished_at=datetime('now') WHERE id=?`)
          .run(JSON.stringify(exclusions), task.id);
        return { taskId: task.id, status: 'cancelled' };
      }
      const preview = accepted.map(f => ({ field: f.field, purpose: f.purpose, content: f.content }));
      const p = path.join(EXPORTS_DIR, `preview-${task.id}.json`);
      fs.writeFileSync(p, JSON.stringify({ animal_id: task.animal_id, preview }, null, 2));
      return finish(db, task, accepted, exclusions, p);
    }

    if (task.type === 'export_package') {
      // 组装导出包：公开片段 + 媒体元数据（剥离后）+ 附带清单（清单本身也过文本检测）
      const mediaIds = [...new Set(accepted.filter(f => f.source_type === 'media').map(f => f.source_id))];
      const mediaManifest = mediaIds.map(id => {
        const m = db.prepare('SELECT * FROM media_assets WHERE id=?').get(id);
        const { clean, stripped } = S.stripMetadata(m.exif_json);
        return { media_id: id, filename: m.filename, kind: m.kind, metadata: clean, metadata_stripped: stripped };
      });
      // 附带清单文本也要过脱敏检测
      const manifestText = mediaManifest.map(m => `${m.filename} (${m.kind})`).join('\n');
      const manifestFindings = S.scanText(manifestText, 'manifest');
      const pkg = {
        animal_id: task.animal_id,
        generated_at: new Date().toISOString(),
        fragments: accepted,
        media_manifest: mediaManifest,
        manifest_scan_findings: manifestFindings,
        // 私密备注（private_notes）与内部字段绝不进入导出包——结构上就不查询
      };
      const p = path.join(EXPORTS_DIR, `export-${task.id}.json`);
      fs.writeFileSync(p, JSON.stringify(pkg, null, 2));
      return finish(db, task, accepted, exclusions, p);
    }
    throw new Error('unknown task type ' + task.type);
  } catch (e) {
    db.prepare(`UPDATE tasks SET status='failed', cancel_reason=?, finished_at=datetime('now') WHERE id=?`)
      .run(String(e.message), task.id);
    return { taskId: task.id, status: 'failed', error: e.message };
  }
}

function finish(db, task, accepted, exclusions, resultPath) {
  const status = exclusions.length ? 'done_with_exclusions' : 'done';
  db.prepare(`UPDATE tasks SET status=?, exclusions_json=?, result_path=?, finished_at=datetime('now') WHERE id=?`)
    .run(status, JSON.stringify(exclusions), resultPath, task.id);
  audit(db, 'worker', 'task_finish', 'task', task.id, { status, accepted: accepted.length, excluded: exclusions.length });
  return { taskId: task.id, status, accepted: accepted.length, excluded: exclusions.length };
}

function drain(db) { const out = []; let r; while ((r = processNextTask(db))) out.push(r); return out; }

// 简易常驻 worker（服务端模式）
function startWorker(db, intervalMs = 500) {
  const t = setInterval(() => processNextTask(db), intervalMs);
  t.unref();
  return t;
}

module.exports = { processNextTask, drain, startWorker, EXPORTS_DIR };
