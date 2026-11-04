// 采集真实性校验（authenticity）：一条外部数据必须能回答三个问题——
// 从哪来（sourceId + 完整 URL）、什么时候抓的（fetchedAt/HTTP Date）、内容有没有被改（body SHA-256）。
// 只有三项齐全且自洽，这条数据才允许进入模型或盘口候选；否则降级为"未验证"，并给出可读原因码。
//
// 设计约束：
// - 纯函数 + 显式传入 now，便于离线单测；不读全局时钟。
// - 不联网。联网由 crawler.mjs 负责，这里只校验已取回的证据。
// - 缺证据不抛异常，返回 {ok:false, reasons:[...]}；调用方据此降级，不静默通过。

export const AUTHENTICITY_CODES = Object.freeze([
  'SOURCE_ID_INVALID',        // 没有可识别的来源
  'URL_INVALID',              // 不是 https 或含凭据/查询串
  'FETCHED_AT_MISSING',       // 缺抓取时间
  'FETCHED_AT_IN_FUTURE',     // 抓取时间在未来（时钟或伪造）
  'FETCHED_AT_TOO_OLD',       // 超过允许时效
  'HTTP_STATUS_NOT_OK',       // 非 2xx
  'BODY_HASH_MISSING',        // 缺内容指纹
  'BODY_HASH_MISMATCH',       // 声明指纹与实际内容不符
  'HTTP_DATE_INVALID',        // 服务端日期无法解析
  'OBSERVED_AT_MISSING',      // 数据自身的观测时间缺失
  'OBSERVED_AFTER_FETCH',     // 观测时间晚于抓取时间（不可能）
  'CROSS_SOURCE_MISMATCH',    // 多源同场次关键字段冲突
  'CROSS_SOURCE_SINGLE',      // 只有一个来源，无法证实（不是错，但要标记）
]);

const ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const HEX64 = /^[a-f0-9]{64}$/;

function parseHttpDate(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** 内容指纹：对原始响应体做 SHA-256，返回 64 位小写 hex。 */
export async function bodySha256(text) {
  if (typeof text !== 'string') throw new TypeError('BODY_NOT_TEXT');
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 记录一次采集的完整证据。body 只用于算指纹，不落盘。 */
export async function createProvenance({ sourceId, url, fetchedAt, status, httpDate, body }) {
  return {
    sourceId,
    url,
    fetchedAt,
    status,
    httpDate: httpDate ?? null,
    bodySha256: await bodySha256(body),
    bytes: new TextEncoder().encode(body).length,
  };
}

/** 校验单条证据链。now 必须是毫秒时间戳。 */
export function verifyProvenance(record, { now, maxAgeMs = 900_000, requireObservedAt = false } = {}) {
  const reasons = [];
  if (!record || typeof record !== 'object') return { ok: false, reasons: ['SOURCE_ID_INVALID'] };
  const { sourceId, url, fetchedAt, status, bodySha256: hash } = record;

  if (typeof sourceId !== 'string' || !ID.test(sourceId)) reasons.push('SOURCE_ID_INVALID');

  let parsed = null;
  try { parsed = new URL(String(url)); } catch { reasons.push('URL_INVALID'); }
  if (parsed && (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash)) reasons.push('URL_INVALID');

  const fetched = Date.parse(fetchedAt ?? '');
  if (!Number.isFinite(fetched)) reasons.push('FETCHED_AT_MISSING');
  else {
    if (fetched > now + 60_000) reasons.push('FETCHED_AT_IN_FUTURE');
    if (now - fetched > maxAgeMs) reasons.push('FETCHED_AT_TOO_OLD');
  }

  if (!Number.isInteger(status) || status < 200 || status > 299) reasons.push('HTTP_STATUS_NOT_OK');
  if (typeof hash !== 'string' || !HEX64.test(hash)) reasons.push('BODY_HASH_MISSING');
  if (record.httpDate !== null && record.httpDate !== undefined && parseHttpDate(record.httpDate) === null) reasons.push('HTTP_DATE_INVALID');

  if (requireObservedAt) {
    const observed = Date.parse(record.observedAt ?? '');
    if (!Number.isFinite(observed)) reasons.push('OBSERVED_AT_MISSING');
    else if (Number.isFinite(fetched) && observed > fetched + 60_000) reasons.push('OBSERVED_AFTER_FETCH');
  }

  return { ok: reasons.length === 0, reasons };
}

/** 同场次跨源一致性：至少两个独立来源，且方向/让球/时间不冲突。 */
export function crossCheckIdentities(rows, { keyOf = row => row.fixtureId } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (typeof key !== 'string' || !key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const result = [];
  for (const [key, list] of groups) {
    const sources = [...new Set(list.map(r => r.independenceGroup || r.sourceId).filter(Boolean))];
    if (sources.length < 2) { result.push({ key, ok: false, reasons: ['CROSS_SOURCE_SINGLE'], sources }); continue; }
    const directions = new Set(list.map(r => r.selection).filter(Boolean));
    const handicaps = new Set(list.map(r => r.handicap).filter(v => v !== undefined));
    const reasons = [];
    if (directions.size > 1) reasons.push('CROSS_SOURCE_MISMATCH');
    // 让球幅度允许不同公司有微小差异，但同一独立组内出现两个不同盘口要显式记录。
    if (handicaps.size > 2) reasons.push('CROSS_SOURCE_MISMATCH');
    result.push({ key, ok: reasons.length === 0, reasons, sources });
  }
  return result;
}

/** 把一批记录聚合成一份可读的真实性报告。 */
export function summarize(findings) {
  const all = findings.flatMap(item => item.reasons);
  const counts = {};
  for (const code of all) counts[code] = (counts[code] || 0) + 1;
  return { total: findings.length, verified: findings.filter(f => f.reasons.length === 0).length, counts };
}
