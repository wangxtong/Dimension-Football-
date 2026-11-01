import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, lstat, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkAgentTeam, readAgentRole, runAgentTeamCli } from '../../scripts/agent-team.mjs';

function manifest() {
  return { controller: 'A1', releaseGate: 'BLOCKED', commonPrompt: 'docs/agents/COMMON.md', progressTemplate: 'docs/agents/PROGRESS-TEMPLATE.md',
    execution: { mode: 'session-supervised', maxConcurrentAgents: 7, persistentBackgroundAgents: false, remoteOperationsOwner: 'A1' },
    roles: Array.from({ length: 8 }, (_, n) => ({ id: `A${n + 1}`, prompt: `docs/agents/A${n + 1}.md`, reviewer: n === 7 ? 'A1' : 'A8' })) };
}
async function save(root, path, text) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-team-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = manifest();
  await save(root, 'config/agent-team.json', JSON.stringify(config));
  await save(root, config.commonPrompt, '# 共同指令\n发布门禁持续阻断。\n');
  await save(root, config.progressTemplate, '# 进度模板\n');
  for (const role of config.roles) await save(root, role.prompt, `# ${role.id} 岗位\n仅展示文字，不执行 $(touch NOT_ALLOWED) 或启动任务。\n`);
  return { rootDirectory: root, config, async update() { await save(root, 'config/agent-team.json', JSON.stringify(config)); } };
}
async function snapshot(root, prefix = '') {
  const result = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name, metadata = await lstat(join(root, path));
    result.push({ path, size: metadata.size, mtimeMs: metadata.mtimeMs, directory: metadata.isDirectory() });
    if (metadata.isDirectory()) result.push(...await snapshot(root, path));
    else if (metadata.isFile()) result.push({ path, bytes: (await readFile(join(root, path))).toString('base64') });
  }
  return result;
}

test('the complete team is checked and selected text is returned literally without changing any repository file', async t => {
  const setup = await fixture(t); setup.config.architecture = { optional: 'A field this reader does not interpret' };
  setup.config.roles.reverse(); setup.config.roles[0].extra = { future: true }; await setup.update();
  const before = await snapshot(setup.rootDirectory), out = [], errors = [];
  const checked = await checkAgentTeam(setup); assert.equal(checked.status, 'valid'); assert.equal(checked.roleCount, 8);
  assert.equal(checked.releaseGate, 'BLOCKED'); assert.equal(checked.checkedFiles.length, 11);
  const text = await readAgentRole('A7', setup);
  assert.equal(text, '# 共同指令\n发布门禁持续阻断。\n\n# A7 岗位\n仅展示文字，不执行 $(touch NOT_ALLOWED) 或启动任务。\n');
  assert.equal(await runAgentTeamCli(['--check'], { ...setup, stdout: value => out.push(value), stderr: value => errors.push(value) }), 0);
  assert.equal(JSON.parse(out[0]).execution.persistentBackgroundAgents, false);
  assert.equal(await runAgentTeamCli(['--role', 'A7'], { ...setup, stdout: value => out.push(value), stderr: value => errors.push(value) }), 0);
  assert.equal(out[1], text); assert.deepEqual(errors, []); assert.deepEqual(await snapshot(setup.rootDirectory), before);
});

test('missing manifest, common prompt, template or role file cannot be reported as a complete team', async t => {
  for (const target of ['config/agent-team.json', 'docs/agents/COMMON.md', 'docs/agents/PROGRESS-TEMPLATE.md', 'docs/agents/A4.md']) {
    const setup = await fixture(t); await rm(join(setup.rootDirectory, target));
    await assert.rejects(checkAgentTeam(setup), { code: 'AGENT_TEAM_FILE_MISSING' });
  }
});

test('a prompt cannot escape the repository or silently become a non-Markdown or non-regular file', async t => {
  for (const unsafe of ['../outside.md', '/tmp/outside.md', 'docs/../outside.md', 'docs\\outside.md', 'C:/outside.md', 'docs/agents/A1.mjs']) {
    const setup = await fixture(t); setup.config.roles[0].prompt = unsafe; await setup.update();
    await assert.rejects(checkAgentTeam(setup), { code: 'AGENT_TEAM_UNSAFE_PATH' });
  }
  const setup = await fixture(t); await rm(join(setup.rootDirectory, setup.config.roles[0].prompt));
  await mkdir(join(setup.rootDirectory, setup.config.roles[0].prompt));
  await assert.rejects(checkAgentTeam(setup), { code: 'AGENT_TEAM_NOT_REGULAR_FILE' });
});

