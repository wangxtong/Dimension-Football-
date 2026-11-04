import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');

test('VIP design has responsive navigation and the real-data release gates remain visible', async () => {
  const html = await read('index.html'), css = await read('premium-dashboard.css');
  assert.match(html, /class="vip-dashboard"/);
  assert.match(html, /href="\.\/premium-dashboard\.css"/);
  assert.match(html, /class="vip-banner"/);
  for (const id of ['count-fixtures', 'count-publishable', 'count-analysis', 'count-missing',
    'history-sample', 'history-accuracy', 'history-prospective', 'market-observation-state',
    'today-picks-count', 'delivery']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(css, /@media\(max-width:850px\)/);
  assert.match(css, /@media\(max-width:480px\)/);
  assert.match(css, /\.stats\{grid-template-columns:repeat\(2/);
  assert.match(html, /正式发布暂停/);
  assert.match(html, /0<\/strong>/);
});

test('the dashboard does not present external model or invented commercial performance', async () => {
  const html = await read('index.html'), css = await read('premium-dashboard.css');
  assert.doesNotMatch(html, /abcde-blackbox-reverse-audit|external-audit-note/);
  assert.doesNotMatch(html, /27\.45%|75\.0%|C模型.{0,14}运行正常/);
  assert.doesNotMatch(css, /27\.45%|75\.0%/);
  assert.doesNotMatch(html + css, /TELEGRAM_BOT_TOKEN\s*[:=]\s*\S+|gh[pousr]_[A-Za-z0-9]{20}/i);
});

test('premium CSS is embedded in the same protected Worker asset bundle', async () => {
  const build = await read('build.mjs'), worker = await read('worker.mjs');
  assert.match(build, /'premium-dashboard\.css'/);
  assert.match(build, /EMBEDDED_ASSETS/);
  assert.match(worker, /DASHBOARD_AUTH/);
  assert.doesNotMatch(build, /(?:password|token)\s*=\s*['"][^'"]{5,}['"]/i);
});
