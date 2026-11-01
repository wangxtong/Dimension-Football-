// These declarations identify known publishing/production channels. They do not
// authorize collection, establish a commercial licence, validate a quote, or
// prove an opening price. Keep those checks in their respective policy layers.
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export const QUOTE_ORIGINS = freeze({
  hkjc: {
    sourceId: 'hkjc', group: 'hkjc-first-party', kind: 'official-publisher',
    publisher: 'Hong Kong Jockey Club', bookmakers: ['HKJC'],
    hosts: ['bet.hkjc.com'], channels: ['hkjc', 'hkjc-first-party'],
    evidence: [{ url: 'https://bet.hkjc.com/en/football/hdc',
      claim: 'Official HKJC HDC publication, acquired directly by the existing adapter.', documentDate: null }],
  },
  titan007: {
    sourceId: 'titan007', group: 'titan007', kind: 'shared-publishing-channel',
    publisher: 'Titan007', bookmakers: ['M88', '12Bet', 'SBOBET'],
    hosts: ['live.titan007.com', 'livestatic.titan007.com'], channels: ['titan007', 'titan007-public-market'],
    companies: { 17: 'M88', 24: '12Bet', 31: 'SBOBET' },
    evidence: [{ url: 'https://live.titan007.com/index2in1.aspx?id=17',
      claim: 'Bookmaker labels delivered through the same Titan007 acquisition channel count as one group.', documentDate: null }],
  },
  macauslot: {
    sourceId: 'macauslot', group: 'macauslot-official', kind: 'official-publisher',
    publisher: 'Sociedade de Lotarias e Apostas Mútuas de Macau, Lda.', bookmakers: ['Macau SLOT'],
    hosts: ['www.macauslot.com'], channels: ['macauslot', 'macauslot-official'],
    evidence: [
      { url: 'https://www.macaotourism.gov.mo/zh-hant/shows-and-entertainment/gaming/soccer-basketball-lottery',
        claim: 'Macau tourism authority states that the operator selects leagues and determines odds and handicaps.',
        documentDate: '2019-07-23', limitation: 'Historical operator evidence; not a current data licence or a quote freshness assertion.' },
      { url: 'https://www.macauslot.com/slot/html/new/statement/en_statement.html',
        claim: 'Operator identifies www.macauslot.com as its information website and www.macau-slot.com as its betting website.',
        documentDate: null, limitation: 'Information-site identity does not grant commercial redistribution rights.' },
    ],
  },
});

const channels = new Map(Object.values(QUOTE_ORIGINS).flatMap(origin => origin.channels.map(channel => [channel, origin.sourceId])));
export function quoteChannelSource(channel) {
  return typeof channel === 'string' ? channels.get(channel) || null : null;
}

// Identity only: capture proofs intentionally omit evidence URLs. Evidence URL,
// freshness, fixture binding, pair completeness and licence checks stay separate.
// Domain names and row-supplied independenceGroup/group values never add votes.
export function resolveQuoteOrigin(row) {
  if (!row || typeof row.sourceId !== 'string' || !Object.hasOwn(QUOTE_ORIGINS, row.sourceId)) return null;
  const origin = QUOTE_ORIGINS[row.sourceId];
  if (!origin.bookmakers.includes(row.bookmaker)) return null;
  if (row.provider !== undefined && quoteChannelSource(row.provider) !== origin.sourceId) return null;
  const sourceChannel = quoteChannelSource(row.source);
  if (sourceChannel && sourceChannel !== origin.sourceId) return null;
  if (row.companyId !== undefined && row.companyId !== null
    && (!origin.companies || !Number.isSafeInteger(row.companyId) || origin.companies[row.companyId] !== row.bookmaker)) return null;
  return origin;
}