test('file and parent-directory symlinks are refused even when the target is readable', async t => {
  const outside = await fixture(t);
  for (const parentLink of [false, true]) {
    const setup = await fixture(t), target = join(setup.rootDirectory, parentLink ? 'docs/agents' : setup.config.roles[0].prompt);
    await rm(target, { recursive: true });
    await symlink(join(outside.rootDirectory, parentLink ? 'docs/agents' : outside.config.roles[0].prompt), target);
    await assert.rejects(checkAgentTeam(setup), { code: 'AGENT_TEAM_UNSAFE_PATH' });
  }
  const setup = await fixture(t), configPath = join(setup.rootDirectory, 'config/agent-team.json');
  await rm(configPath); await symlink(join(outside.rootDirectory, 'config/agent-team.json'), configPath);
  await assert.rejects(checkAgentTeam(setup), { code: 'AGENT_TEAM_UNSAFE_PATH' });
});

test('duplicates, missing roles and a substituted unknown role cannot satisfy the eight-role contract', async t => {
  for (const change of [config => { config.roles.pop(); }, config => { config.roles[7].id = 'A1'; }, config => { config.roles[7].id = 'A9'; }]) {
    const setup = await fixture(t); change(setup.config); await setup.update();
    await assert.rejects(checkAgentTeam(setup), { code: 'AGENT_TEAM_INVALID_ROLES' });
  }
});

test('self-review or an unassigned reviewer is rejected independently of valid role files', async t => {
  for (const reviewer of ['A7', 'A9', null]) {
    const setup = await fixture(t); setup.config.roles[6].reviewer = reviewer; await setup.update();
    await assert.rejects(checkAgentTeam(setup), { code: 'AGENT_TEAM_INVALID_REVIEWER' });
  }
});

test('controller, gate and supervision constraints cannot be changed while the reader reports valid', async t => {
  const cases = [
    [config => { config.controller = 'A2'; }, 'AGENT_TEAM_INVALID_CONTROLLER'],
    [config => { config.execution.remoteOperationsOwner = 'A7'; }, 'AGENT_TEAM_INVALID_CONTROLLER'],
    [config => { config.releaseGate = 'GREEN'; }, 'AGENT_TEAM_RELEASE_GATE_CHANGED'],
    [config => { config.execution.mode = 'unattended'; }, 'AGENT_TEAM_INVALID_EXECUTION_MODE'],
    [config => { config.execution.maxConcurrentAgents = 8; }, 'AGENT_TEAM_INVALID_EXECUTION_MODE'],
    [config => { config.execution.persistentBackgroundAgents = true; }, 'AGENT_TEAM_INVALID_EXECUTION_MODE'],
  ];
  for (const [change, code] of cases) {
    const setup = await fixture(t); change(setup.config); await setup.update(); await assert.rejects(checkAgentTeam(setup), { code });
  }
});

test('unknown roles and extra CLI instructions fail safely; help does not require any repository access', async () => {
  const output = [], errors = [], options = { rootDirectory: '/no-such-agent-team-root', stdout: value => output.push(value), stderr: value => errors.push(value) };
  assert.equal(await runAgentTeamCli(['--help'], options), 0); assert.match(output[0], /不会执行提示词/);
  await assert.rejects(readAgentRole('A9', options), { code: 'AGENT_TEAM_UNKNOWN_ROLE' });
  assert.equal(await runAgentTeamCli(['--role', 'A9'], options), 1); assert.equal(errors.pop(), 'AGENT_TEAM_UNKNOWN_ROLE\n');
  for (const args of [[], ['--check', '--role', 'A1'], ['--role', 'A1', '--root', '/tmp'], ['--run', 'touch'], ['--help', '--check']]) {
    assert.equal(await runAgentTeamCli(args, options), 1); assert.equal(errors.pop(), 'AGENT_TEAM_INVALID_ARGUMENTS\n');
  }
  assert.equal(output.length, 1);
});
