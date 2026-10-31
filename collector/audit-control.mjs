import { spawn } from 'node:child_process';
import { mkdir, realpath, stat, lstat, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const PROJECT = resolve(import.meta.dirname, '..');
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TOOL_TIMEOUT_MS = 60000;
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (parent, child) => { const path = relative(parent, child); return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`); };
const toolKinds = { 'source-readiness': 'source-readiness-audit', 'model-readiness': 'model-readiness',
  'market-readiness': 'offline-market-readiness-audit', 'state-capacity': 'hosted-state-capacity' };

async function destination(path) {
  let ancestor = resolve(path); const suffix = [];
  for (;;) {
    try { return join(await realpath(ancestor), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw Error('AUDIT_OUTPUT_INVALID');
      const parent = dirname(ancestor);
      if (ancestor === parent) throw Error('AUDIT_OUTPUT_INVALID');
      suffix.push(relative(parent, ancestor)); ancestor = parent;
    }
  }
}
async function preparePaths({ reportDir, stateRoot, outDir }) {
  if (![reportDir, stateRoot, outDir].every(value => typeof value === 'string' && value.length > 0 && !value.includes('\0'))) throw Error('AUDIT_ARGUMENT_INVALID');
  const [report, state, out] = await Promise.all([realpath(resolve(reportDir)), realpath(resolve(stateRoot)), destination(outDir)]);
  if (!(await stat(report)).isDirectory() || !(await stat(state)).isDirectory()) throw Error('AUDIT_INPUT_DIRECTORY_INVALID');
  if ([report, state].some(input => inside(input, out) || inside(out, input))) throw Error('AUDIT_OUTPUT_OVERLAPS_INPUT');
  try { await lstat(out); throw Error('AUDIT_OUTPUT_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out, { mode: 0o700 }); // Fresh directory only; no prior audit or input is overwritten.
  return { reportDir: report, stateRoot: state, outDir: out };
}

/** Fixed Node programs and argument arrays; no shell, network clients or inherited secrets. */
export function executeAuditTool({ script, args }, { spawnImpl = spawn, timeoutMs = TOOL_TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT_BYTES } = {}) {
  return new Promise(resolveResult => {
    let child, outputBytes = 0, stdout = '', stderr = '', failure = null, timer;
    const done = (exitCode, signal) => {
      clearTimeout(timer);
      resolveResult({ exitCode, signal: signal || null, stdout, stderr, errorCode: failure });
    };
    try {
      child = spawnImpl(process.execPath, [script, ...args], { cwd: PROJECT, shell: false,
        env: { LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { failure = 'AUDIT_TOOL_START_FAILED'; done(null, null); return; }
    const receive = stream => chunk => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) { failure = 'AUDIT_TOOL_OUTPUT_LIMIT'; child.kill('SIGKILL'); return; }
      if (stream === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', receive('stdout')); child.stderr.on('data', receive('stderr'));
    child.once('error', () => { failure = 'AUDIT_TOOL_START_FAILED'; done(null, null); });
    child.once('close', done);
    timer = setTimeout(() => { failure = 'AUDIT_TOOL_TIMEOUT'; child.kill('SIGKILL'); }, timeoutMs);
  });
}

function toolSpecs(paths, auditedAt) {
  return [
    { id: 'source-readiness', args: ['--report-dir', paths.reportDir, '--as-of', auditedAt] },
    { id: 'model-readiness', args: ['--ledger', join(paths.reportDir, 'forecast-ledger'), '--horizon-hours', '24', '--now', auditedAt] },
    { id: 'market-readiness', args: ['--report', join(paths.reportDir, 'latest.json'), '--format', 'json', '--as-of', auditedAt] },
    { id: 'state-capacity', args: ['--root', paths.stateRoot] },
  ].map(spec => ({ ...spec, script: join(PROJECT, 'collector', `${spec.id}.mjs`) }));
}
function assessResult(spec, result) {
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '', stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  let evidence = null, errorCode = result?.errorCode || null;
  try {
    evidence = JSON.parse(stdout);
    if (!evidence || Array.isArray(evidence) || evidence.version !== 1 || evidence.kind !== toolKinds[spec.id]) throw Error();
  } catch { evidence = null; errorCode ||= 'AUDIT_TOOL_JSON_INVALID'; }
  const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : null;
  if (![0, 2].includes(exitCode)) errorCode ||= 'AUDIT_TOOL_EXECUTION_FAILED';
  const executionStatus = errorCode ? 'failed' : 'completed';
  const findings = [...(Array.isArray(evidence?.gaps) ? evidence.gaps : []), ...(Array.isArray(evidence?.blockers) ? evidence.blockers : []),
    ...(Array.isArray(evidence?.releaseBlockers) ? evidence.releaseBlockers : []), ...(Array.isArray(evidence?.warnings) ? evidence.warnings : [])];
  if (evidence?.snapshot?.withinLimits === false) findings.push('STATE_CAPACITY_EXCEEDED');
  if (evidence?.migration?.status?.startsWith('blocked')) findings.push('STATE_ARCHIVAL_RESTORE_NOT_VERIFIED');
  const blocked = exitCode === 2 || [evidence?.releaseGate, evidence?.releaseStatus].includes('BLOCKED');
  return { tool: spec.id, exitCode, executionStatus, findingStatus: executionStatus === 'failed' ? 'unavailable'
    : blocked ? 'blocked' : findings.length ? 'not-ready' : 'evidence-recorded',
    releaseApproved: false, findings, evidence, errorCode,
    // Unexpected CLI text is fingerprinted rather than copying arbitrary values
    // into a shareable audit. Native structured evidence is retained in full.
    output: { stdoutBytes: Buffer.byteLength(stdout), stdoutSha256: hash(stdout), stderrBytes: Buffer.byteLength(stderr), stderrSha256: hash(stderr) } };
}
const roleDefinitions = [
  ['A1', '总控', '合同、分环节审计、证据归属与发布门槛', null, '核对各环节失败与缺口；保持 RELEASE_GATE=BLOCKED，完成独立验收后再另行评审。'],
  ['A2', '数据来源', '来源授权、覆盖、冷却、时效及采集边界', 'source-readiness', '按来源和联赛补齐真实可用证据；授权、赛程覆盖和盘口可用性分别验收。'],
  ['A3', '数据与持久状态', '规范赛事身份、修订、历史、回放及账本容量', 'state-capacity', '先验证独立归档与恢复，再迁移热状态；保留未评分预测及其机会记录。'],
  ['A4', '模型', '固定提前量、冻结预测、前瞻评分、校准与基准比较', 'model-readiness', '按同源同联赛固定24小时窗口积累可验证前瞻样本，补齐输入可见性、校准与冻结基准证据。'],
  ['A5', '盘口', '最新盘口状态、独立来源、赛事修订绑定及真实初盘', 'market-readiness', '逐场核验同一盘口的独立来源、时效和真实初盘；未知或缺失证据继续阻断。'],
  ['A6', '交付', '同一报告发布、网站回读、通知防重及回执', null, '另行执行交付故障演练与同reportId回读核验；本工具不发送或发布。'],
  ['A7', '运行保障', '调度、持久化、恢复、容量及运行身份', null, '另行核验真实部署、调度间隔、恢复演练与运行身份；本工具不证明线上运行状态。'],
  ['A8', '网站', '展示校验、过期状态、刷新失败及浏览器验收', null, '另行执行浏览器、鉴权和last-good验收；本工具不代替网站测试。'],
];
function rolesFor(checks) {
  return roleDefinitions.map(([id, name, responsibility, tool, nextStep]) => {
    const check = checks.find(row => row.tool === tool);
    return { id, name, responsibility, status: id === 'A1' ? 'blocked' : check ? check.findingStatus : 'not-audited',
      evidence: id === 'A1' ? ['audit-control.json'] : check ? [check.file] : [], findings: check?.findings || [], nextStep };
  });
}
const md = value => String(value).replace(/[|\r\n]/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function progressMarkdown(audit) {
  const labels = { completed: '核验执行完成', failed: '工具执行失败', unavailable: '缺少有效审计输出',
    blocked: '阻断', 'not-ready': '存在未补齐证据', 'evidence-recorded': '已记录证据，待独立验收', 'not-audited': '本轮未核验' };
  return [`# 统一总控核验进度`, '', `核验时间：${audit.auditedAt}`, '', '**RELEASE_GATE：BLOCKED**。退出码0或2只表示子工具的执行或诊断结果，均不授权正式发布。', '',
    '本轮仅运行四个离线只读核验。八角色的职责分别保留；没有证据的环节明确标为未核验，不以其他环节的成功替代。', '',
    '| 环节 | 执行结果 | 诊断结果 | 证据 |', '| --- | --- | --- | --- |',
    ...audit.checks.map(row => `| ${row.tool} | ${labels[row.executionStatus]}（退出码 ${row.exitCode ?? '无'}） | ${labels[row.findingStatus]}${row.errorCode ? `：${row.errorCode}` : ''} | [${row.file}](${row.file}) |`), '',
    '| 角色 | 职责 | 状态 | 证据 | 下一步 |', '| --- | --- | --- | --- | --- |',
    ...audit.roles.map(role => `| ${role.id} ${role.name} | ${md(role.responsibility)} | ${labels[role.status]} | ${role.evidence.length ? role.evidence.map(file => `[${file}](${file})`).join('、') : '无；未在本轮执行'} | ${md(role.nextStep)} |`), '',
    '各工具完整证据与缺口分别存于独立JSON文件。来源和盘口绑定各自报告，模型使用指定账本，容量使用指定状态根；这些输入不会被合并成一轮采集统计。', '',
    '本轮未调用网络、部署或通知，也未修改原报告、历史与账本。', ''].join('\n');
}

