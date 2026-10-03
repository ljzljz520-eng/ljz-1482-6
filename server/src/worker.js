// 异步任务队列：脱敏预览(sanitize) / 导出(export) / 发布(publish)
// 关键原则：
//  - 任务在"真正执行那一刻"重新读取最新数据并校验，而非信任入队时的快照状态；
//  - 动物被领养 -> 招领片(kind=adoption_flyer)自动撤回、排队中任务取消；
//  - 照片许可撤销 -> 引用该照片的排队任务取消/片段失效；
//  - 导出包只包含已批准的公开快照；入队后补入的私密备注不在快照内，永不外泄；
//  - 重复提交返回同一任务（幂等去重）。
import crypto from 'node:crypto';
import { getInternal, getPublic, saveInternal, savePublic, newId, now, audit } from './store.js';
import { sanitizeWorking, ANIMAL_PUBLIC_FIELDS, EVENT_PUBLIC_FIELDS, CHARACTER_PUBLIC_FIELDS } from './redact.js';

let timer = null;
let onTick = null;

export function startWorker(tickMs = Number(process.env.JOB_TICK_MS || 1200)) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => processOne().catch(() => {}), tickMs);
}
export function stopWorker() { if (timer) clearInterval(timer); timer = null; }

export function listJobs(segId) {
  const db = getInternal();
  return segId ? db.jobs.filter((j) => j.segment_id === segId) : db.jobs;
}

// 入队（带幂等去重：同一片段+同类型+同有效载荷哈希 的非终态任务只保留一个）
export function enqueue({ type, segment_id, payload = {}, actor = 'user' }) {
  const db = getInternal();
  const seg = db.segments.find((s) => s.id === segment_id);
  if (!seg) { const e = new Error('片段不存在'); e.status = 404; throw e; }
  const pHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const dup = db.jobs.find((j) => j.segment_id === segment_id && j.type === type
    && j.payload_hash === pHash && ['queued', 'running'].includes(j.status));
  if (dup) {
    dup.duplicate_requests = (dup.duplicate_requests || 0) + 1;
    dup.duplicate_of = dup.id;
    saveInternal();
    audit('job.dedup', { job_id: dup.id, type, segment_id }, actor);
    return { job: dup, duplicated: true };
  }
  const job = {
    id: newId('job'), type, segment_id, payload, payload_hash: pHash,
    status: 'queued', result: null, error: null,
    created_at: now(), started_at: null, finished_at: null,
    cancel_requested: false, duplicate_requests: 0,
  };
  db.jobs.unshift(job);
  saveInternal();
  audit('job.enqueue', { job_id: job.id, type, segment_id }, actor);
  // 测试/演示模式：立即同步跑完
  if (process.env.JOB_SYNC === '1') processOne();
  return { job, duplicated: false };
}

export function requestCancel(jobId, actor = 'user') {
  const db = getInternal();
  const job = db.jobs.find((j) => j.id === jobId);
  if (!job) { const e = new Error('任务不存在'); e.status = 404; throw e; }
  if (job.status === 'queued') {
    job.status = 'canceled'; job.finished_at = now();
  } else if (job.status === 'running') {
    job.cancel_requested = true;
  } else {
    const e = new Error('任务已结束，无法取消'); e.status = 409; throw e;
  }
  saveInternal();
  audit('job.cancel', { job_id: jobId }, actor);
  return job;
}

