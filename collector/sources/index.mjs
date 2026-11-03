import {fetchMarketSourceAudit} from './market-sources.mjs';
import {fetchPredictionSignals} from './signals.mjs';
import {withPublicCrawler, CRAWLER_CODES} from './crawler.mjs';
import {collectProviderEvidence} from './providers.mjs';
import {fetchHkjcEvidence} from './hkjc.mjs';
import {fetchMacauslotEvidence} from './macauslot.mjs';

export {fetchFootballFixtures, fixtureLeagues} from './fixtures.mjs';
export {fetchApiFootballFixtures, apiFootballLeagues} from './api-football.mjs';

export const sourceCapabilities = Object.freeze({
  hkjc: '香港赛马会官方公开 HDC 全场两方盘口；第一方现售快照，独立于 Titan007 转发渠道。保留官方池 updateAt 与当前响应时点，不生成初盘。',
  macauslot: 'ACCESS_BLOCKED：当前未获来源采集准入；禁止实时请求、引用旧缓存或计入独立双源覆盖。历史解析仅供离线审计。',
  titan007: '读取球探公开 M88、12Bet、SBOBET 的赛前全场亚洲盘。三家公司共享球探采集渠道，独立来源组均为 titan007；不含皇冠。',
  statarea: '读取公开页面的五大联赛赛前 1X2 模型概率，仅覆盖已发布的当日至未来 3 天页面；不是亚洲盘赢盘概率。',
  tiantian: '仅监测天天盈球公开免费赛前列表；具体预测格式未核验，不生成预测信号。',
  forebet: '当前缺少自动采集和再分发授权，不请求受限页面。',
  footymetrics: '当前缺少自动采集授权，不请求受限页面。',
  tactix: '当前缺少 API 协议授权，不请求受限页面。',
  golsinyali: '当前缺少自动采集授权，不请求受限页面。',
  fotmob: '当前缺少自动采集授权，不请求受限页面。',
  singbet: '需要 Asianodds 授权令牌；当前未接通，不生成盘口。',
  ibc: '需要 Asianodds 授权令牌；当前未接通，不生成盘口。',
});

/**
 * Collect only implemented public feeds. Reachability is never consensus.
 * The flattened quotes preserve bookmaker prices while declaring their common
 * transport group. Signals remain 1X2 evidence and cannot be Asian-cover votes.
 */
export async function collectPublicEvidence({fixtures = [], nowISO = new Date().toISOString(), fetchImpl = fetch} = {}) {
  const now = Date.parse(nowISO);
  if (!Array.isArray(fixtures) || fixtures.length > 3000 || !Number.isFinite(now) || typeof fetchImpl !== 'function') {
    throw new TypeError('Invalid public evidence request (maximum 3000 fixtures)');
  }
  const [markets, predictions] = await Promise.all([
    fetchMarketSourceAudit({fixtures, nowISO, fetchImpl}),
    fetchPredictionSignals({fixtures, nowISO, fetchImpl}),
  ]);
  const quotes = markets.quotes.flatMap(({fixtureId, quote}) => quote.quotes.map(price => ({
    fixtureId, fixtureSnapshot: quote.fixtureSnapshot,
    sourceId: 'titan007', independenceGroup: 'titan007', bookmaker: price.bookmaker,
    provider: quote.provider, companyId: quote.companyId, providerMatchId: quote.providerMatchId,
    market: quote.market, period: quote.period,
    selection: price.selection, handicap: price.handicap, decimalOdds: price.decimalOdds,
    observedAt: quote.observedAt, sourceUpdatedAt: quote.sourceUpdatedAt,
    scheduleUpdatedAt: quote.scheduleUpdatedAt, validUntil: quote.validUntil,
    evidenceUrl: quote.sourceUrl, feedUrl: `https://livestatic.titan007.com/vbsxml/goal${quote.companyId}.xml`,
    inPlay: false, closed: false, verified: true, verificationMethod: 'automatic',
  })));
  const diagnostics = [
    ...markets.sources.map(source => ({...source, sourceId: ['m88', '12bet', 'sbobet'].includes(source.id) ? 'titan007' : source.id,
      independenceGroup: ['m88', '12bet', 'sbobet'].includes(source.id) ? 'titan007' : source.id,
      capability: sourceCapabilities[['m88', '12bet', 'sbobet'].includes(source.id) ? 'titan007' : source.id]})),
    ...predictions.sources.map(source => ({...source, sourceId: source.id, independenceGroup: source.id,
      capability: sourceCapabilities[source.id]})),
  ];
  return {quotes, marketStates: markets.marketStates || [], signals: predictions.signals.map(signal => ({...signal, independenceGroup: signal.sourceId})), diagnostics,
    fixtureDiagnostics: markets.fixtureDiagnostics};
}

