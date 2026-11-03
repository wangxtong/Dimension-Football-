import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const config = JSON.parse(await readFile(new URL('../../wrangler.jsonc',import.meta.url),'utf8'));
const pkg = JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'));
const build = await readFile(new URL('../../website/build.mjs',import.meta.url),'utf8');

test('Cloudflare Worker targets the generated self-contained website entry, not a Node server', () => {
  assert.equal(config.name,'dimension-football-research');
  assert.equal(config.main,'dist/server/index.js');
  assert.match(pkg.scripts['cloudflare:build'],/^node website\/build\.mjs dist$/);
  assert.match(build,/dist|server\/index\.js|server','index\.js/);
  assert.ok(!config.assets,'This Worker embeds assets in the generated ESM entry.');
});

test('Cloudflare Workers research deployment is fail-closed by default', () => {
  assert.equal(config.vars.HOSTED_PUBLICATION_ENABLED,'false');
  assert.equal(config.vars.VANTIS_RESEARCH_WEB_ENABLED,'false');
  assert.ok(!('RELEASE_GATE' in config.vars));
  assert.ok(!('routes' in config));
  assert.ok(!('route' in config));
  assert.ok(!('r2_buckets' in config),'R2 needs a separately authorized exact bucket.');
});

test('Cloudflare configuration carries no credentials, passwords, account identifiers or token placeholders', async () => {
  const raw = await readFile(new URL('../../wrangler.jsonc',import.meta.url),'utf8');
  for (const name of ['DASHBOARD_AUTH','DASHBOARD_SESSION_SECRET','CLOUDFLARE_API_TOKEN','CF_API_TOKEN','GITHUB_TOKEN','API_FOOTBALL_KEY']) {
    assert.ok(!raw.includes(name),name+' must be provisioned separately, never committed.');
  }
  assert.match(config.compatibility_date,/^20\d\d-\d\d-\d\d$/);
});
