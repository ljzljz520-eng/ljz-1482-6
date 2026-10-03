// 脱敏引擎：组合策略
//  策略1 公开字段白名单：只从明确允许的字段取值，内部备注/联系方式/家庭住址等永不进入公开稿。
//  策略2 文本检测脱敏：对白名单字段内的自由文本（含字幕、旁白脚本、附带清单、照片元数据）
//         用规则模式二次扫描，命中即打码，防止白名单字段中夹带 PII。
//  组合：白名单决定"哪些字段可以出去"，文本检测决定"出去的字段里哪些片段必须被遮挡"，
//        两者都不能单独保证安全，故必须串联使用。

// ---- 策略1：各实体的公开字段白名单 ----
export const ANIMAL_PUBLIC_FIELDS = ['id', 'public_name', 'species', 'breed', 'age_estimate', 'sex', 'status', 'public_story'];
export const EVENT_PUBLIC_FIELDS = ['id', 'animal_id', 'at', 'type', 'note_public'];
export const CHARACTER_PUBLIC_FIELDS = ['id', 'role', 'display_name', 'bio_public'];
export const MEDIA_PUBLIC_FIELDS = ['id', 'animal_id', 'kind', 'caption', 'preview_url', 'license_status'];
// 照片元数据白名单（EXIF 中仅这些技术字段可保留，其余全部剥离）
export const PHOTO_META_WHITELIST = ['Width', 'Height', 'Make', 'Model', 'DateTime', 'Orientation'];

// ---- 策略2：可由机器可靠识别并自动打码的模式 ----
// phone: 手机号 / 座机 / 400
const RE_MOBILE = /(?<!\d)(?:\+?86[-\s]?)?1[3-9](?:[-\s]?\d){9}(?!\d)/g;
const RE_LANDLINE = /(?<!\d)(?:0\d{2,3}[-\s]?)?\d{7,8}(?:[-\s]?\d{2,5})?(?!\d)/g;
const RE_400 = /(?<!\d)400[-\s]?\d{3}[-\s]?\d{4}(?!\d)/g;
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 身份证 18 位
const RE_IDCARD = /(?<!\d)\d{17}[\dXx](?!\d)/g;
// 银行卡 16-19 位连续数字
const RE_BANKCARD = /(?<!\d)\d{16,19}(?!\d)/g;
// 家庭住址：xx省/市/区 + 道路 + 门牌号 / 小区+楼栋单元房号
const RE_ADDR_ROAD = /[一-龥]{2,8}(省|市|区|县|镇)[一-龥0-9A-Za-z]{0,18}?(路|街|道|巷|弄|号|栋|幢|单元|室)/g;
const RE_ADDR_COMMUNITY = /[一-龥A-Za-z0-9]{2,20}?(小区|花园|公寓|新村|家园|苑|府|公馆)(?:[0-9]{1,3}(?:栋|幢|号楼)?)?(?:[一-龥0-9]{0,4}单元)?(?:[0-9]{2,4}室)?/g;
const RE_ROOM = /(?<![一-龥A-Za-z0-9])\d{1,2}(栋|幢|号楼)\d{1,3}单元\d{2,4}室/g;
// GPS
const RE_GPS = /[-+]?\d{1,3}\.\d{4,}\s*[,，]\s*[-+]?\d{1,3}\.\d{4,}/g;
// 微信号
const RE_WECHAT = /(?:微信|wechat|vx|v信)[号:：\s]*[A-Za-z][-_A-Za-z0-9]{5,19}/gi;
// 车牌号（高误报，仅打码常见格式）
const RE_PLATE = /(?<![A-Za-z0-9])[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领][A-Z][A-Z0-9]{4,6}(?![A-Za-z0-9])/g;

const PATTERNS = [
  ['phone', RE_MOBILE, '***电话***'],
  ['phone', RE_400, '***电话***'],
  ['phone', RE_LANDLINE, '***电话***'],
  ['email', RE_EMAIL, '***邮箱***'],
  ['id_card', RE_IDCARD, '***身份证号***'],
  ['bank_card', RE_BANKCARD, '***银行卡号***'],
  ['address', RE_ADDR_ROAD, '***家庭住址***'],
  ['address', RE_ADDR_COMMUNITY, '***家庭住址***'],
  ['address', RE_ROOM, '***家庭住址***'],
  ['gps', RE_GPS, '***定位***'],
  ['wechat', RE_WECHAT, '***微信号***'],
  ['plate', RE_PLATE, '***车牌***'],
];

export function detectText(text) {
  const findings = [];
  if (text == null) return { masked: text, findings };
  let masked = String(text);
  for (const [type, re, label] of PATTERNS) {
    masked = masked.replace(re, (m, offset, src) => {
      findings.push({ type, match: m, surface: 'text', masked_to: label });
      return label;
    });
  }
  return { masked, findings };
}

