import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, atomicJson } from './storage.mjs';
import { readPredictionLedger } from './prediction-ledger.mjs';
import { teamName } from './sources/team-names.mjs';

// 研究日报 Telegram 推送：所有者 2026-11-02 授权的个人研究用途通道。
// 与 publish-research-daily.mjs（Web）对称：普通 1X2 研究参考才允许发送；
// 严格盘口候选恒为 0；商业发布门禁保持 BLOCKED，本通道不构成正式发布授权。
const HASH = /^[a-f0-9]{64}$/;
const TELEGRAM_MAX_CHARS = 3900;

function validDailyResearch(report) {
  return report?.kind === 'research-daily-1x2' && report?.mode === 'research-reference'
    && report?.commercialReleaseGate === 'BLOCKED' && report?.externalTelegramSent !== true
    && report?.strictMarkets?.releasedCandidates === 0 && HASH.test(report.reportId || '')
    && typeof report.disclaimer === 'string' && report.disclaimer.length > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(report.beijingDay || '')
    && Number.isFinite(Date.parse(report.generatedAt || ''))
    && report.forecasts && Number.isSafeInteger(report.forecasts.total);
}

const LEAGUE_CN = { PL: '英超', PD: '西甲', SA: '意甲', BL1: '德甲', FL1: '法甲' };
const OUTCOME_CN = { home: '主胜', draw: '平局', away: '客胜' };
// 分隔线与图标都只用纯文本字符：不依赖 parse_mode，任何客户端都不会串成竖线。
// 分隔线压到 10 段，避免在窄屏客户端里折行成两行。
const RULE = '━━━━━━━━━━';
// Telegram 手机端一行大约只放得下 ~30 个半角宽度；超过就自动折行，看起来就"排版乱了"。
// 这里按东亚宽度估算显示宽度：CJK/全角/emoji 记 2，其余记 1，并据此硬性限制每行长度。
const TELEGRAM_LINE_WIDTH = 28;
function charWidth(code) {
  if (code >= 0x1F300 && code <= 0x1FAFF) return 2;
  if (code >= 0x2600 && code <= 0x27BF) return 2;
  if (code >= 0xFE00 && code <= 0xFE0F) return 0;
  if (code >= 0x200D && code <= 0x200F) return 0;
  if ((code >= 0x1100 && code <= 0x115F) || (code >= 0x2E80 && code <= 0xA4CF)
    || (code >= 0xAC00 && code <= 0xD7A3) || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0xFE30 && code <= 0xFE4F) || (code >= 0xFF00 && code <= 0xFF60)
    || (code >= 0xFFE0 && code <= 0xFFE6)) return 2;
  return 1;
}
export function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) width += charWidth(char.codePointAt(0));
  return width;
}
// 球场城市中文化：英文城市混在中文队名里会让整块排版显乱。
const CITY_CN = {
  'London': '伦敦',
  'Liverpool': '利物浦',
  'Manchester': '曼彻斯特',
  'Newcastle upon Tyne': '纽卡斯尔',
  'Birmingham': '伯明翰',
  'Brighton': '布莱顿',
  'Bournemouth': '伯恩茅斯',
  'Nottingham': '诺丁汉',
  'Wolverhampton': '伍尔弗汉普顿',
  'Leeds': '利兹',
  'Sunderland': '桑德兰',
  'Burnley': '伯恩利',
  'Leicester': '莱斯特',
  'Ipswich': '伊普斯维奇',
  'Southampton': '南安普顿',
  'Sheffield': '谢菲尔德',
  'Luton': '卢顿',
  'Watford': '沃特福德',
  'Norwich': '诺维奇',
  'West Bromwich': '西布罗姆维奇',
  'Middlesbrough': '米德尔斯堡',
  'Stoke-on-Trent': '斯托克',
  'Swansea': '斯旺西',
  'Cardiff': '卡迪夫',
  'Hull': '赫尔',
  'Coventry': '考文垂',
  'Preston': '普雷斯顿',
  'Blackburn': '布莱克本',
  'Bristol': '布里斯托',
  'Derby': '德比',
  'Portsmouth': '朴茨茅斯',
  'Oxford': '牛津',
  'Plymouth': '普利茅斯',
  'Wrexham': '雷克瑟姆',
  'Munich': '慕尼黑',
  'Dortmund': '多特蒙德',
  'Leipzig': '莱比锡',
  'Leverkusen': '勒沃库森',
  'Stuttgart': '斯图加特',
  'Frankfurt am Main': '法兰克福',
  'Wolfsburg': '沃尔夫斯堡',
  'Mönchengladbach': '门兴格拉德巴赫',
  'Bremen': '不来梅',
  'Berlin': '柏林',
  'Mainz': '美因茨',
  'Augsburg': '奥格斯堡',
  'Sinsheim': '辛斯海姆',
  'Freiburg im Breisgau': '弗赖堡',
  'Hamburg': '汉堡',
  'Bochum': '波鸿',
  'Heidenheim an der Brenz': '海登海姆',
  'Cologne': '科隆',
  'Kiel': '基尔',
  'Darmstadt': '达姆施塔特',
  'Hanover': '汉诺威',
  'Paderborn': '帕德博恩',
  'Düsseldorf': '杜塞尔多夫',
  'Karlsruhe': '卡尔斯鲁厄',
  'Nuremberg': '纽伦堡',
  'Kaiserslautern': '凯泽斯劳滕',
  'Gelsenkirchen': '盖尔森基兴',
  'Rostock': '罗斯托克',
  'Fürth': '菲尔特',
  'Bielefeld': '比勒费尔德',
  'Barcelona': '巴塞罗那',
  'Madrid': '马德里',
  'Seville': '塞维利亚',
  'Valencia': '瓦伦西亚',
  'Villarreal': '比利亚雷亚尔',
  'San Sebastián': '圣塞巴斯蒂安',
  'Bilbao': '毕尔巴鄂',
  'Vigo': '维戈',
  'Getafe': '赫塔费',
  'Pamplona': '潘普洛纳',
  'Palma': '马略卡帕尔马',
  'Girona': '赫罗纳',
  'Vitoria-Gasteiz': '维多利亚',
  'Las Palmas de Gran Canaria': '拉斯帕尔马斯',
  'Leganés': '莱加内斯',
  'Valladolid': '巴利亚多利德',
  'Elche': '埃尔切',
  'Oviedo': '奥维耶多',
  'Cádiz': '加的斯',
  'Granada': '格拉纳达',
  'Almería': '阿尔梅里亚',
  'A Coruña': '拉科鲁尼亚',
  'Gijón': '希洪',
  'Santander': '桑坦德',
  'Zaragoza': '萨拉戈萨',
  'Santa Cruz de Tenerife': '特内里费',
  'Huesca': '韦斯卡',
  'Málaga': '马拉加',
  'Castellón de la Plana': '卡斯特利翁',
  'Milan': '米兰',
  'Turin': '都灵',
  'Naples': '那不勒斯',
  'Rome': '罗马',
  'Bergamo': '贝加莫',
  'Florence': '佛罗伦萨',
  'Bologna': '博洛尼亚',
  'Udine': '乌迪内',
  'Reggio Emilia': '雷焦艾米利亚',
  'Cagliari': '卡利亚里',
  'Genoa': '热那亚',
  'Verona': '维罗纳',
  'Lecce': '莱切',
  'Empoli': '恩波利',
  'Parma': '帕尔马',
  'Como': '科莫',
  'Venice': '威尼斯',
  'Cremona': '克雷莫纳',
  'Pisa': '比萨',
  'Monza': '蒙扎',
  'Frosinone': '弗罗西诺内',
  'Salerno': '萨莱诺',
  'Palermo': '巴勒莫',
  'Brescia': '布雷西亚',
  'La Spezia': '拉斯佩齐亚',
  'Bari': '巴里',
  'Paris': '巴黎',
  'Marseille': '马赛',
  'Monaco': '摩纳哥',
  'Lyon': '里昂',
  'Lille': '里尔',
  'Nice': '尼斯',
  'Lens': '朗斯',
  'Rennes': '雷恩',
  'Brest': '布雷斯特',
  'Toulouse': '图卢兹',
  'Strasbourg': '斯特拉斯堡',
  'Montpellier': '蒙彼利埃',
  'Nantes': '南特',
  'Reims': '兰斯',
  'Auxerre': '欧塞尔',
  'Angers': '昂热',
  'Le Havre': '勒阿弗尔',
  'Saint-Étienne': '圣埃蒂安',
  'Metz': '梅斯',
  'Lorient': '洛里昂',
  'Dunkerque': '敦刻尔克',
  'Guingamp': '甘冈',
  'Caen': '卡昂',
  'Amiens': '亚眠',
  'Grenoble': '格勒诺布尔',
  'Ajaccio': '阿雅克肖',
  'Bastia': '巴斯蒂亚',
  'Troyes': '特鲁瓦',
  'Clermont-Ferrand': '克莱蒙费朗',
};
function cityName(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return CITY_CN[value.trim()] || value.trim();
}
function pctValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? (value * 100).toFixed(1) + '%' : '—';
}
function beijingShort(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms + 8 * 3600_000);
  const pad = n => String(n).padStart(2, '0');
  return pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}
