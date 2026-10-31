export function demoInput(nowISO) {
  const now = Date.parse(nowISO), at = offset => new Date(now + offset).toISOString();
  const fixtures = [0, 1, 2].map(index => ({
    id: `simulation-${index + 1}`, league: 'PL', home: `模拟主队${index + 1}`, away: `模拟客队${index + 1}`,
    kickoff: at((index + 2) * 3_600_000), updatedAt: nowISO, source: 'simulation', status: 'SCHEDULED',
  }));
  const fixture = fixtures[0], snapshot = Object.fromEntries(['id', 'league', 'home', 'away', 'kickoff', 'source'].map(key => [key, fixture[key]]));
  const common = { fixtureId: fixture.id, fixtureSnapshot: snapshot, verified: true, verificationMethod: 'automatic', observedAt: nowISO,
    sourceUpdatedAt: nowISO, validUntil: at(300_000), market: 'asian-handicap', period: 'full-time', inPlay: false, closed: false };
  const quotes = ['titan007', 'oddstorm'].flatMap((sourceId, index) => ['home', 'away'].map(selection => ({
    ...common, sourceId, bookmaker: index ? 'SBOBET' : 'M88', selection,
    handicap: selection === 'home' ? -.25 : .25, decimalOdds: selection === 'home' ? 1.9 : 1.92,
    evidenceUrl: index ? 'https://www.oddstorm.com/' : 'https://live.titan007.com/index2in1.aspx?id=17',
    ...(selection === 'home' ? { opening: { handicap: -.25, decimalOdds: 1.85, observedAt: at(-3_600_000), recordedAt: nowISO,
      basis: 'provider-opening', sourceId, bookmaker: index ? 'SBOBET' : 'M88', selection, fixtureId: fixture.id,
      evidenceUrl: index ? 'https://www.oddstorm.com/' : 'https://live.titan007.com/index2in1.aspx?id=17' } } : {}),
  })));
  const signals = [{ ...common, sourceId: 'statarea', market: '1x2', selection: 'home', probability: .6,
    evidenceUrl: 'https://www.statarea.com/predictions', validUntil: at(3_600_000) }];
  return { fixtures, evidence: { quotes, signals, diagnostics: [{ id: 'demo', status: 'simulated', code: 'SIMULATION_ONLY', checkedAt: nowISO, matchedCount: 1 }] } };
}