export async function collectCrawledEvidence({fixtures, nowISO, includeMacauslot = false, ...crawlerOptions}) {
  // Deny unadmitted source before crawler, cached response and HTTP transport.
  if (includeMacauslot) throw new Error('ACCESS_BLOCKED');
  const {result, crawler} = await withPublicCrawler(crawlerOptions,
    async fetchImpl => {
      if (!includeMacauslot) return collectPublicEvidence({fixtures, nowISO, fetchImpl});
      // Both public lanes share one robots policy, per-origin queues and total
      // request budget. The adapter never receives an unrestricted transport.
      const macauFetch = (url, init) => fetchImpl(url, init);
      macauFetch.timeoutMs = 30_000; // Includes 10s robots pacing + a bounded 12s response.
      const outcomes = await Promise.allSettled([
        collectPublicEvidence({ fixtures, nowISO, fetchImpl }),
        fetchMacauslotEvidence({ fixtures, nowISO, fetchImpl: macauFetch,
          clock: crawlerOptions.clock, signal: crawlerOptions.signal, remaining: crawlerOptions.remaining,
          cooldownStatePath: crawlerOptions.statePath ? `${crawlerOptions.statePath}.macauslot-cooldown.json` : undefined }),
      ]);
      const data = outcomes.map((row, index) => row.status === 'fulfilled' ? row.value
        : { quotes: [], signals: [], diagnostics: [{ id: index ? 'macauslot' : 'public-crawler', status: 'failed',
          code: CRAWLER_CODES.has(row.reason?.code) ? row.reason.code
            : ['SOURCE_COOLDOWN_INVALID', 'SOURCE_COOLDOWN_UNREADABLE', 'COLLECTION_ALREADY_LOCKED'].includes(row.reason?.message)
              ? row.reason.message : 'COLLECTION_FAILED', checkedAt: nowISO }] });
      return { quotes: data.flatMap(row => row.quotes || []), signals: data.flatMap(row => row.signals || []),
        marketStates: data.flatMap(row => row.marketStates || []), diagnostics: data.flatMap(row => row.diagnostics || []),
        fixtureDiagnostics: data.flatMap(row => row.fixtureDiagnostics || []) };
    });
  const formatCodes = new Set(['invalid_schedule', 'invalid_snapshot', 'prediction_format_not_verified', 'stale_page']);
  crawler.parserIssues = result.diagnostics.filter(row => formatCodes.has(row.code || row.note))
    .map(row => ({sourceId: row.sourceId || row.id, code: row.code || row.note}));
  return {...result, crawler};
}

/** Credentialed APIs and the existing public crawler have separate policies/state.
 * A subscription failure never sends its key or private endpoint to a browser.
 */
export async function collectIntegratedEvidence({ fixtures, nowISO, env, providerStatePath, providerPolicy, ...crawlerOptions }) {
  const results = await Promise.allSettled([
    collectCrawledEvidence({ fixtures, nowISO, ...crawlerOptions, includeMacauslot: false }),
    collectProviderEvidence({ fixtures, nowISO, env, statePath: providerStatePath, policy: providerPolicy,
      fetchImpl: crawlerOptions.fetchImpl, signal: crawlerOptions.signal, clock: crawlerOptions.clock, remaining: crawlerOptions.remaining }),
    fetchHkjcEvidence({ fixtures, nowISO, cooldownStatePath: crawlerOptions.statePath ? `${crawlerOptions.statePath}.hkjc-cooldown.json` : undefined,
      fetchImpl: crawlerOptions.fetchImpl, signal: crawlerOptions.signal, clock: crawlerOptions.clock, remaining: crawlerOptions.remaining }),
  ]);
  if (results.every(r => r.status === 'rejected')) throw new Error('EVIDENCE_UNAVAILABLE');
  const data = results.map((r, index) => r.status === 'fulfilled' ? r.value
    : { quotes: [], signals: [], diagnostics: [{ id: ['public-crawler', 'commercial-providers', 'hkjc'][index], status: 'failed',
      code: ['PROVIDER_STATE_INVALID', 'PROVIDER_STATE_UNREADABLE', 'CRAWLER_STATE_INVALID', 'CRAWLER_STATE_UNREADABLE',
        'SOURCE_COOLDOWN_INVALID', 'SOURCE_COOLDOWN_UNREADABLE', 'COLLECTION_ALREADY_LOCKED'].includes(r.reason?.message)
        ? r.reason.message : 'COLLECTION_FAILED', checkedAt: nowISO }] });
  // A source blocked at ingress cannot count as an independent market group.
  const admitted = row => row?.sourceId !== 'macauslot' && row?.id !== 'macauslot' && row?.provider !== 'macauslot-official';
  const blockedDiagnostic = { id: 'macauslot', sourceId: 'macauslot', status: 'blocked', code: 'ACCESS_BLOCKED', checkedAt: nowISO };
  return { quotes: data.flatMap(r => r.quotes).filter(admitted), marketStates: data.flatMap(r => r.marketStates || []).filter(admitted), signals: data.flatMap(r => r.signals).filter(admitted), diagnostics: [...data.flatMap(r => r.diagnostics).filter(admitted), blockedDiagnostic],
    fixtureDiagnostics: data.flatMap(row => row.fixtureDiagnostics || []), crawler: data[0].crawler || null, providers: data[1].providers || null };
}
