// 开球时段天气（Open-Meteo 免费接口，无需注册与 API key）。
// 边界：天气只作研究参考展示，绝不参与 1X2 概率计算，也不改变任何模型输入或账本冻结内容。
// 策略：按“纬度/经度/UTC日”缓存逐小时序列；一次日报对同一城市只发一次请求；
//       任何失败都降级为 { status: 'unavailable', reason }，绝不抛错阻断日报。
const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const HOURLY = 'temperature_2m,precipitation,precipitation_probability,wind_speed_10m,weather_code';
const REASON = new Set(['disabled', 'no-venue', 'no-kickoff', 'hour-out-of-range', 'budget-exhausted',
  'request-failed', 'timeout', 'invalid-response']);

export function kickoffHourUTC(kickoff) {
  const ms = Date.parse(kickoff);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().slice(0, 13) + ':00';
}

function hoursUrl(latitude, longitude) {
  const params = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude),
    hourly: HOURLY, timezone: 'UTC', forecast_days: '7', models: 'best_match' });
  return ENDPOINT + '?' + params.toString();
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// 从逐小时序列里取与开球整点严格相等的那一格；不插值、不借用邻近小时。
export function pickKickoffHour(payload, hourUTC) {
  const hourly = payload && payload.hourly;
  if (!hourly || !Array.isArray(hourly.time)) return null;
  const index = hourly.time.indexOf(hourUTC);
  if (index < 0) return null;
  const at = key => (Array.isArray(hourly[key]) ? number(hourly[key][index]) : null);
  const row = { status: 'ok', hourUTC, temperatureC: at('temperature_2m'),
    windKmh: at('wind_speed_10m'), precipitationMm: at('precipitation'),
    precipitationProbabilityPct: at('precipitation_probability'), weatherCode: at('weather_code'),
    source: 'open-meteo', model: payload.model || 'best_match' };
  if (row.temperatureC === null) return null;
  return row;
}

function fail(reason, extra) {
  return { status: 'unavailable', reason: REASON.has(reason) ? reason : 'invalid-response', ...extra };
}

export async function fetchHourlySeries(venue, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const response = await fetchImpl(hoursUrl(venue.lat, venue.lon),
    { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!response.ok) return { error: 'request-failed', httpStatus: response.status };
  const payload = await response.json();
  if (!payload || !payload.hourly || !Array.isArray(payload.hourly.time)) return { error: 'invalid-response' };
  return { payload };
}

export function weatherForMatch(venue, kickoff, series) {
  if (!venue) return fail('no-venue');
  const hourUTC = kickoffHourUTC(kickoff);
  if (!hourUTC) return fail('no-kickoff');
  if (!series || series.error) return fail(series?.error || 'invalid-response');
  const row = pickKickoffHour(series.payload, hourUTC);
  return row || fail('hour-out-of-range', { hourUTC });
}

// matches: [{ key, home, kickoff }]，venue 由调用方通过 venueFor 解析后传入 venueByKey。
export async function attachWeather(matches, { venueByKey, fetchImpl = fetch, timeoutMs = 15_000,
  maxRequests = 40, nowISO = new Date().toISOString() } = {}) {
  const cache = new Map();
  const out = {};
  let used = 0;
  for (const match of matches) {
    const venue = venueByKey ? venueByKey(match.home) : null;
    if (!venue) { out[match.key] = fail('no-venue'); continue; }
    const hourUTC = kickoffHourUTC(match.kickoff);
    if (!hourUTC) { out[match.key] = fail('no-kickoff'); continue; }
    const cacheKey = venue.lat + ',' + venue.lon + ',' + hourUTC.slice(0, 10);
    if (!cache.has(cacheKey)) {
      if (used >= maxRequests) { out[match.key] = fail('budget-exhausted'); continue; }
      used += 1;
      try { cache.set(cacheKey, await fetchHourlySeries(venue, { fetchImpl, timeoutMs })); }
      catch (error) {
        cache.set(cacheKey, { error: error && error.name === 'TimeoutError' ? 'timeout' : 'request-failed' });
      }
    }
    out[match.key] = weatherForMatch(venue, match.kickoff, cache.get(cacheKey));
  }
  return { weather: out, requests: used, retrievedAt: nowISO };
}

export function weatherSummary(row) {
  if (!row || row.status !== 'ok') return { cn: '—', available: false };
  const parts = [];
  if (row.temperatureC !== null) parts.push(row.temperatureC.toFixed(0) + '°C');
  if (row.windKmh !== null) parts.push('风' + row.windKmh.toFixed(0) + 'km/h');
  if (row.precipitationProbabilityPct !== null) parts.push('雨' + row.precipitationProbabilityPct.toFixed(0) + '%');
  if (row.precipitationMm !== null && row.precipitationMm > 0) parts.push(row.precipitationMm.toFixed(1) + 'mm');
  return { cn: parts.join(' ') || '—', available: parts.length > 0 };
}
