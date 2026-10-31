#!/usr/bin/env node
import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const LINK_ORIGIN = 'https://football.fotpredict.xyz/dimension-football/';
export const LINK_CONTEXT = 'VANTIS_LINK1:X25519:HKDF-SHA256:AES-256-GCM';
const PREFIX = 'VANTIS_LINK1.', ALGORITHM = 'X25519-HKDF-SHA256-AES-256-GCM';
const READ_PATH = '/etc/vantis/report.env', PROBE_PATH = '/etc/vantis/collector.env';
const schemas = { REPORTS_READ_TOKEN: /^[A-Za-z0-9_-]{32,200}$/, REPORTS_PROBE_TOKEN: /^[a-f0-9]{64}$/ };
const fail = () => { throw new Error('INVALID_SITE_LINK'); };

export function normalizeLinkOrigin(value) {
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u0020\u007f]/u.test(value)) fail();
  let url; try { url = new URL(value); } catch { fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.hostname !== 'football.fotpredict.xyz' || url.port
    || !['/dimension-football', '/dimension-football/'].includes(url.pathname)) fail();
  return LINK_ORIGIN;
}

function publicKey(recipient) {
  if (typeof recipient !== 'string' || recipient.length > 128 || !/^[A-Za-z0-9+/]+={0,2}$/.test(recipient)) fail();
  const der = Buffer.from(recipient, 'base64');
  if (der.toString('base64') !== recipient) fail();
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'x25519' || !der.equals(key.export({ type: 'spki', format: 'der' }))) fail();
  return { key, der };
}
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');
function derive(privateKey, remoteKey, salt, recipientDer, ephemeralDer) {
  const shared = diffieHellman({ privateKey, publicKey: remoteKey });
  try { return Buffer.from(hkdfSync('sha256', shared, salt,
    Buffer.concat([Buffer.from(LINK_CONTEXT, 'utf8'), recipientDer, ephemeralDer]), 32)); }
  finally { shared.fill(0); }
}
function configuration({ origin, readToken, probeToken }) {
  if (!schemas.REPORTS_READ_TOKEN.test(readToken || '') || !schemas.REPORTS_PROBE_TOKEN.test(probeToken || '')
    || typeof readToken !== 'string' || typeof probeToken !== 'string') fail();
  return { REPORTS_ORIGIN: normalizeLinkOrigin(origin), REPORTS_READ_TOKEN: readToken, REPORTS_PROBE_TOKEN: probeToken };
}

/** Pure in-memory encryption; the recipient is a base64 DER SPKI X25519 public key. */
export function encryptSiteLink({ recipient, origin, readToken, probeToken }) {
  let key, plaintext;
  try {
    const payload = configuration({ origin, readToken, probeToken });
    const receiver = publicKey(recipient), ephemeral = generateKeyPairSync('x25519');
    const ephemeralDer = ephemeral.publicKey.export({ type: 'spki', format: 'der' });
    const salt = randomBytes(32), nonce = randomBytes(12);
    const header = { version: 1, algorithm: ALGORITHM, recipient: fingerprint(receiver.der),
      ephemeral: ephemeralDer.toString('base64url'), salt: salt.toString('base64url'), nonce: nonce.toString('base64url') };
    key = derive(ephemeral.privateKey, receiver.key, salt, receiver.der, ephemeralDer);
    plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify(header), 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = { ...header, ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
    return PREFIX + Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
  } catch { fail(); }
  finally { key?.fill(0); plaintext?.fill(0); }
}

function decodeBase64url(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value || length !== undefined && bytes.length !== length) fail();
  return bytes;
}

/** Returns credentials to the calling process only. There is intentionally no decrypt CLI. */
export function decryptSiteLink({ receipt, privateKey }) {
  let key, plaintext;
  try {
    if (typeof receipt !== 'string' || receipt.length > 8192 || privateKey?.type !== 'private' || privateKey.asymmetricKeyType !== 'x25519') fail();
    const text = receipt.trim();
    if (!text.startsWith(PREFIX)) fail();
    const serialized = decodeBase64url(text.slice(PREFIX.length)).toString('utf8'), envelope = JSON.parse(serialized);
    const header = { version: envelope.version, algorithm: envelope.algorithm, recipient: envelope.recipient,
      ephemeral: envelope.ephemeral, salt: envelope.salt, nonce: envelope.nonce };
    if (envelope.version !== 1 || envelope.algorithm !== ALGORITHM
      || JSON.stringify({ ...header, ciphertext: envelope.ciphertext, tag: envelope.tag }) !== serialized) fail();
    const recipientDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    if (fingerprint(recipientDer) !== envelope.recipient) fail();
    const ephemeralDer = decodeBase64url(envelope.ephemeral, 44);
    const ephemeral = publicKey(ephemeralDer.toString('base64')).key;
    const salt = decodeBase64url(envelope.salt, 32), nonce = decodeBase64url(envelope.nonce, 12);
    const ciphertext = decodeBase64url(envelope.ciphertext), tag = decodeBase64url(envelope.tag, 16);
    key = derive(privateKey, ephemeral, salt, recipientDer, ephemeralDer);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(JSON.stringify(header), 'utf8')); decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const value = JSON.parse(plaintext.toString('utf8'));
    const clean = configuration({ origin: value.REPORTS_ORIGIN, readToken: value.REPORTS_READ_TOKEN, probeToken: value.REPORTS_PROBE_TOKEN });
    if (JSON.stringify(clean) !== plaintext.toString('utf8')) fail();
    return clean;
  } catch { fail(); }
  finally { key?.fill(0); plaintext?.fill(0); }
}

/** Only the explicitly requested known key is parsed; other variables are ignored. */
export function parseKnownToken(text, name) {
  if (!Object.hasOwn(schemas, name) || typeof text !== 'string' || Buffer.byteLength(text) > 65536) fail();
  const declaration = new RegExp(`^\\s*(?:export\\s+)?${name}(?:\\s|=|$)`), assignment = new RegExp(`^\\s*${name}\\s*=(.*)$`);
  let token, count = 0;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!declaration.test(line)) continue;
    count++;
    const match = line.match(assignment); if (!match) fail();
    let value = match[1].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.length < 2 || value.at(-1) !== value[0]) fail();
      value = value.slice(1, -1);
    }
    if (!schemas[name].test(value)) fail();
    token = value;
  }
  if (count !== 1) fail();
  return token;
}

async function readFixedEnv(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65536) fail();
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

/** Dependency injection is for offline tests; CLI paths cannot be overridden. */
export async function runLinkCli(args, { readEnv = readFixedEnv, stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value) } = {}) {
  try {
    if (!Array.isArray(args) || args.length !== 4) fail();
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--recipient', '--origin'].includes(args[i]) || Object.hasOwn(options, args[i])) fail();
      options[args[i]] = args[i + 1];
    }
    const origin = normalizeLinkOrigin(options['--origin']);
    publicKey(options['--recipient']); // Reject invalid requests before opening env files.
    const readToken = parseKnownToken(await readEnv(READ_PATH), 'REPORTS_READ_TOKEN');
    const probeToken = parseKnownToken(await readEnv(PROBE_PATH), 'REPORTS_PROBE_TOKEN');
    const receipt = encryptSiteLink({ recipient: options['--recipient'], origin, readToken, probeToken });
    stdout(`${receipt}\n`);
    return 0;
  } catch {
    stderr('VANTIS_LINK_ERROR\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runLinkCli(process.argv.slice(2));
