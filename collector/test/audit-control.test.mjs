import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { runAuditControl, runAuditControlCli, executeAuditTool } from '../audit-control.mjs';

const NOW = '2026-10-31T09:00:00.000Z';
const kinds = { 'source-readiness': 'source-readiness-audit', 'model-readiness': 'model-readiness',
  'market-readiness': 'offline-market-readiness-audit', 'state-capacity': 'hosted-state-capacity' };
const ready = tool => ({ exitCode: 0, stdout: JSON.stringify({ version: 1, kind: kinds[tool], reportId: 'a'.repeat(64),
  releaseGate: 'GREEN', snapshot: tool === 'state-capacity' ? { withinLimits: true } : undefined }), stderr: '' });
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'audit-control-'));
  const stateRoot = join(root, 'inputs'), reportDir = join(stateRoot, 'reports'), outDir = join(root, 'audit');
  await mkdir(reportDir, { recursive: true }); await writeFile(join(reportDir, 'latest.json'), 'original-report');
  await mkdir(join(reportDir, 'forecast-ledger')); await writeFile(join(reportDir, 'forecast-ledger', 'retained.json'), 'unscored-prediction');
  t.after(() => rm(root, { recursive: true, force: true })); return { root, stateRoot, reportDir, outDir };
}

test('one broken tool still leaves all other evidence and a BLOCKED eight-role progress report', async t => {
  const paths = await workspace(t), called = [];
  const result = await runAuditControl(paths, { clock: () => NOW, runTool: async spec => {
    called.push(spec.id);
    if (spec.id === 'model-readiness') throw Error('private-transport-detail');
    if (spec.id === 'source-readiness') return { ...ready(spec.id), stdout: JSON.stringify({ version: 1, kind: kinds[spec.id], gaps: ['HISTORY_MISSING'] }) };
    if (spec.id === 'state-capacity') return { ...ready(spec.id), exitCode: 2, stdout: JSON.stringify({ version: 1, kind: kinds[spec.id], snapshot: { withinLimits: false }, warnings: ['CAPACITY_NEAR_LIMIT'] }) };
    return ready(spec.id);
  } });
  assert.deepEqual(called, Object.keys(kinds));
  assert.equal(result.exitCode, 2);
  assert.equal(result.audit.RELEASE_GATE, 'BLOCKED');
  assert.equal(result.audit.canRelease, false);
  assert.deepEqual(result.audit.summary, { tools: 4, completed: 3, failed: 1 });
  assert.equal(result.audit.checks[0].findingStatus, 'not-ready');
  assert.equal(result.audit.checks[1].executionStatus, 'failed');
  assert.equal(result.audit.checks[3].executionStatus, 'completed');
  assert.equal(result.audit.checks[3].findingStatus, 'blocked');
  assert.equal(result.audit.roles.length, 8);
  for (const id of ['A3', 'A6', 'A8']) assert.equal(result.audit.roles.find(role => role.id === id).status, 'not-audited');
  assert.equal(result.audit.roles.find(role => role.id === 'A7').status, 'blocked');
  assert.deepEqual(result.audit.roles.find(role => role.id === 'A7').evidence, ['state-capacity.json']);
  assert.ok(result.audit.roles.every(role => role.responsibility && role.nextStep && Array.isArray(role.evidence)));
  for (const check of result.audit.checks) {
    const contents = await readFile(join(paths.outDir, check.file));
    assert.equal(createHash('sha256').update(contents).digest('hex'), check.sha256);
    assert.ok(!contents.toString().includes('private-transport-detail'));
  }
  const progress = await readFile(join(paths.outDir, 'progress.md'), 'utf8');
  assert.match(progress, /RELEASE_GATE：BLOCKED/);
  assert.match(progress, /工具执行失败/);
  assert.match(progress, /本轮未核验/);
  assert.equal(await readFile(join(paths.reportDir, 'latest.json'), 'utf8'), 'original-report');
  assert.equal(await readFile(join(paths.reportDir, 'forecast-ledger/retained.json'), 'utf8'), 'unscored-prediction');
});

test('all child exits 0 still cannot turn the aggregate release gate green', async t => {
  const paths = await workspace(t);
  const result = await runAuditControl(paths, { clock: () => NOW, runTool: async spec => ready(spec.id) });
  assert.equal(result.audit.RELEASE_GATE, 'BLOCKED');
  assert.equal(result.audit.roles[0].status, 'blocked');
  assert.equal(result.exitCode, 2);
  assert.ok(result.audit.checks.every(check => check.releaseApproved === false));
});

test('malformed or failed child output is isolated and cannot be swallowed by another successful child', async t => {
  const paths = await workspace(t);
  const result = await runAuditControl(paths, { clock: () => NOW, runTool: async spec => {
    if (spec.id === 'source-readiness') return { exitCode: 0, stdout: 'not-json', stderr: 'unsafe-detail' };
    if (spec.id === 'model-readiness') return { ...ready(spec.id), exitCode: 1 };
    return ready(spec.id);
  } });
  assert.equal(result.audit.summary.failed, 2);
  assert.equal(result.audit.checks[0].errorCode, 'AUDIT_TOOL_JSON_INVALID');
  assert.equal(result.audit.checks[1].errorCode, 'AUDIT_TOOL_EXECUTION_FAILED');
  const evidence = await readFile(join(paths.outDir, 'source-readiness.json'), 'utf8');
  assert.ok(!evidence.includes('unsafe-detail'));
  assert.equal(JSON.parse(evidence).output.stderrBytes, Buffer.byteLength('unsafe-detail'));
  assert.equal(JSON.parse(await readFile(join(paths.outDir, 'market-readiness.json'), 'utf8')).evidence.kind, kinds['market-readiness']);
});

