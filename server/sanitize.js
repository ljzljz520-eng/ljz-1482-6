// 脱敏组合策略：
//   第一层 结构白名单 —— 只有登记在册的字段允许进入公开稿
//   第二层 文本检测   —— 对白名单字段的*内容*做正则扫描（电话/地址/证件/邮箱）
//   第三层 人工复核   —— 机器无法可靠判断的模态：人脸、声音、照片/视频背景信息
//
// 文本检测必须覆盖所有文本面：页面正文、字幕(subtitle)、旁白脚本(narration)、附带清单(manifest)

const PUBLIC_FIELD_WHITELIST = {
  profile:   ['alias', 'species', 'breed', 'age_range', 'city', 'story_public', 'status_public'],
  timeline:  ['title', 'body_public', 'event_date'],
  character: ['public_alias', 'role', 'bio_public'],
  media:     ['caption_public'],
};

// 机器无法可靠判断、必须人工复核的类目
const MANUAL_REVIEW_CATEGORIES = [
  { key: 'image_faces',       label: '照片/视频中出现的人脸（路人、救助人正脸）' },
  { key: 'audio_voice',       label: '音频/视频中的可辨识人声（声纹可定位个人）' },
  { key: 'photo_background',  label: '照片背景信息：门牌、车牌、路牌、室内陈设、窗外地标' },
  { key: 'video_background',  label: '视频背景信息：车牌、门牌、可定位的街景' },
];

// 文本检测规则（覆盖字幕/旁白/清单/正文，调用方负责传入所有文本面）
const TEXT_DETECTORS = [
  { type: 'phone_mobile',  re: /(?<!\d)1[3-9]\d{9}(?!\d)/g,                              label: '手机号码' },
  { type: 'phone_landline',re: /(?<!\d)0\d{2,3}-?\d{7,8}(?!\d)/g,                        label: '固定电话' },
  { type: 'id_card',       re: /(?<!\d)\d{17}[\dXx](?!\d)/g,                             label: '身份证号' },
  { type: 'email',         re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,        label: '电子邮箱' },
  { type: 'address_detail',re: /[一-龥]{2,}(?:省|市|区|县)[一-龥A-Za-z0-9]{2,}?(?:路|街|巷|弄|小区|公寓|栋|幢)\d*[-\d]*(?:号|室|单元)?/g, label: '详细地址' },
  { type: 'qq_wechat_id',  re: /(?:微信|QQ|qq|vx|VX)[:：]?\s*[A-Za-z0-9_-]{5,}/g,        label: '社交账号' },
];

// 照片/媒体元数据中必须剥离的键（GPS、设备、所有者）
const METADATA_STRIP_KEYS = [
  'GPSLatitude', 'GPSLongitude', 'GPSAltitude', 'GPSPosition', 'GPS',
  'SerialNumber', 'BodySerialNumber', 'LensSerialNumber',
  'OwnerName', 'Artist', 'Copyright', 'ImageUniqueID',
  'UserComment', 'MakerNote', 'DeviceName', 'HostComputer',
];

/** 扫描单段文本，返回命中项 [{type,label,match,surface}] */
function scanText(text, surface = 'body') {
  if (!text) return [];
  const hits = [];
  for (const d of TEXT_DETECTORS) {
    d.re.lastIndex = 0;
    let m;
    while ((m = d.re.exec(text)) !== null) {
      hits.push({ type: d.type, label: d.label, match: m[0], surface });
      if (m.index === d.re.lastIndex) d.re.lastIndex++;
    }
  }
  return hits;
}

/** 扫描一个内容对象的所有文本面：正文/字幕/旁白/附带清单 */
function scanAllSurfaces(surfaces) {
  // surfaces: { body, subtitle, narration, manifest }
  let all = [];
  for (const [surface, text] of Object.entries(surfaces)) {
    all = all.concat(scanText(text, surface));
  }
  return all;
}

/** 对命中项做占位替换（用于自动生成脱敏预览） */
function redactText(text, findings) {
  if (!text) return text;
  let out = text;
  for (const f of findings) {
    out = out.split(f.match).join(`〔已脱敏:${f.label}〕`);
  }
  return out;
}

/** 字段是否允许公开（白名单第一层） */
function isFieldPublic(sourceType, field) {
  return (PUBLIC_FIELD_WHITELIST[sourceType] || []).includes(field);
}

/** 剥离媒体元数据中的敏感键，返回 {clean, stripped} */
function stripMetadata(exifJson) {
  let meta = {};
  try { meta = typeof exifJson === 'string' ? JSON.parse(exifJson || '{}') : (exifJson || {}); } catch { meta = {}; }
  const clean = {}, stripped = [];
  for (const [k, v] of Object.entries(meta)) {
    if (METADATA_STRIP_KEYS.some(s => k.toLowerCase().includes(s.toLowerCase()))) stripped.push(k);
    else clean[k] = v;
  }
  return { clean, stripped };
}

module.exports = {
  PUBLIC_FIELD_WHITELIST, MANUAL_REVIEW_CATEGORIES, TEXT_DETECTORS, METADATA_STRIP_KEYS,
  scanText, scanAllSurfaces, redactText, isFieldPublic, stripMetadata,
};
