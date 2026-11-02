import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKFLOW_URL = new URL('../../.github/workflows/live-publication.yml', import.meta.url);
const workflow = await readFile(WORKFLOW_URL, 'utf8');

// GitHub Actions 的 `&&`/`||` 返回第一个能判定结果的操作数（不是布尔值），`||` 优先级最低。
// 这里实现文档语义的最小求值器，用来对 workflow 里真实写着的表达式做回归断言。
function tokenize(expression) {
  const tokens = [];
  let index = 0;
  while (index < expression.length) {
    const rest = expression.slice(index);
    const space = /^\s+/.exec(rest);
    if (space) { index += space[0].length; continue; }
    const string = /^'((?:[^']|'')*)'/.exec(rest);
    if (string) { tokens.push({ type: 'literal', value: string[1].replace(/''/g, "'") }); index += string[0].length; continue; }
    const number = /^-?\d+(?:\.\d+)?/.exec(rest);
    if (number) { tokens.push({ type: 'literal', value: Number(number[0]) }); index += number[0].length; continue; }
    const operator = /^(?:&&|\|\||==|!=|!|\(|\)|,)/.exec(rest);
    if (operator) { tokens.push({ type: 'operator', value: operator[0] }); index += operator[0].length; continue; }
    const bare = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(rest);
    if (bare) { tokens.push({ type: 'bare', value: bare[0] }); index += bare[0].length; continue; }
    throw new Error('UNSUPPORTED_EXPRESSION_TOKEN:' + rest.slice(0, 12));
  }
  return tokens;
}

function truthy(value) {
  return !(value === false || value === 0 || value === '' || value === null || value === undefined);
}

function evaluateExpression(expression, context) {
  const tokens = tokenize(expression);
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const expect = value => { const token = take(); assert.equal(token?.value, value, 'expected ' + value); };
  function parseOr() {
    let value = parseAnd();
    while (peek()?.type === 'operator' && peek().value === '||') { take(); const right = parseAnd(); value = truthy(value) ? value : right; }
    return value;
  }
  function parseAnd() {
    let value = parseEquality();
    while (peek()?.type === 'operator' && peek().value === '&&') { take(); const right = parseEquality(); value = truthy(value) ? right : value; }
    return value;
  }
  function parseEquality() {
    let value = parseUnary();
    while (peek()?.type === 'operator' && (peek().value === '==' || peek().value === '!=')) {
      const operator = take().value;
      const right = parseUnary();
      const equal = typeof value === 'string' && typeof right === 'string'
        ? value.toLowerCase() === right.toLowerCase() : value === right;
      value = operator === '==' ? equal : !equal;
    }
    return value;
  }
  function parseUnary() {
    if (peek()?.type === 'operator' && peek().value === '!') { take(); return !truthy(parseUnary()); }
    return parsePrimary();
  }
  function parsePrimary() {
    const token = take();
    if (token?.type === 'operator' && token.value === '(') { const value = parseOr(); expect(')'); return value; }
    if (token?.type === 'literal') return token.value;
    if (token?.type === 'bare') {
      if (peek()?.type === 'operator' && peek().value === '(') {
        take();
        if (token.value === 'always') { expect(')'); return true; }
        if (token.value === 'success') { expect(')'); return truthy(context.success); }
        if (token.value === 'failure') { expect(')'); return !truthy(context.success); }
        throw new Error('UNSUPPORTED_EXPRESSION_FUNCTION:' + token.value);
      }
      const path = token.value.split('.');
      let value = context;
      for (const key of path) value = value?.[key];
      return value;
    }
    throw new Error('UNEXPECTED_EXPRESSION_TOKEN:' + String(token?.value));
  }
  const value = parseOr();
  assert.equal(position, tokens.length, 'expression not fully consumed');
  return value;
}

