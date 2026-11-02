// Hugging Face 公开数据集 eatpizzanot/soccer-dataset（CC-BY-4.0）。
// 源：API-Football + football-data.co.uk 的合法快照，含 673,966 场 fixture、
// 186,813 条 1X2 赔率（带 known_at）、阵容/教练/阵型、Elo 评分、xG 子集。
//
// 关键：teams 表带 fd_name（football-data 队名），所以能和我们现有赛程对齐，
// 这是目前唯一能补齐「赔率 known_at + 阵容 + 阵型」且授权明确的公开源。
//
// 通过 datasets-server（免 token、公开数据）分页读取，不下载整仓 parquet。
const SERVER = 'https://datasets-server.huggingface.co';
const CONFIGS = Object.freeze(['fixtures', 'teams', 'odds', 'fixture_lineups', 'match_stats', 'leagues']);
// 数据集的 leagues.fd_code 用的是 football-data.co.uk 的编码（E0/SP1/I1/F1/D1），
// 与 football-data.org 的联赛码（PL/PD/SA/FL1/BL1）不同，必须显式映射。
const FD_CODES = Object.freeze({ E0: 'PL', SP1: 'PD', I1: 'SA', F1: 'FL1', D1: 'BL1' });
const FINISHED_STATUS = 'FT';
export { FD_CODES };
const PAGE_MAX = 100;

export { CONFIGS };

async function fetchRows({ dataset, config, split = 'train', offset = 0, length = PAGE_MAX,
  fetchImpl = fetch, timeoutMs = 30_000, signal } = {}) {
  const n = Math.max(1, Math.min(PAGE_MAX, Number(length) || PAGE_MAX));
  const url = SERVER + '/rows?dataset=' + encodeURIComponent(dataset) + '&config=' + encodeURIComponent(config)
    + '&split=' + encodeURIComponent(split) + '&offset=' + String(Math.max(0, offset)) + '&length=' + String(n);
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)) });
  } catch { return { rows: [], error: 'FETCH_UNCONFIRMED', url }; }
  if (!response.ok) { await response.body?.cancel?.(); return { rows: [], error: 'HTTP_' + response.status, url }; }
  let payload;
  try { payload = await response.json(); } catch { return { rows: [], error: 'INVALID_JSON', url }; }
  if (!payload || !Array.isArray(payload.rows)) return { rows: [], error: 'INVALID_PAYLOAD', url };
  return { rows: payload.rows.map(r => r?.row ?? null).filter(Boolean),
    features: (payload.features || []).map(f => f?.name).filter(Boolean),
    numRowsTotal: Number.isSafeInteger(payload.num_rows_total) ? payload.num_rows_total : null, url };
}

export { fetchRows };

function toHistoryRow(row, leagueByApiId) {
  if (!row || row.status !== FINISHED_STATUS) return null;
  if (!Number.isInteger(row.goals_home) || !Number.isInteger(row.goals_away)) return null;
  if (row.goals_home < 0 || row.goals_away < 0) return null;
  if (!Number.isFinite(Date.parse(row.date_utc || ''))) return null;
  if (!Number.isInteger(row.home_team_id) || !Number.isInteger(row.away_team_id)) return null;
  if (row.home_team_id === row.away_team_id) return null;
  return { source: 'hf-soccer-dataset', league: leagueByApiId.get(row.league_id) || null,
    fixtureId: 'hf-' + row.id, homeTeamId: String(row.home_team_id), awayTeamId: String(row.away_team_id),
    kickoff: new Date(Date.parse(row.date_utc)).toISOString(),
    homeGoals: row.goals_home, awayGoals: row.goals_away, status: 'FINISHED', period: 'full-time',
    ...(typeof row.referee_name === 'string' && row.referee_name.trim() ? { referee: row.referee_name.trim() } : {}) };
}

// 分页拉 fixtures 并规范化。maxRows 用于控制单次导入规模；数据量大，分批跑。
export async function collectHfFixtures({ dataset = 'eatpizzanot/soccer-dataset', maxRows = 300,
  pageSize = PAGE_MAX, leagueByApiId = new Map(), fetchImpl = fetch, timeoutMs = 30_000, signal } = {}) {
  const rows = [], diagnostics = [];
  let offset = 0, total = null;
  while (offset < maxRows) {
    const page = await fetchRows({ dataset, config: 'fixtures', offset, length: Math.min(pageSize, maxRows - offset),
      fetchImpl, timeoutMs, signal });
    if (page.error) { diagnostics.push({ offset, error: page.error }); break; }
    if (total === null && page.numRowsTotal !== null) total = page.numRowsTotal;
    for (const raw of page.rows) { const row = toHistoryRow(raw, leagueByApiId); if (row) rows.push(row); }
    offset += page.rows.length;
    if (page.rows.length < pageSize) break;
  }
  return { version: 1, rows, diagnostics, scanned: offset, total };
}

// teams 表：拿 api_football_id / name / fd_name，用于建「football-data 队名 ↔ 数据集队 ID」映射。
export async function fetchHfTeams({ dataset = 'eatpizzanot/soccer-dataset', maxRows = 300,
  pageSize = PAGE_MAX, fetchImpl = fetch, timeoutMs = 30_000, signal } = {}) {
  const rows = [], diagnostics = [];
  let offset = 0;
  while (offset < maxRows) {
    const page = await fetchRows({ dataset, config: 'teams', offset, length: Math.min(pageSize, maxRows - offset),
      fetchImpl, timeoutMs, signal });
    if (page.error) { diagnostics.push({ offset, error: page.error }); break; }
    for (const raw of page.rows) {
      if (!raw || !Number.isInteger(raw.id)) continue;
      rows.push({ id: raw.id, apiFootballId: raw.api_football_id ?? null,
        name: typeof raw.name === 'string' ? raw.name : null,
        fdName: typeof raw.fd_name === 'string' && raw.fd_name.trim() ? raw.fd_name.trim() : null,
        elo: Number.isFinite(raw.rating_mu) ? raw.rating_mu : null });
    }
    offset += page.rows.length;
    if (page.rows.length < pageSize) break;
  }
  return { version: 1, teams: rows, diagnostics };
}

// odds 表：1X2 收盘/即时价 + known_at（赔率已知时间），可用于 CLV 与软盘偏差。
export async function fetchHfOdds({ dataset = 'eatpizzanot/soccer-dataset', maxRows = 300,
  pageSize = PAGE_MAX, fetchImpl = fetch, timeoutMs = 30_000, signal } = {}) {
  const quotes = [], diagnostics = [];
  let offset = 0;
  while (offset < maxRows) {
    const page = await fetchRows({ dataset, config: 'odds', offset, length: Math.min(pageSize, maxRows - offset),
      fetchImpl, timeoutMs, signal });
    if (page.error) { diagnostics.push({ offset, error: page.error }); break; }
    for (const raw of page.rows) {
      if (!raw || !Number.isInteger(raw.fixture_id)) continue;
      if (![raw.home_win, raw.draw, raw.away_win].every(v => Number.isFinite(v) && v > 1)) continue;
      const knownAt = Number.isFinite(Date.parse(raw.known_at || '')) ? new Date(Date.parse(raw.known_at)).toISOString() : null;
      if (!knownAt) continue;
      quotes.push({ fixtureKey: 'hf-' + raw.fixture_id, bookmaker: typeof raw.bookmaker === 'string' ? raw.bookmaker : null,
        home: raw.home_win, draw: raw.draw, away: raw.away_win, knownAt });
    }
    offset += page.rows.length;
    if (page.rows.length < pageSize) break;
  }
  return { version: 1, quotes, diagnostics };
}
