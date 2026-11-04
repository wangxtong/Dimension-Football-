import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const asset = name => readFile(join(root,name),'utf8');

test('dashboard keeps existing data bindings and exposes complete fast navigation', async () => {
  const page = await asset('index.html');
  for(const id of ['count-fixtures','count-publishable','count-analysis','count-missing','today-picks-count','pick-blockers','market-source-table','market-paired-count','market-opening-gap','experiment-input','history-sample','league-overview','cards','delivery','coverage','sync-status','warning','top-report-id','top-report-generated']) {
    assert.match(page,new RegExp(`id="${id}"`),id);
  }
  for(const href of ['#matches','#backtest','#market-observation','#status']) assert.ok(page.includes(`href="${href}"`),href);
  assert.match(page, /data-view="schedule"/);
  assert.match(page, /data-view="analysis"/);
  assert.match(page, /data-view="strict"/);
  assert.match(page, /data-view="missing"/);
  assert.match(page, /role="tablist"/);
  assert.match(page, /aria-live="polite"/);
});

test('site layout is responsive and accessible in reduced-motion mode', async () => {
  const css = await asset('style.css');
  for(const selector of ['.quick-actions','.intro','.view-explainer','.market-observation-panel','.table-scroll','.sidebar','.league-overview','.top-report-meta']) assert.ok(css.includes(selector),selector);
  assert.match(css, /@media\s*\(max-width:\s*600px\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /--gold:/);
});

test('research daily preserves no-advice gate and report-driven metrics', async () => {
  const page = await asset('research-daily.html');
  const script = await asset('research-daily-client.mjs');
  for(const id of ['forecasts','review','strict-rules','forecast-rows','results-rows','metrics','status','meta']) assert.match(page,new RegExp(`id="${id}"`));
  assert.match(page, /非投注建议/);
  assert.match(page, /id="refresh"/);
  assert.match(script, /commercialReleaseGate!=='BLOCKED'/);
  assert.match(script, /externalTelegramSent!==false/);
  assert.match(script, /prob-leading/);
  assert.match(script, /textContent/);
});

test('UI layer never embeds dashboard access credentials', async () => {
  const joined=(await Promise.all(['index.html','style.css','app.mjs','research-daily.html','research-daily-client.mjs'].map(asset))).join('\n');
  assert.doesNotMatch(joined, /password\s*[:=]\s*['"][^'"]{3,}/i);
  assert.doesNotMatch(joined, /<input\b[^>]*\btype=['"]password/i);
  assert.doesNotMatch(joined, /TELEGRAM_BOT_TOKEN\s*[:=]\s*['"][^'"]+/);
});