// ---- 照片元数据：只保留白名单字段，剥离 GPS/作者/版权/编辑历史等 ----
export function sanitizePhotoMeta(meta = {}) {
  const kept = {};
  const stripped = [];
  for (const [k, v] of Object.entries(meta)) {
    if (PHOTO_META_WHITELIST.includes(k)) {
      // 白名单字段值仍可能被写入 PII，再跑文本检测
      const r = detectText(String(v));
      kept[k] = r.masked;
      r.findings.forEach((f) => stripped.push({ key: k, type: f.type, match: f.match, reason: '白名单字段内文本命中检测' }));
    } else {
      stripped.push({ key: k, value_preview: String(v).slice(0, 60), reason: '不在元数据白名单（可能含GPS/作者/编辑软件等）' });
    }
  }
  return { kept, stripped };
}

// ---- 机器无法可靠判断、必须人工复核的类别 ----
// 这些内容在当前规则下无法被稳定识别（误报/漏报率高），系统只负责标记，不声称已脱敏。
export const MACHINE_LIMITATIONS = [
  { type: 'face', label: '人脸', why: '画面中出现的人脸/可辨认肖像，无法凭文本规则识别，需逐帧人工确认是否打码。' },
  { type: 'voice', label: '声音', why: '旁白/环境录音中可能出现自报姓名、电话、门牌号；语音转写可能漏字，需人工听音复核。' },
  { type: 'background', label: '背景信息', why: '背景中的门牌、快递单、聊天界面、校服校徽、车牌、地标等，机器检测不可靠，需人工看图。' },
  { type: 'voice_similarity', label: '声纹可辨识', why: '即使改写台词，说话人声音本身可能被熟人辨认，是否变声需人工判断。' },
  { type: 'context', label: '组合推断', why: '单条信息不敏感，但时间+地点+品种等组合可能定位到具体救助人与住址，需人工研判。' },
];

// ---- 对一份"工作稿"执行组合脱敏 ----
// working = {
//   summary, subtitles:[{at,text}], narration:[{at,text}], checklist:[{text}],
//   media_refs:[{media_id, face?, voice?, background?}], photo_meta:{media_id: meta}
// }
export function sanitizeWorking(working = {}) {
  const findings = [];
  const reviewItems = [];
  const scan = (text, surface) => {
    const r = detectText(text);
    r.findings.forEach((f) => findings.push({ ...f, surface, context: snippet(text, f.match) }));
    return r.masked;
  };
  const snippet = (src, match) => {
    const i = String(src).indexOf(match);
    return i < 0 ? '' : String(src).slice(Math.max(0, i - 12), i + match.length + 12);
  };

  const out = {
    summary: scan(working.summary ?? '', '正文'),
    subtitles: (working.subtitles || []).map((s) => ({ at: s.at ?? '', text: scan(s.text ?? '', '字幕') })),
    narration: (working.narration || []).map((s) => ({ at: s.at ?? '', text: scan(s.text ?? '', '旁白脚本') })),
    checklist: (working.checklist || []).map((s) => ({ text: scan(s.text ?? '', '附带清单') })),
    media_refs: [],
    photo_meta: {},
  };

  // 字幕/旁白/清单之外：每张引用照片的元数据必须处理
  for (const ref of working.media_refs || []) {
    const mediaOut = { media_id: ref.media_id };
    const flagged = [];
    // 人工/上传时预标注的三类机器盲区 -> 进入人工复核队列
    if (ref.face) { flagged.push('face'); reviewItems.push(mkReview('face', ref.media_id, '照片中疑似出现人脸，需确认打码/裁切')); }
    if (ref.voice) { flagged.push('voice'); reviewItems.push(mkReview('voice', ref.media_id, '音视频中疑似有人声自报信息或声纹可辨识，需听音复核')); }
    if (ref.background) { flagged.push('background'); reviewItems.push(mkReview('background', ref.media_id, '背景中疑似有门牌/快递单/地标等，需人工看图确认')); }
    mediaOut.manual_flags = flagged;
    out.media_refs.push(mediaOut);

    const meta = working.photo_meta?.[ref.media_id];
    if (meta) {
      const sm = sanitizePhotoMeta(meta);
      out.photo_meta[ref.media_id] = sm.kept;
      sm.stripped.forEach((x) => findings.push({ type: 'photo_meta', surface: '照片元数据', ...x }));
    }
  }

  return {
    preview: out,
    findings,
    review_items: reviewItems,
    machine_limitations: MACHINE_LIMITATIONS,
    strategy: 'whitelist+text-scan',
  };
}

function mkReview(type, mediaId, reason) {
  return { type, surface: mediaId, reason, status: 'pending' };
}