export async function runAuditControl(options, { runTool = executeAuditTool, clock = () => new Date().toISOString() } = {}) {
  const auditedAt = clock();
  if (typeof auditedAt !== 'string' || !Number.isFinite(Date.parse(auditedAt))) throw Error('AUDIT_CLOCK_INVALID');
  const paths = await preparePaths(options), checks = [];
  for (const spec of toolSpecs(paths, auditedAt)) {
    let result;
    try { result = await runTool(spec); } catch { result = { exitCode: null, errorCode: 'AUDIT_TOOL_START_FAILED' }; }
    const check = assessResult(spec, result), file = `${spec.id}.json`;
    const contents = `${JSON.stringify({ version: 1, kind: 'audit-control-tool-evidence', auditedAt, ...check }, null, 2)}\n`;
    await writeFile(join(paths.outDir, file), contents, { flag: 'wx', mode: 0o600 });
    const { evidence, output, ...summary } = check;
    checks.push({ ...summary, file, sha256: hash(contents), bytes: Buffer.byteLength(contents),
      inputReportId: evidence?.reportId || null, inputScope: spec.id === 'model-readiness' ? 'specified-ledger'
        : spec.id === 'state-capacity' ? 'specified-state-root' : 'one-bound-report' });
  }
  const audit = { version: 1, kind: 'audit-control', auditedAt, completedAt: clock(), RELEASE_GATE: 'BLOCKED', canRelease: false,
    mode: 'offline-read-only', inputs: { reportDir: paths.reportDir, stateRoot: paths.stateRoot, ledgerDir: join(paths.reportDir, 'forecast-ledger') },
    summary: { tools: checks.length, completed: checks.filter(row => row.executionStatus === 'completed').length,
      failed: checks.filter(row => row.executionStatus === 'failed').length }, checks, roles: rolesFor(checks),
    limitations: ['Subprocess completion never means release readiness.', 'A6, A7 and A8 require separate delivery, operations and browser evidence.',
      'Each source retains its own report/cohort scope; metrics from separate pipelines are not summed.'] };
  await writeFile(join(paths.outDir, 'audit-control.json'), `${JSON.stringify(audit, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(join(paths.outDir, 'progress.md'), progressMarkdown(audit), { flag: 'wx', mode: 0o600 });
  return { exitCode: 2, audit, outDir: paths.outDir };
}

const HELP = 'Usage: node collector/audit-control.mjs --report-dir DIR --state-root DIR --out NEW_AUDIT_DIRECTORY\nRuns four fixed offline read-only audits; output must be a new directory outside all input directories. Writes audit-control.json, progress.md and four evidence JSON files. RELEASE_GATE always BLOCKED; exit 2 after an audit, exit 1 for invalid arguments or output failures. No collection, deployment or notifications.\n';
export async function runAuditControlCli(argv, { stdout = value => process.stdout.write(value), ...dependencies } = {}) {
  if (argv.length === 1 && argv[0] === '--help') { stdout(HELP); return 0; }
  const options = {}, names = { '--report-dir': 'reportDir', '--state-root': 'stateRoot', '--out': 'outDir' };
  for (let index = 0; index < argv.length; index += 2) {
    const key = names[argv[index]], value = argv[index + 1];
    if (!key || !value || value.startsWith('--') || Object.hasOwn(options, key)) throw Error('AUDIT_ARGUMENT_INVALID');
    options[key] = value;
  }
  const result = await runAuditControl(options, dependencies);
  stdout(`${JSON.stringify({ RELEASE_GATE: 'BLOCKED', ...result.audit.summary, outDir: result.outDir })}\n`); return result.exitCode;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runAuditControlCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${/^AUDIT_[A-Z_]+$/.test(error.message) ? error.message : 'AUDIT_CONTROL_FAILED'}\n`); process.exitCode = 1;
  });
}
