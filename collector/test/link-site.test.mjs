import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { encryptSiteLink, decryptSiteLink, normalizeLinkOrigin, parseKnownToken, runLinkCli, LINK_ORIGIN } from '../../deploy/link-site.mjs';

// Ephemeral test-only keys. No real receiver key or server credential is created/read.
const receiver = () => {
  const keys = generateKeyPairSync('x25519');
  return { ...keys, recipient: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
};
const readToken = 'synthetic_read_token_for_unit_tests_0123456789', probeToken = 'ab'.repeat(32);
const settings = { REPORTS_ORIGIN: LINK_ORIGIN, REPORTS_READ_TOKEN: readToken, REPORTS_PROBE_TOKEN: probeToken };
const payload = { origin: LINK_ORIGIN, readToken, probeToken };
const unpack = value => JSON.parse(Buffer.from(value.slice('VANTIS_LINK1.'.length), 'base64url').toString('utf8'));
const pack = value => 'VANTIS_LINK1.' + Buffer.from(JSON.stringify(value)).toString('base64url');
function mutate(receipt, key) {
  const envelope = unpack(receipt), bytes = Buffer.from(envelope[key], 'base64url'); bytes[0] ^= 1;
  envelope[key] = bytes.toString('base64url'); return pack(envelope);
}

test('recipient-bound receipts round-trip in memory and use fresh ephemeral keys, salt and nonces', () => {
  const keys = receiver(), first = encryptSiteLink({ ...payload, recipient: keys.recipient }), second = encryptSiteLink({ ...payload, recipient: keys.recipient });
  assert.match(first, /^VANTIS_LINK1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(decryptSiteLink({ receipt: first, privateKey: keys.privateKey }), settings);
  assert.deepEqual(decryptSiteLink({ receipt: second + '\n', privateKey: keys.privateKey }), settings);
  assert.notEqual(first, second);
  for (const field of ['ephemeral', 'salt', 'nonce', 'ciphertext']) assert.notEqual(unpack(first)[field], unpack(second)[field]);
  for (const text of [first, JSON.stringify(unpack(first))]) {
    assert.ok(!text.includes(readToken)); assert.ok(!text.includes(probeToken));
    assert.ok(!text.includes('REPORTS_READ_TOKEN')); assert.ok(!text.includes('REPORTS_PROBE_TOKEN'));
  }
});

test('altered ciphertext, authentication metadata and recipient keys are rejected without plaintext', () => {
  const keys = receiver(), receipt = encryptSiteLink({ ...payload, recipient: keys.recipient });
  for (const field of ['ephemeral', 'salt', 'nonce', 'ciphertext', 'tag']) {
    assert.throws(() => decryptSiteLink({ receipt: mutate(receipt, field), privateKey: keys.privateKey }), { message: 'INVALID_SITE_LINK' });
  }
  assert.throws(() => decryptSiteLink({ receipt, privateKey: receiver().privateKey }), { message: 'INVALID_SITE_LINK' });
  for (const changes of [{ version: 2 }, { algorithm: 'none' }, { recipient: '00'.repeat(32) }, { extra: 'field' }]) {
    assert.throws(() => decryptSiteLink({ receipt: pack({ ...unpack(receipt), ...changes }), privateKey: keys.privateKey }), /INVALID_SITE_LINK/);
  }
  const duplicate = Buffer.from(JSON.stringify(unpack(receipt)).replace('"version":1', '"version":1,"version":1')).toString('base64url');
  assert.throws(() => decryptSiteLink({ receipt: 'VANTIS_LINK1.' + duplicate, privateKey: keys.privateKey }), /INVALID_SITE_LINK/);
});

test('only canonical X25519 SPKI recipients and the existing HTTPS report origin are accepted', () => {
  const keys = receiver();
  const wrongAlgorithm = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  for (const recipient of ['', 'not a key', keys.recipient + '\n', keys.recipient.replace(/=+$/, ''), wrongAlgorithm,
    Buffer.concat([Buffer.from(keys.recipient, 'base64'), Buffer.from([0])]).toString('base64')]) {
    assert.throws(() => encryptSiteLink({ ...payload, recipient }), /INVALID_SITE_LINK/);
  }
  assert.equal(normalizeLinkOrigin(LINK_ORIGIN.slice(0, -1)), LINK_ORIGIN);
  for (const origin of ['http://football.fotpredict.xyz/dimension-football/', 'https://evil.example/dimension-football/',
    'https://football.fotpredict.xyz.evil.example/dimension-football/', 'https://user:pass@football.fotpredict.xyz/dimension-football/',
    LINK_ORIGIN + '?token=private', LINK_ORIGIN + '#fragment', LINK_ORIGIN + 'other', 'https://football.fotpredict.xyz:444/dimension-football/',
    ' ' + LINK_ORIGIN, LINK_ORIGIN.replace('football/', 'foot\nball/'), 'not-url']) assert.throws(() => encryptSiteLink({ ...payload, recipient: keys.recipient, origin }), /INVALID_SITE_LINK/);
});

test('known-key parser accepts literal safe values and rejects duplicates, interpolation and invalid contracts', () => {
  assert.equal(parseKnownToken(`# comment\nOTHER_PRIVATE_KEY=ignored\nREPORTS_READ_TOKEN="${readToken}"\n`, 'REPORTS_READ_TOKEN'), readToken);
  assert.equal(parseKnownToken(`REPORTS_PROBE_TOKEN='${probeToken}'\r\n`, 'REPORTS_PROBE_TOKEN'), probeToken);
  assert.equal(parseKnownToken(`REPORTS_READ_TOKEN=${'x'.repeat(32)}`, 'REPORTS_READ_TOKEN').length, 32);
  assert.equal(parseKnownToken(`REPORTS_READ_TOKEN=${'x'.repeat(200)}`, 'REPORTS_READ_TOKEN').length, 200);
  for (const text of [`REPORTS_READ_TOKEN=${readToken}\nREPORTS_READ_TOKEN=${readToken}`, `export REPORTS_READ_TOKEN=${readToken}`,
    `REPORTS_READ_TOKEN=\${OTHER_PRIVATE_KEY}`, `REPORTS_READ_TOKEN=${'x'.repeat(31)}`, `REPORTS_READ_TOKEN=${'x'.repeat(201)}`,
    `REPORTS_READ_TOKEN=${readToken}#comment`, 'OTHER_PRIVATE_KEY=not-consumed']) {
    assert.throws(() => parseKnownToken(text, 'REPORTS_READ_TOKEN'), /INVALID_SITE_LINK/);
  }
  for (const value of ['AA'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33)]) assert.throws(() => parseKnownToken(`REPORTS_PROBE_TOKEN=${value}`, 'REPORTS_PROBE_TOKEN'), /INVALID_SITE_LINK/);
  assert.throws(() => parseKnownToken(`REPORTS_PROBE_TOKEN=${probeToken}\nREPORTS_PROBE_TOKEN=${probeToken}`, 'REPORTS_PROBE_TOKEN'), /INVALID_SITE_LINK/);
  assert.throws(() => parseKnownToken('OTHER_PRIVATE_KEY=not-consumed', 'OTHER_PRIVATE_KEY'), /INVALID_SITE_LINK/);
});

test('CLI reads exactly the two fixed files and emits only an encrypted receipt', async () => {
  const keys = receiver(), paths = [], out = [], err = [];
  const code = await runLinkCli(['--recipient', keys.recipient, '--origin', LINK_ORIGIN], {
    readEnv: async path => {
      paths.push(path);
      if (path === '/etc/vantis/report.env') return `UNRELATED_SECRET=not-consumed\nREPORTS_READ_TOKEN=${readToken}\n`;
      if (path === '/etc/vantis/collector.env') return `REPORTS_PROBE_TOKEN=${probeToken}\n`;
      assert.fail('unexpected credential path');
    }, stdout: value => out.push(value), stderr: value => err.push(value),
  });
  assert.equal(code, 0); assert.deepEqual(paths, ['/etc/vantis/report.env', '/etc/vantis/collector.env']);
  assert.equal(out.length, 1); assert.equal(err.length, 0); assert.match(out[0], /^VANTIS_LINK1\.[A-Za-z0-9_-]+\n$/);
  assert.deepEqual(decryptSiteLink({ receipt: out[0], privateKey: keys.privateKey }), settings);
  assert.ok(!out[0].includes(readToken)); assert.ok(!out[0].includes(probeToken)); assert.ok(!out[0].includes('not-consumed'));
});

test('CLI refuses decrypt, custom files, duplicate arguments and secret arguments before reading files', async () => {
  const keys = receiver();
  for (const args of [['--decrypt', 'VANTIS_LINK1.invalid'], ['--recipient', keys.recipient, '--recipient', keys.recipient],
    ['--recipient', keys.recipient, '--env-file', '/elsewhere'], ['--read-token', readToken, '--origin', LINK_ORIGIN],
    ['--recipient', keys.recipient, '--origin', 'https://evil.example/']]) {
    const out = [], err = [];
    const code = await runLinkCli(args, { readEnv: () => assert.fail('invalid request must not read credentials'), stdout: value => out.push(value), stderr: value => err.push(value) });
    assert.equal(code, 1); assert.deepEqual(out, []); assert.deepEqual(err, ['VANTIS_LINK_ERROR\n']);
  }
});

test('CLI errors never echo credentials, malformed env content or underlying exception messages', async () => {
  const keys = receiver();
  for (const readEnv of [async () => { throw Error(`sensitive=${readToken}/${probeToken}`); },
    async path => path.endsWith('/report.env') ? `REPORTS_READ_TOKEN=${readToken}\nREPORTS_READ_TOKEN=${readToken}` : `REPORTS_PROBE_TOKEN=${probeToken}`,
    async path => path.endsWith('/report.env') ? `REPORTS_READ_TOKEN=${readToken}` : `REPORTS_PROBE_TOKEN=${probeToken}invalid`]) {
    const out = [], err = [];
    assert.equal(await runLinkCli(['--origin', LINK_ORIGIN, '--recipient', keys.recipient], { readEnv, stdout: value => out.push(value), stderr: value => err.push(value) }), 1);
    assert.deepEqual(out, []); assert.deepEqual(err, ['VANTIS_LINK_ERROR\n']);
    assert.ok(!JSON.stringify({ out, err }).includes(readToken)); assert.ok(!JSON.stringify({ out, err }).includes(probeToken));
  }
});