// 表格单元格里再省一个字都会影响是否折行：温度/风速/降水用最短写法。
function weatherNarrow(row) {
  const w = row.weather || {};
  const parts = [];
  if (typeof w.temperatureC === 'number' && Number.isFinite(w.temperatureC)) parts.push(w.temperatureC.toFixed(0) + '°C');
  if (typeof w.windKmh === 'number' && Number.isFinite(w.windKmh)) parts.push('风' + w.windKmh.toFixed(0));
  if (typeof w.precipitationProbabilityPct === 'number' && Number.isFinite(w.precipitationProbabilityPct))
    parts.push('雨' + w.precipitationProbabilityPct.toFixed(0) + '%');
  return parts.length ? parts.join(' ') : null;
}
function weatherCompact(row) {
  const w = row.weather;
  const parts = [];
  if (typeof w.temperatureC === 'number' && Number.isFinite(w.temperatureC)) parts.push(w.temperatureC.toFixed(0) + '°C');
  if (typeof w.windKmh === 'number' && Number.isFinite(w.windKmh)) parts.push('风' + w.windKmh.toFixed(0));
  if (typeof w.precipitationProbabilityPct === 'number' && Number.isFinite(w.precipitationProbabilityPct))
    parts.push('雨' + w.precipitationProbabilityPct.toFixed(0) + '%');
  if (typeof w.precipitationMm === 'number' && w.precipitationMm > 0) parts.push(w.precipitationMm.toFixed(1) + 'mm');
  return parts.length ? parts.join(' · ') : null;
}
// Telegram 不渲染 Markdown 表格：一赛一段，竖排短行，一眼能读完。
function forecastBlock(row) {
  const lines = [];
  const p = row.probabilities || {};
  const league = LEAGUE_CN[row.league] || row.league;
  lines.push('⚽ ' + league + ' · ' + beijingShort(row.kickoff));
  lines.push(teamName(row.home) + ' vs ' + teamName(row.away));
  lines.push('📊 主' + pctValue(p.home) + ' 平' + pctValue(p.draw) + ' 客' + pctValue(p.away));
  lines.push('🎯 ' + (OUTCOME_CN[row.selection] || row.selection) + ' ' + pctValue(p[row.selection]));
  const eg = row.expectedGoals;
  if (eg && Number.isFinite(eg.home) && Number.isFinite(eg.away)) {
    const total = eg.home + eg.away;
    lines.push('🔮 进球 ' + eg.home.toFixed(1) + ':' + eg.away.toFixed(1)
      + ' · ' + (total >= 2.5 ? '大2.5' : '小2.5'));
  }
  const scores = Array.isArray(row.topScores) && row.topScores.length
    ? row.topScores.map(s => s.home + ':' + s.away).join(' · ') : '';
  if (scores) lines.push('🔢 比分 ' + scores);
  const weather = row.weather && row.weather.status === 'ok' ? weatherCompact(row) : null;
  if (weather) lines.push('🌦 ' + weather);
  const city = row.venue ? cityName(row.venue.city) : null;
  if (city) lines.push('📍 ' + city);
  return lines;
}
function statsLine(label, row) {
  if (!row) return label + ' —';
  const hit = row.scored ? '命中' + (row.hitRate * 100).toFixed(1) + '%' : '命中—';
  return label + ' ' + row.eligibleFrozen + '/' + row.scored + '/' + row.pending + ' · ' + hit;
}
// 没有新场次但有已结算结果时，标题行直接给出结算摘要，避免用户以为当天什么都没发生。
function settleSuffix(report) {
  const day = report.prospective && report.prospective.oneDay;
  if (!day || !day.scored) return '';
  const hit = Number.isFinite(day.hitRate) ? '命中' + (day.hitRate * 100).toFixed(1) + '%' : '命中—';
  return '｜已结算 ' + day.scored + ' 场 ' + hit;
}
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Telegram Bot API 10.3（2026-08-24）起支持 sendRichMessage：rich_message.html 可以带
// <table bordered striped compact>。手机端由客户端渲染表格，不再受"一行放得下几个字"影响，
// 这才是真正解决宽窄比例问题的排版方式；sendMessage 纯文本版保留为兜底。
// 结算明细：从账本读「近 1 日已评分」的场次，用 predictions.json 补队名。
// 任何读取失败都退化为空数组——明细是增值信息，绝不能让它阻断每日推送。
export async function settledToday({ root, beijingDay, limit = 8 } = {}) {
  try {
    const ledger = await readPredictionLedger({ directory: resolve(root, 'reports/forecast-ledger') });
    let names = new Map();
    try {
      const doc = await readJson(resolve(root, 'reports/predictions.json'), 4_000_000);
      names = new Map((doc?.fixtures || []).map(row => [row.fixture?.id, { home: row.fixture?.home, away: row.fixture?.away }]));
    } catch { /* 缺 predictions.json 时只显示 fixtureId */ }
    const rows = [];
    for (const event of ledger.events || []) {
      const prediction = [...(event.predictions || [])].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt))[0];
      if (!prediction) continue;
      const result = (event.results || []).filter(row => row.source === prediction.source
        && row.fixtureId === prediction.fixtureId && row.status === 'FINISHED'
        && Number.isFinite(Date.parse(row.resultObservedAt)) && Date.parse(row.resultObservedAt) > Date.parse(prediction.kickoff))
        .sort((a, b) => Date.parse(b.resultObservedAt) - Date.parse(a.resultObservedAt))[0];
      if (!result) continue;
      const day = new Date(Date.parse(result.resultObservedAt) + 8 * 3600_000).toISOString().slice(0, 10);
      if (beijingDay && day !== beijingDay) continue;
      const actual = result.homeGoals > result.awayGoals ? 'home' : result.homeGoals === result.awayGoals ? 'draw' : 'away';
      // 账本记录里没有 selection 字段，只有 probabilities；按 argmax 还原预测方向。
      const probs = prediction.probabilities || {};
      const pick = ['home', 'draw', 'away'].reduce((best, key) => (probs[key] > (probs[best] ?? -1) ? key : best), 'home');
      const hit = actual === pick;
      const name = names.get(prediction.fixtureId) || {};
      rows.push({ kickoff: prediction.kickoff, league: prediction.league,
        home: name.home || prediction.fixtureId, away: name.away || '—',
        pick: OUTCOME_CN[pick] || pick,
        actual: OUTCOME_CN[actual] || actual,
        score: result.homeGoals + ':' + result.awayGoals, hit });
    }
    return rows.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff)).slice(0, limit);
  } catch { return []; }
}

