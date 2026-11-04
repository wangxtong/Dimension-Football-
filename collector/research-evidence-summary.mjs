import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const NL = String.fromCharCode(10);
const DIMENSIONS = [
  ['bySeason', '逐赛季'],
  ['byHorizon', '按提前量'],
  ['byModel', '按模型哈希（前 8 位）'],
  ['bySource', '按来源'],
  ['byLeague', '按联赛'],
];
const fixed = (value, digits = 4) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a');
const ratio = value => (typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'n/a');

/**
 * 把 research-evidence-rollup 的 JSON 渲染成人类可读的 Markdown。
 * 只做格式化：不重算、不改写任何指标，数字全部来自账本离线复算结果。
 */
export function renderEvidenceSummary(rollup, { maxRowsPerDimension = 12, source = null } = {}) {
  if (!rollup || typeof rollup !== 'object' || rollup.kind !== 'research-evidence-rollup') throw new Error('INVALID_ROLLUP_INPUT');
  const overall = rollup.overall || {};
  const lines = [];
  lines.push('# 研究证据汇总：Brier 逐维度拆分', '');
  lines.push('**研究参考，不构成投注建议，不授权商业发布。**', '');
  lines.push(`数据来源：${source || '不可变预测账本（离线只读复算，无网络请求）'}。本文件由 CI 生成并回写仓库，数字不经手工填写。`, '');
  lines.push('## 总体', '');
  lines.push(`- 样本：${overall.n ?? 0} 场（排除 ${rollup.excluded ?? 0} 条不合口径记录）`);
  lines.push(`- Brier：${fixed(overall.brier)}（样本标准误 ${fixed(overall.brierSE)}）`);
  lines.push(`- LogLoss：${fixed(overall.logLoss)}`);
  lines.push(`- 命中率：${ratio(overall.accuracy)}（按最大概率选边）`);
  lines.push(`- 选平次数：${overall.predictedDrawCount ?? 0}；实际平局：${overall.actualDrawCount ?? 0}`);
  const ledger = rollup.ledger || {};
  lines.push(`- 账本口径：${ledger.assessmentStatus || 'n/a'}；cohort 数 ${Array.isArray(ledger.cohorts) ? ledger.cohorts.length : 'n/a'}`);
  const coverage = ledger.coverage || {};
  lines.push(`- 覆盖：eligible ${coverage.eligible ?? 'n/a'}；已评分 ${coverage.evaluated ?? 'n/a'}；待 FT ${coverage.pending ?? 'n/a'}；跳过 ${coverage.skipped ?? 'n/a'}；评分率 ${ratio(coverage.rate)}`);
  if (ledger.metricsWithheldByMixedCohorts) lines.push('- 警示：账本内有多个模型 cohort，账本自身已扣留合并指标；下列总体数字仅供拆分参考，不可直接与回测成绩比较。');
  const blockers = Array.isArray(rollup.blockers) ? rollup.blockers : [];
  lines.push('', `阻断项：${blockers.length ? blockers.join('、') : '无'}`, '');
  lines.push('## 分维度', '');
  for (const [key, title] of DIMENSIONS) {
    const rows = Array.isArray(rollup[key]) ? rollup[key] : [];
    lines.push(`### ${title}`, '');
    if (!rows.length) { lines.push('无样本。', ''); continue; }
    const sorted = [...rows].sort((a, b) => (b.n || 0) - (a.n || 0));
    const shown = sorted.slice(0, maxRowsPerDimension);
    lines.push('| 键 | n | Brier | 标准误 | 命中率 | 选平 | 实际平 |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const row of shown) {
      lines.push(`| ${row.key} | ${row.n} | ${fixed(row.brier)} | ${fixed(row.brierSE)} | ${ratio(row.accuracy)} | ${row.predictedDrawCount ?? 0} | ${row.actualDrawCount ?? 0} |`);
    }
    if (sorted.length > shown.length) {
      lines.push('', `另有 ${sorted.length - shown.length} 个分桶按样本量省略；完整数字见同目录 evidence-rollup.json。`);
    }
    lines.push('');
  }
  lines.push('## 复算与边界', '');
  lines.push('- 只统计 provenance 为 prospective-ledger 的赛前冻结记录；赛后修订快照不计入。');
  lines.push('- 标准误为样本标准误 sqrt(var/n)；样本为 1 时不可计算，记为 n/a。');
  lines.push('- 多模型 cohort 混用返回 blocked-mixed-cohorts，此时不合并指标、不报总体 Brier 结论。');
  lines.push('- 本文件不改变 RELEASE_GATE：商业发布恒为 BLOCKED，研究汇总不等于可发布成绩。');
  return `${lines.join(NL)}${NL}`;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--input', '--out', '--source'].includes(flag)) throw new Error('INVALID_SUMMARY_ARGUMENT');
    if (value === undefined) throw new Error('INVALID_SUMMARY_ARGUMENT');
    if (Object.hasOwn(options, flag)) throw new Error('INVALID_SUMMARY_ARGUMENT');
    options[flag] = value;
  }
  return options;
}

export async function runSummaryCli(argv = [], { stdout = v => process.stdout.write(v), stderr = v => process.stderr.write(v) } = {}) {
  try {
    const options = parseArgs(argv);
    if (!options['--input'] || !options['--out']) throw new Error('INVALID_SUMMARY_ARGUMENT');
    const rollup = JSON.parse(await readFile(options['--input'], 'utf8'));
    const markdown = renderEvidenceSummary(rollup, { source: options['--source'] || null });
    await mkdir(dirname(options['--out']), { recursive: true });
    await writeFile(options['--out'], markdown);
    stdout(`SUMMARY_WRITTEN bytes=${Buffer.byteLength(markdown)}${NL}`);
    return 0;
  } catch (error) {
    stderr(`${error?.message === 'INVALID_SUMMARY_ARGUMENT' ? 'INVALID_SUMMARY_ARGUMENT' : 'EVIDENCE_SUMMARY_FAILED'}${NL}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runSummaryCli(process.argv.slice(2));
}