// 状态变化联动：领养完成 / 许可撤销 时，取消还在排队的相关任务
export function cancelQueuedForSegment(segmentId, reason, actor = 'system') {
  const db = getInternal();
  let n = 0;
  for (const j of db.jobs) {
    if (j.segment_id === segmentId && j.status === 'queued') {
      j.status = 'canceled'; j.finished_at = now(); j.cancel_reason = reason; n++;
    }
  }
  if (n) { saveInternal(); audit('job.auto_cancel', { segment_id: segmentId, reason, count: n }, actor); }
  return n;
}
export function cancelQueuedForMedia(mediaId, reason, actor = 'system') {
  const db = getInternal();
  let n = 0;
  const segIds = new Set();
  for (const j of db.jobs) {
    if (j.status !== 'queued') continue;
    const seg = db.segments.find((s) => s.id === j.segment_id);
    if (seg?.working?.media_refs?.some((m) => m.media_id === mediaId)) {
      j.status = 'canceled'; j.finished_at = now(); j.cancel_reason = reason; n++;
      segIds.add(j.segment_id);
    }
  }
  if (n) { saveInternal(); audit('job.auto_cancel', { media_id: mediaId, reason, count: n, segments: [...segIds] }, actor); }
  return n;
}

function processOne() {
  const db = getInternal();
  const job = db.jobs.find((j) => j.status === 'queued');
  if (!job) return Promise.resolve();
  job.status = 'running'; job.started_at = now();
  saveInternal();
  return new Promise((resolve) => {
    const work = () => {
      try {
        if (job.cancel_requested) {
          job.status = 'canceled'; job.finished_at = now(); saveInternal();
          audit('job.canceled', { job_id: job.id });
          return resolve();
        }
        const seg = db.segments.find((s) => s.id === job.segment_id);
        const animal = seg && db.animals.find((a) => a.id === seg.animal_id);
        if (!seg || !animal) {
          return finishFail(job, '片段或动物档案已不存在');
        }
        if (job.type === 'sanitize') runSanitize(job, seg, animal);
        else if (job.type === 'export') runExport(job, seg, animal);
        else if (job.type === 'publish') runPublish(job, seg, animal);
      } catch (e) {
        finishFail(job, e.message);
      } finally {
        saveInternal(); resolve();
      }
    };
    setTimeout(work, Number(process.env.JOB_DELAY_MS || 500));
  });
}

function finishFail(job, msg) {
  job.status = 'failed'; job.error = msg; job.finished_at = now();
  audit('job.failed', { job_id: job.id, error: msg });
}

// 运行前通用闸门：许可、领养状态、片段有效性、（导出/发布）批准与复核
function gate(seg, animal, { needApproved }) {
  const db = getInternal();
  if (seg.withdrawn) throw new Error('片段已撤回');
  const revoked = (seg.working?.media_refs || []).filter((r) => {
    const m = db.media.find((x) => x.id === r.media_id);
    return m && m.license_status !== 'granted';
  });
  if (revoked.length) throw new Error(`引用照片许可已撤销: ${revoked.map((r) => r.media_id).join(', ')}`);
  if (needApproved) {
    if (animal.status === 'adopted' && seg.kind === 'adoption_flyer') {
      throw new Error('动物已完成领养，招领片必须撤回，不能再导出/发布');
    }
    if (seg.approval?.status !== 'approved') throw new Error('片段尚未获得批准');
    const open = db.review_items.filter((r) => r.segment_id === seg.id && r.status !== 'resolved');
    if (open.length) throw new Error(`还有 ${open.length} 项人工复核未处理（人脸/声音/背景等）`);
    const aHash = contentHash(seg.approved_preview);
    if (aHash !== seg.approval.content_hash) throw new Error('批准依据与当前内容不一致，需重新批准');
  }
}

function runSanitize(job, seg) {
  // 脱敏不要求已批准；但许可撤销仍要拦截
  gate(seg, getInternal().animals.find((a) => a.id === seg.animal_id), { needApproved: false });
  const result = sanitizeWorking(seg.working);
  job.result = {
    preview: result.preview,
    findings_count: result.findings.length,
    findings: result.findings,
    review_items: result.review_items,
    machine_limitations: result.machine_limitations,
    strategy: result.strategy,
  };
  seg.last_preview = {
    at: now(), job_id: job.id, preview: result.preview,
    findings: result.findings,
  };
  // 同步复核项：同指纹已存在则不重复建
  for (const ri of result.review_items) {
    const fp = `${ri.type}|${ri.surface}|${ri.reason}`;
    if (!db_reviewExists(seg.id, fp)) {
      getInternal().review_items.unshift({
        id: newId('rev'), segment_id: seg.id, ...ri,
        fingerprint: fp, created_at: now(), resolved_at: null, resolution: null,
      });
    }
  }
  job.status = 'succeeded'; job.finished_at = now();
  audit('job.sanitize_ok', { job_id: job.id, segment_id: seg.id, findings: result.findings.length });
}