// 窗口内 0 场时（例如国际比赛日），告诉用户下一批已冻结场次是什么时候，避免"没内容"的感觉。
export async function upcoming({ root, limit = 3 } = {}) {
  try {
    const doc = await readJson(resolve(root, 'reports/predictions.json'), 4_000_000);
    const now = Date.now();
    return (doc?.fixtures || [])
      .filter(row => row?.forecast?.status === 'forecast' && Number.isFinite(Date.parse(row?.fixture?.kickoff))
        && Date.parse(row.fixture.kickoff) > now)
      .sort((a, b) => Date.parse(a.fixture.kickoff) - Date.parse(b.fixture.kickoff))
      .slice(0, limit)
      .map(row => ({ kickoff: row.fixture.kickoff, league: row.fixture.league, home: row.fixture.home, away: row.fixture.away }));
  } catch { return []; }
}

export function richHtml(report, settled = [], next = []) {
  const total = report.forecasts.total;
  const lines = ['<b>🏟 维度足球 · 每日 1X2 研究参考</b>',
    '📅 ' + esc(report.beijingDay) + '｜冻结 ' + total + ' 场｜严格盘口 0 场' + settleSuffix(report),
    '⚠️ 研究参考，非投注建议｜时间均为北京时间'];
  const candidates = report.forecasts.candidates || [];
  if (candidates.length) {
    // 手机竖屏放不下任何多列比赛表（实测 5 列仍需左右滑）：赛事信息改成
    // 「一场一块」的富文本卡片，每行都很短，永不横向滚动；只有 FT 核账这种
    // 短数字表继续用 table。
    for (const row of candidates) {
      const p = row.probabilities || {};
      const eg = row.expectedGoals;
      const goals = eg && Number.isFinite(eg.home) && Number.isFinite(eg.away) ? eg.home + eg.away : null;
      const scores = Array.isArray(row.topScores) ? row.topScores.map(s => s.home + ':' + s.away).join(' ') : '';
      lines.push('');
      lines.push('<b>⚽ ' + esc((LEAGUE_CN[row.league] || row.league) + ' · ' + beijingShort(row.kickoff).slice(6)) + '</b>');
      lines.push(esc(teamName(row.home) + ' vs ' + teamName(row.away)));
      lines.push('主' + pctValue(p.home) + ' 平' + pctValue(p.draw) + ' 客' + pctValue(p.away));
      if (eg) lines.push('进球 ' + eg.home.toFixed(1) + ':' + eg.away.toFixed(1)
        + ' · ' + (goals === null ? '—' : (goals >= 2.5 ? '大2.5' : '小2.5')));
      if (scores) lines.push('比分 ' + esc(scores));
      const weather = weatherNarrow(row);
      if (weather) lines.push('🌦 ' + esc(weather));
      const city = row.venue ? cityName(row.venue.city) : null;
      if (city) lines.push('📍 ' + esc(city));
    }
  } else {
    lines.push('', '本轮没有符合赛前冻结条件的研究预测，不补场。');
  }
  lines.push('', '<b>📈 真实前瞻核账</b>', '<table bordered compact>',
    '<tr><th>窗口</th><th>冻结</th><th>评分</th><th>待FT</th><th>命中率</th></tr>');
  for (const [label, row] of [['近1日', report.prospective?.oneDay], ['近7日', report.prospective?.sevenDays],
    ['近30日', report.prospective?.thirtyDays]]) {
    lines.push('<tr><td>' + label + '</td><td>' + (row?.eligibleFrozen ?? '—') + '</td><td>' + (row?.scored ?? '—')
      + '</td><td>' + (row?.pending ?? '—') + '</td><td>'
      + (row && row.scored ? (row.hitRate * 100).toFixed(1) + '%' : '—') + '</td></tr>');
  }
  lines.push('</table>');
  if (Array.isArray(settled) && settled.length) {
    lines.push('', '<b>🧾 近 1 日结算</b>');
    for (const row of settled) {
      // 账本 result 只保留 teamId 不含队名；昨天冻结的场次不在今天的 predictions.json 里，
      // 因此队名可能缺失。缺队名时退化为「联赛 比分」，不显示裸 fixtureId。
      const hasName = row.home && row.away && row.away !== '—';
      const title = hasName ? teamName(row.home) + ' vs ' + teamName(row.away)
        : (LEAGUE_CN[row.league] || row.league || '赛事');
      lines.push((row.hit ? '✅ ' : '❌ ') + esc(title) + ' ' + esc(row.score) + '｜'
        + esc(row.pick) + '→' + esc(row.actual));
    }
  }
  if (Array.isArray(next) && next.length) {
    lines.push('', '<b>📅 接下来（已冻结）</b>');
    for (const row of next) {
      lines.push('· ' + esc(beijingShort(row.kickoff)) + ' ' + esc((LEAGUE_CN[row.league] || row.league) + ' '
        + teamName(row.home) + ' vs ' + teamName(row.away)));
    }
  }
  lines.push('', 'ℹ️ 回测与模拟数据不计入前瞻',
    '🔗 报告 ' + String(report.reportId).slice(0, 12) + '…');
  return blockify(lines);
}
// Rich Message 的 html 是块级文档：裸换行符会被丢弃，整段文字会连成一片。
// 文本行必须包成 <p>，表格行原样保留。
function blockify(lines) {
  const out = [];
  for (const line of lines) {
    if (line === undefined || line === null || line === '') continue;
    if (/^<(?:table|caption|tr|\/table)/.test(line)) out.push(line);
    else out.push('<p>' + line + '</p>');
  }
  return out.join('');
}
export function telegramText(report) {
  const total = report.forecasts.total;
  const lines = [
    '🏟 维度足球 · 每日研究',
    '📅 ' + report.beijingDay + '｜冻结 ' + total + ' 场' + settleSuffix(report),
    '⚠️ 研究参考，非投注建议',
    '🕘 时间均为北京时间',
  ];
  const candidates = report.forecasts.candidates || [];
  if (candidates.length) {
    for (const row of candidates) { lines.push(RULE, ...forecastBlock(row)); }
  } else {
    lines.push(RULE, '本轮没有符合赛前冻结条件的研究预测，不补场。');
  }
  lines.push(RULE,
    '📈 真实前瞻核账',
    '· ' + statsLine('近1日', report.prospective?.oneDay),
    '· ' + statsLine('近7日', report.prospective?.sevenDays),
    '· ' + statsLine('近30日', report.prospective?.thirtyDays),
    '',
    'ℹ️ 回测与模拟数据不计入前瞻',
    '🔗 报告 ' + String(report.reportId).slice(0, 12) + '…');
  const full = lines.join('\n');
  return full.length <= TELEGRAM_MAX_CHARS ? full : full.slice(0, TELEGRAM_MAX_CHARS - 20) + '\n…（完整内容见网站报告）';
}

