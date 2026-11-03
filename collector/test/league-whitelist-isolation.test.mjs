// ROUND-015 #2 负例：联赛白名单扩展不得改变历史报表出口。
// 目标：证明「支持哪些联赛」与「报表统计维度」是两件事，且偷换后者必须失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { READINESS_LEAGUES } from '../model-readiness.mjs';
import { buildDailyResearchReport } from '../research-daily-report.mjs';
import { validateDailyResearch } from '../../website/research-daily-store.mjs';

const NOW = '2026-11-03T04:00:00Z';
const CODE = 'a'.repeat(40);
const FIVE = ['PL', 'PD', 'SA', 'BL1', 'FL1'];

test('readiness 白名单锁定五大联赛，不因研究池扩到 CL/BSA 而改变', () => {
  assert.deepEqual([...READINESS_LEAGUES], FIVE);
  for (const league of ['CL', 'BSA']) assert.ok(!READINESS_LEAGUES.includes(league));
});

test('30 天分联赛统计恒为五条，与研究白名单解耦', () => {
  const report = buildDailyResearchReport({ ledger: { exists: true, events: [] }, nowISO: NOW, codeSha: CODE });
  assert.equal(report.prospective.byLeague30Days.length, 5);
  assert.deepEqual(report.prospective.byLeague30Days.map(row => row.league), FIVE);
});

test('把统计维度偷换成 7 条必须被 schema 拒绝，而不是静默重建', async () => {
  const report = buildDailyResearchReport({ ledger: { exists: true, events: [] }, nowISO: NOW, codeSha: CODE });
  for (const league of ['CL', 'BSA']) report.prospective.byLeague30Days.push({ ...report.prospective.byLeague30Days[0], league });
  assert.equal(report.prospective.byLeague30Days.length, 7);
  await assert.rejects(validateDailyResearch(report), { code: 'RESEARCH_REPORT_INVALID' });
});