function steps() {
  const lines = workflow.split('\n');
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) if (/^ {6}- (?:name|uses):/.test(lines[index])) starts.push(index);
  return starts.map((start, position) => {
    const end = position + 1 < starts.length ? starts[position + 1] : lines.length;
    return { text: lines.slice(start, end).join('\n') };
  });
}
function step(needle) {
  const found = steps().find(item => item.text.includes(needle));
  assert.ok(found, 'workflow step not found: ' + needle);
  return found;
}
function field(block, key) {
  const line = (typeof block === 'string' ? block : block.text).split('\n').find(row => row.startsWith('        ' + key + ':'));
  return line ? line.slice(('        ' + key + ':').length).trim() : null;
}
function heredoc(name) {
  const lines = workflow.split('\n');
  const open = lines.findIndex(line => line.includes("<<'" + name + "'"));
  assert.ok(open >= 0, 'heredoc not found: ' + name);
  const body = [];
  for (let index = open + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === name) return body.join('\n');
    assert.ok(lines[index] === '' || lines[index].startsWith('          '), 'heredoc line not inside the YAML block: ' + name);
    body.push(lines[index].slice(10));
  }
  throw new Error('heredoc not closed: ' + name);
}
function textField(block, key, indent) {
  const prefix = ' '.repeat(indent) + key + ':';
  const line = (typeof block === 'string' ? block : block.text).split('\n').find(row => row.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

const HOSTED_MODE_EXPRESSION = /HOSTED_MODE: \$\{\{ (.+?) \}\}/.exec(workflow)?.[1];
const SCHEDULE_1010 = { github: { event_name: 'schedule', event: { schedule: '10 2 * * *' } }, inputs: { mode: '' } };
const SCHEDULE_FIVE_MINUTES = { github: { event_name: 'schedule', event: { schedule: '*/5 * * * *' } }, inputs: { mode: '' } };

test('北京时间 10:10 的定时运行解析为 research，5 分钟采集仍解析为 observations', () => {
  assert.ok(HOSTED_MODE_EXPRESSION, 'workflow must keep an explicit HOSTED_MODE expression');
  assert.equal(evaluateExpression(HOSTED_MODE_EXPRESSION, SCHEDULE_1010), 'research');
  assert.equal(evaluateExpression(HOSTED_MODE_EXPRESSION, SCHEDULE_FIVE_MINUTES), 'observations');
  assert.equal(evaluateExpression(HOSTED_MODE_EXPRESSION,
    { github: { event_name: 'workflow_dispatch', event: { schedule: undefined } }, inputs: { mode: 'research' } }), 'research');
  assert.equal(evaluateExpression(HOSTED_MODE_EXPRESSION,
    { github: { event_name: 'workflow_dispatch', event: { schedule: undefined } }, inputs: { mode: 'observations' } }), 'observations');
  assert.equal(evaluateExpression(HOSTED_MODE_EXPRESSION,
    { github: { event_name: 'push', event: { schedule: undefined } }, inputs: {} }), 'observations');
});

test('两个 cron 都在位，且 10:10 运行期断言在采集前执行', () => {
  assert.match(workflow, /- cron: '\*\/5 \* \* \* \*'/);
  assert.match(workflow, /- cron: '10 2 \* \* \*'/);
  const guard = step('记录调度来源与运行模式（10:10 定时必须解析为 research）');
  const guardRun = guard.text;
  assert.ok(guardRun.includes('RESEARCH_MODE_MISMATCH'), '10:10 解析错配必须失败（不能静默变成 observations）');
  assert.ok(guardRun.includes('RESEARCH_MODE_UNEXPECTED'), '5 分钟采集不得误入 research');
  assert.ok(workflow.indexOf('记录调度来源与运行模式') < workflow.indexOf('恢复持久状态、分层采集并核验原站点'),
    '模式断言必须先于采集步骤');
});

test('research 步骤顺序为 报告→门禁→Web→Telegram，Telegram 不依赖 Web 成功', () => {
  const order = ['研究轨道生成每日1X2冻结快照', '核验研究日报：0 场', '将研究日报同步至受保护Web', '研究日报推送到Telegram'];
  const positions = order.map(name => workflow.indexOf(name));
  assert.ok(positions.every(position => position >= 0), 'all research steps must exist');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'research steps must keep the expected order');

  const web = step('将研究日报同步至受保护Web');
  assert.match(field(web, 'if'), /success\(\)/);
  assert.ok(!field(web, 'if').includes('always()'), 'Web 同步保持 success() 语义');

  const push = step('研究日报推送到Telegram');
  const pushIf = field(push, 'if');
  assert.ok(pushIf.includes('always()'), 'Telegram 推送必须用 always() 与 Web 同步解耦');
  assert.ok(!pushIf.includes('success()'), 'Telegram 推送不得被 Web 步骤失败连带跳过');
  const context = {
    env: { HOSTED_MODE: 'research' },
    vars: { VANTIS_RESEARCH_TELEGRAM_ENABLED: 'true' },
    steps: {
      research_report_gate: { outcome: 'success' },
      telegram_delivery_cache: { outputs: { 'cache-hit': 'false' } },
    },
    success: false,
  };
  assert.equal(evaluateExpression(pushIf.replace(/^if:\s*/, ''), context), true, 'Web 失败时 Telegram 步骤仍应执行');
  assert.equal(evaluateExpression(pushIf.replace(/^if:\s*/, ''), { ...context, env: { HOSTED_MODE: 'observations' } }), false);
  assert.equal(evaluateExpression(pushIf.replace(/^if:\s*/, ''),
    { ...context, vars: { VANTIS_RESEARCH_TELEGRAM_ENABLED: 'false' } }), false);
  assert.equal(evaluateExpression(pushIf.replace(/^if:\s*/, ''),
    { ...context, steps: { ...context.steps, research_report_gate: { outcome: 'failure' } } }), false,
  '报告门禁失败时不得推送');
  assert.equal(evaluateExpression(pushIf.replace(/^if:\s*/, ''),
    { ...context, steps: { ...context.steps, telegram_delivery_cache: { outputs: { 'cache-hit': 'true' } } } }), false,
  '当天已送达时必须跳过重复推送');
});

test('同日幂等标记保存在 Actions 缓存，键使用报告自身的北京时间日期', () => {
  const restore = step('恢复研究日报当日送达标记');
  const save = step('保存研究日报当日送达标记');
  assert.equal(field(restore, 'uses') ?? textField(restore, 'uses', 8), 'actions/cache/restore@v4');
  assert.equal(field(save, 'uses') ?? textField(save, 'uses', 8), 'actions/cache/save@v4');
  for (const block of [restore, save]) {
    assert.match(block.text, /key: research-telegram-\$\{\{ steps\.research_report_gate\.outputs\.beijingDay \}\}/);
    assert.match(block.text, /path: \$\{\{ runner\.temp \}\}\/research-delivery/);
  }
  assert.match(field(restore, 'if'), /steps\.research_report_gate\.outcome == 'success'/);
  assert.match(field(save, 'if'), /steps\.telegram_delivery_check\.outcome == 'success'/);
  assert.match(field(save, 'if'), /always\(\)/);
});

test('Telegram 送达核验脚本：accepted 通过并记录 messageId，failed/unknown/缺失必须失败', async t => {
  const script = heredoc('TELEGRAM_DELIVERY_CHECK');
  const directory = await mkdtemp(join(tmpdir(), 'telegram-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scriptPath = join(directory, 'check.mjs');
  await writeFile(scriptPath, script);
  const run = payload => {
    const resultFile = join(directory, 'telegram-delivery.json');
    return (async () => {
      if (payload === undefined) await rm(resultFile, { force: true });
      else await writeFile(resultFile, JSON.stringify(payload) + '\n');
      const outputFile = join(directory, 'github-output.txt');
      try {
        const stdout = execFileSync(process.execPath, [scriptPath], {
          env: { ...process.env, RUNNER_TEMP: directory, GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: join(directory, 'summary.md') },
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, stdout, outputFile };
      } catch (error) {
        return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), outputFile };
      }
    })();
  };
  assert.equal((await run({ status: 'accepted', code: undefined, messageId: 42, channel: 'rich', beijingDay: '2026-11-02', reportId: 'a'.repeat(64) })).code, 0);
  assert.equal(JSON.parse(await readFile(join(directory, 'research-delivery/marker.json'), 'utf8')).messageId, 42);
  assert.match(await readFile(join(directory, 'github-output.txt'), 'utf8'), /delivered=true/);
  assert.equal((await run({ status: 'skipped', code: 'ALREADY_SENT_TODAY', beijingDay: '2026-11-02', reportId: 'a'.repeat(64) })).code, 0);
  const failed = await run({ status: 'failed', code: 'TELEGRAM_API_REJECTED', httpStatus: 400, channel: 'plain', beijingDay: '2026-11-02', reportId: 'a'.repeat(64) });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /TELEGRAM_DELIVERY_NOT_ACCEPTED/);
  assert.equal((await run({ status: 'unknown', code: 'TELEGRAM_RECEIPT_UNVERIFIED', beijingDay: '2026-11-02', reportId: 'a'.repeat(64) })).code, 1);
  assert.equal((await run({ status: 'accepted', beijingDay: '2026-11-02', reportId: 'a'.repeat(64) })).code, 1, 'accepted 必须带整数 messageId');
  assert.equal((await run(undefined)).code, 1, '结果文件缺失必须失败，不能当成功');
});

test('研究日报门禁脚本：只有真实 0 场或真实冻结名单允许推送', async t => {
  const script = heredoc('RESEARCH_REPORT_GATE');
  const directory = await mkdtemp(join(tmpdir(), 'research-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scriptPath = join(directory, 'gate.mjs');
  await writeFile(scriptPath, script);
  const root = join(directory, 'root');
  const reports = join(root, 'reports/research-daily');
  await mkdir(reports, { recursive: true });
  const base = { kind: 'research-daily-1x2', mode: 'research-reference', commercialReleaseGate: 'BLOCKED',
    strictMarkets: { releasedCandidates: 0 }, beijingDay: '2026-11-02', reportId: 'a'.repeat(64) };
  const run = payload => {
    return (async () => {
      if (payload === undefined) await rm(join(reports, 'latest.json'), { force: true });
      else await writeFile(join(reports, 'latest.json'), JSON.stringify(payload) + '\n');
      const outputFile = join(directory, 'github-output.txt');
      await rm(outputFile, { force: true });
      try {
        const stdout = execFileSync(process.execPath, [scriptPath], {
          env: { ...process.env, RESEARCH_ROOT: root, GITHUB_OUTPUT: outputFile },
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, stdout };
      } catch (error) {
        return { code: error.status ?? 1, stderr: String(error.stderr ?? '') };
      }
    })();
  };
  const zero = await run({ ...base, state: 'zero-qualified-forecasts', forecasts: { total: 0, candidates: [] } });
  assert.equal(zero.code, 0, '真实 0 场必须允许推送');
  assert.match(zero.stdout, /36 小时窗口内无合格场次/);
  assert.match(await readFile(join(directory, 'github-output.txt'), 'utf8'), /beijingDay=2026-11-02/);
  const frozen = await run({ ...base, state: 'frozen-research-forecasts', forecasts: { total: 1, candidates: [{ fixtureId: 'f1' }] } });
  assert.equal(frozen.code, 0);
  assert.match(frozen.stdout, /今日有合格研究场次/);
  for (const state of ['no-today-source-report', 'ledger-not-restored']) {
    const rejected = await run({ ...base, state, forecasts: { total: 0, candidates: [] } });
    assert.equal(rejected.code, 1, '异常状态不得伪装成 0 场推送: ' + state);
    assert.match(rejected.stderr, /RESEARCH_REPORT_STATE_NOT_DELIVERABLE/);
  }
  assert.equal((await run({ ...base, state: 'frozen-research-forecasts', forecasts: { total: 0, candidates: [] } })).code, 1);
  assert.equal((await run({ ...base, state: 'zero-qualified-forecasts', forecasts: { total: 1, candidates: [] } })).code, 1);
  assert.equal((await run({ ...base, state: 'zero-qualified-forecasts', commercialReleaseGate: 'RELEASED', forecasts: { total: 0, candidates: [] } })).code, 1);
  assert.equal((await run(undefined)).code, 1, '报告缺失必须失败而不是静默跳过');
});

test('Telegram 只读预检在缺少凭据时不发网络请求', async t => {
  const script = heredoc('TELEGRAM_PREFLIGHT');
  const directory = await mkdtemp(join(tmpdir(), 'telegram-preflight-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scriptPath = join(directory, 'preflight.mjs');
  await writeFile(scriptPath, script);
  const stdout = execFileSync(process.execPath, [scriptPath], {
    env: { ...process.env, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(stdout, /TELEGRAM_CREDENTIALS_REQUIRED/);
});

test('workflow 不内联任何 Telegram 凭据，只从 secrets 注入', () => {
  assert.ok(!/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/.test(workflow), 'workflow 不得包含机器人令牌');
  for (const block of [step('Telegram 通道只读预检'), step('研究日报推送到Telegram')]) {
    assert.match(block.text, /TELEGRAM_BOT_TOKEN: \$\{\{ secrets\.TELEGRAM_BOT_TOKEN \}\}/);
    assert.match(block.text, /TELEGRAM_CHAT_ID: \$\{\{ secrets\.TELEGRAM_CHAT_ID \}\}/);
  }
});