function db_reviewExists(segId, fp) {
  return getInternal().review_items.some((r) => r.segment_id === segId && r.fingerprint === fp);
}

function contentHash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

// 白名单投影（导出/发布共用）
function projectAnimal(a) {
  const o = {};
  for (const f of ANIMAL_PUBLIC_FIELDS) o[f] = a[f] ?? null;
  return o;
}
function projectSources(seg) {
  const db = getInternal();
  return (seg.working?.sources || []).map((src) => {
    if (src.kind === 'event') {
      const ev = db.events.find((e) => e.id === src.ref_id);
      const o = ev ? Object.fromEntries(EVENT_PUBLIC_FIELDS.map((f) => [f, ev[f] ?? null])) : null;
      return { ...src, record: o };
    }
    if (src.kind === 'character') {
      const ch = db.characters.find((c) => c.id === src.ref_id);
      const o = ch ? Object.fromEntries(CHARACTER_PUBLIC_FIELDS.map((f) => [f, ch[f] ?? null])) : null;
      return { ...src, record: o };
    }
    return { ...src };
  });
}

function publicSnapshot(seg, animal) {
  // 关键：导出内容来自批准时冻结的 approved_preview，不读当前 working（私密备注后来补入也进不来）
  return {
    segment_id: seg.id,
    kind: seg.kind,
    title: seg.title,
    animal: projectAnimal(animal),
    content: seg.approved_preview,
    sources: projectSources(seg),
    approval: {
      at: seg.approval.at, by: seg.approval.by, basis: seg.approval.basis,
      checklist: seg.approval.checklist, content_hash: seg.approval.content_hash,
    },
    approval_hash: seg.approval.content_hash,
    generated_at: now(),
    notice: '本公开稿基于字段白名单+文本检测组合脱敏；人脸/声音/背景经人工复核确认。',
  };
}

function runExport(job, seg, animal) {
  gate(seg, animal, { needApproved: true });
  const snapshot = publicSnapshot(seg, animal);
  const pkg = {
    id: newId('pkg'), job_id: job.id, segment_id: seg.id, animal_id: animal.id,
    created_at: now(),
    content_hash: contentHash(snapshot),
    snapshot,
  };
  getInternal().packages.unshift(pkg);
  job.result = { package_id: pkg.id, content_hash: pkg.content_hash };
  job.status = 'succeeded'; job.finished_at = now();
  audit('export.created', { package_id: pkg.id, segment_id: seg.id, job_id: job.id });
}

function runPublish(job, seg, animal) {
  gate(seg, animal, { needApproved: true });
  const db = getInternal();
  const snapshot = publicSnapshot(seg, animal);
  snapshot.package_content_hash = contentHash(snapshot);
  const existing = getPublic().published.find((p) => p.segment_id === seg.id);
  if (existing) {
    Object.assign(existing, snapshot, { published_at: now(), withdrawn: false });
  } else {
    getPublic().published.push({
      public_id: newId('pub'), segment_id: seg.id, ...snapshot,
      published_at: now(), withdrawn: false, withdrawn_reason: null,
    });
  }
  seg.published_at = now();
  job.result = { published: true, segment_id: seg.id };
  job.status = 'succeeded'; job.finished_at = now();
  savePublic();
  audit('publish.ok', { segment_id: seg.id, job_id: job.id });
}


export function processOnceForTest() { return processOne(); }
export async function drain(max = 50) {
  for (let i = 0; i < max; i++) {
    const db = getInternal();
    if (!db.jobs.some((j) => j.status === 'queued')) return;
    await processOne();
  }
}
