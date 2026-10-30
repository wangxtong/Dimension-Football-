import {fetchMarketSourceAudit} from './market-sources.mjs';
import {fetchPredictionSignals} from './signals.mjs';

export {fetchFootballFixtures, fixtureLeagues} from './fixtures.mjs';
export {fetchApiFootballFixtures, apiFootballLeagues} from './api-football.mjs';

export const sourceCapabilities = Object.freeze({
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
  return {quotes, signals: predictions.signals.map(signal => ({...signal, independenceGroup: signal.sourceId})), diagnostics,
    fixtureDiagnostics: markets.fixtureDiagnostics};
}