test('output may not overwrite inputs, ancestors, existing audits or symlink aliases into evidence', async t => {
  const paths = await workspace(t); let calls = 0;
  const dependencies = { runTool: async spec => { calls++; return ready(spec.id); }, clock: () => NOW };
  for (const outDir of [paths.reportDir, join(paths.reportDir, 'nested'), join(paths.stateRoot, 'new-output'), paths.root]) {
    await assert.rejects(runAuditControl({ ...paths, outDir }, dependencies), /AUDIT_OUTPUT_OVERLAPS_INPUT/);
  }
  await symlink(paths.stateRoot, join(paths.root, 'alias'));
  await assert.rejects(runAuditControl({ ...paths, outDir: join(paths.root, 'alias', 'nested') }, dependencies), /AUDIT_OUTPUT_OVERLAPS_INPUT/);
  assert.equal(calls, 0);
  await runAuditControl(paths, dependencies);
  const before = await readFile(join(paths.outDir, 'audit-control.json'), 'utf8');
  await assert.rejects(runAuditControl(paths, dependencies), /AUDIT_OUTPUT_EXISTS/);
  assert.equal(await readFile(join(paths.outDir, 'audit-control.json'), 'utf8'), before);
  assert.equal(calls, 4);
});

test('CLI preserves literal input paths and uses only the four fixed argument lists', async t => {
  const paths = await workspace(t), reportDir = join(paths.stateRoot, 'reports; $(touch PWNED)');
  await mkdir(reportDir); const seen = []; let output = '';
  const exit = await runAuditControlCli(['--report-dir', reportDir, '--state-root', paths.stateRoot, '--out', paths.outDir], {
    clock: () => NOW, stdout: value => { output += value; }, runTool: async spec => { seen.push(spec); return ready(spec.id); } });
  assert.equal(exit, 2);
  assert.equal(JSON.parse(output).RELEASE_GATE, 'BLOCKED');
  assert.deepEqual(seen[0].args, ['--report-dir', reportDir, '--as-of', NOW]);
  assert.deepEqual(seen[1].args, ['--ledger', join(reportDir, 'forecast-ledger'), '--horizon-hours', '24', '--now', NOW]);
  assert.deepEqual(seen[2].args, ['--report', join(reportDir, 'latest.json'), '--format', 'json', '--as-of', NOW]);
  assert.deepEqual(seen[3].args, ['--root', paths.stateRoot]);
  assert.ok(seen.every(spec => spec.script.endsWith(`/collector/${spec.id}.mjs`)));
  assert.ok(!(await readdir(paths.root)).includes('PWNED'));
});

test('help does not inspect inputs or create output, and unknown command options are rejected', async () => {
  let output = '', calls = 0;
  assert.equal(await runAuditControlCli(['--help'], { stdout: value => { output += value; }, runTool: () => { calls++; } }), 0);
  assert.match(output, /RELEASE_GATE always BLOCKED/); assert.equal(calls, 0);
  await assert.rejects(runAuditControlCli(['--command', 'touch unwanted']), /AUDIT_ARGUMENT_INVALID/);
  await assert.rejects(runAuditControlCli([]), /AUDIT_ARGUMENT_INVALID/);
});

function fakeChild(action) {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdout.setEncoding = child.stderr.setEncoding = () => {};
  child.kill = signal => { queueMicrotask(() => child.emit('close', null, signal)); return true; };
  if (action) queueMicrotask(() => action(child)); return child;
}
test('subprocess uses no shell or inherited credentials, and bounds hanging or excessive output', async () => {
  const spec = { script: '/fixed/read-only.mjs', args: ['--report', 'literal; $(touch PWNED)'] }; let invocation;
  const result = await executeAuditTool(spec, { spawnImpl: (...args) => {
    invocation = args; return fakeChild(child => { child.stdout.emit('data', '{}'); child.emit('close', 2, null); });
  } });
  assert.equal(invocation[0], process.execPath);
  assert.deepEqual(invocation[1], [spec.script, ...spec.args]);
  assert.equal(invocation[2].shell, false);
  assert.deepEqual(Object.keys(invocation[2].env).sort(), ['LANG', 'TZ']);
  assert.equal(result.exitCode, 2);
  const hanging = await executeAuditTool(spec, { timeoutMs: 5, spawnImpl: () => fakeChild() });
  assert.equal(hanging.errorCode, 'AUDIT_TOOL_TIMEOUT');
  const excessive = await executeAuditTool(spec, { maxOutputBytes: 2, spawnImpl: () => fakeChild(child => child.stdout.emit('data', 'too-long')) });
  assert.equal(excessive.errorCode, 'AUDIT_TOOL_OUTPUT_LIMIT');
});