export async function publishResearchTelegram({ root, env = process.env, fetchImpl = fetch, clock = () => new Date().toISOString() }) {
  if (!root) throw Error('RESEARCH_ROOT_REQUIRED');
  const directory = resolve(root, 'reports/research-daily');
  const report = await readJson(join(directory, 'latest.json'), 750_000);
  if (!validDailyResearch(report)) throw Error('RESEARCH_REPORT_INVALID');
  const token = env.TELEGRAM_BOT_TOKEN; const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { reportId: report.reportId, beijingDay: report.beijingDay,
    status: 'not_configured', code: 'TELEGRAM_CREDENTIALS_REQUIRED' };
  if (!/^\d{5,20}:[A-Za-z0-9_-]{20,150}$/.test(token) || !/^-?\d{5,20}$/.test(String(chatId))) throw Error('TELEGRAM_CONFIGURATION_INVALID');
  const receiptPath = join(directory, 'telegram-receipt.json');
  let prior = null;
  try { prior = await readJson(receiptPath, 16000); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (prior?.beijingDay === report.beijingDay && prior?.codeSha === report.codeSha && prior?.status === 'accepted')
    return { reportId: report.reportId, beijingDay: report.beijingDay, status: 'skipped', code: 'ALREADY_SENT_TODAY' };
  await readFile(join(directory, 'latest.md'), 'utf8');
  const post = async (method, payload) => {
    const response = await fetchImpl('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    // Telegram 对 4xx 也返回 JSON（{"ok":false,"description":"..."}）。description 不含凭据，
    // 必须保留：否则线上 400 只能看到一个状态码，无法判断是 chat 不存在还是 token 失效。
    let data = null;
    try { data = await response.json(); } catch { try { await response.body?.cancel(); } catch {} }
    if (!response.ok) return { ok: false, httpStatus: response.status,
      ...(typeof data?.description === 'string' ? { description: data.description.slice(0, 200) } : {}) };
    return { ok: true, data };
  };
  const accept = (sent, channel) => {
    if (!sent.ok) return { status: 'failed', code: 'TELEGRAM_API_REJECTED', httpStatus: sent.httpStatus,
      ...(sent.description ? { description: sent.description } : {}), channel };
    const data = sent.data || {};
    if (data.ok !== true || !Number.isSafeInteger(data.result?.message_id) || String(data.result?.chat?.id) !== String(chatId))
      return { status: 'unknown', code: 'TELEGRAM_RECEIPT_UNVERIFIED', channel };
    return { status: 'accepted', messageId: data.result.message_id, channel };
  };
  let result;
  try {
    // 优先富文本（真正的表格），失败才退回纯文本；任一成功都算送达，不重复发送。
    const settled = await settledToday({ root, beijingDay: report.beijingDay });
    const next = await upcoming({ root });
    const rich = await post('sendRichMessage', { chat_id: chatId, rich_message: { html: richHtml(report, settled, next) } });
    if (rich.ok && rich.data && rich.data.ok === true) result = accept(rich, 'rich');
    else {
      const plain = await post('sendMessage', { chat_id: chatId, text: telegramText(report),
        link_preview_options: { is_disabled: true } });
      result = accept(plain, 'plain');
      // 两条通道都失败时保留富文本通道的错误描述，便于定位。
      if (!result.description && rich.ok && typeof rich.data?.description === 'string')
        result.errorDescription = rich.data.description.slice(0, 200);
    }
  } catch { result = { status: 'unknown', code: 'DELIVERY_RESULT_UNKNOWN_NO_AUTOMATIC_RETRY' }; }
  await mkdir(directory, { recursive: true });
  await atomicJson(receiptPath, { version: 1, beijingDay: report.beijingDay, codeSha: report.codeSha,
    reportId: report.reportId, sentAt: clock(), ...result });
  return { reportId: report.reportId, beijingDay: report.beijingDay, ...result,
    meaning: result.status === 'accepted' ? 'telegram-api-accepted-not-a-user-read-receipt' : undefined };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--root') {
    console.error('用法：node collector/publish-research-telegram.mjs --root <研究工作区>');
    process.exitCode = 2;
  } else {
    try {
      const value = await publishResearchTelegram({ root: args[1] });
      console.log(JSON.stringify(value));
      // 静默失败最危险：以前 Telegram 返回 400 时 CI 步骤仍是 success，每天都没有消息却全绿。
      if (value.status !== 'accepted' && value.status !== 'skipped') process.exitCode = 1;
    }
    catch (error) {
      const code = /^(?:RESEARCH|TELEGRAM)_[A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'RESEARCH_DELIVERY_FAILED';
      console.error(code); process.exitCode = 1;
    }
  }
}
