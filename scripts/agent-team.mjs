import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_ROLE_IDS = Object.freeze(Array.from({ length: 8 }, (_, i) => `A${i + 1}`));
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'config/agent-team.json';
const FILE_LIMIT = 1024 * 1024;
const HELP = '用法：node scripts/agent-team.mjs --check | --role A1..A8 | --help\n只读检查八岗位配置或输出 COMMON 与岗位文本；不会执行提示词、联网或启动后台智能体。\n';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function failure(code, field = null) {
  throw Object.assign(new Error(field ? `${code}: ${field}` : code), { code, field });
}
function relativePath(path, field, markdown) {
  if (typeof path !== 'string' || !path || path.length > 1024 || isAbsolute(path) || /^[A-Za-z]:/.test(path)
    || /[\\\u0000-\u001f\u007f]/u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')
    || markdown && !/\.md$/i.test(path)) failure('AGENT_TEAM_UNSAFE_PATH', field);
  return path;
}
async function repositoryRoot(directory) {
  if (typeof directory !== 'string' || !directory) failure('AGENT_TEAM_INVALID_ROOT');
  const path = resolve(directory);
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) failure('AGENT_TEAM_INVALID_ROOT');
    return await realpath(path);
  } catch (error) {
    if (error?.code?.startsWith('AGENT_TEAM_')) throw error;
    failure('AGENT_TEAM_INVALID_ROOT');
  }
}
/** Read a regular repository file without following symlinks in any component. */
async function readRepositoryFile(root, relative, field, { markdown = false, limit = FILE_LIMIT } = {}) {
  relativePath(relative, field, markdown);
  const destination = resolve(root, relative);
  if (!destination.startsWith(root + sep)) failure('AGENT_TEAM_UNSAFE_PATH', field);
  let path = root, metadata;
  try {
    const components = relative.split('/');
    for (let i = 0; i < components.length; i++) {
      path = resolve(path, components[i]); metadata = await lstat(path);
      if (metadata.isSymbolicLink()) failure('AGENT_TEAM_UNSAFE_PATH', field);
      if (i === components.length - 1 ? !metadata.isFile() : !metadata.isDirectory()) failure('AGENT_TEAM_NOT_REGULAR_FILE', field);
    }
    if (await realpath(destination) !== destination) failure('AGENT_TEAM_UNSAFE_PATH', field);
    const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.dev !== metadata.dev || before.ino !== metadata.ino) failure('AGENT_TEAM_FILE_CHANGED', field);
      if (before.size > limit) failure('AGENT_TEAM_FILE_TOO_LARGE', field);
      const bytes = await file.readFile(), after = await file.stat();
      if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) failure('AGENT_TEAM_FILE_CHANGED', field);
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { failure('AGENT_TEAM_INVALID_UTF8', field); }
    } finally { await file.close(); }
  } catch (error) {
    if (error?.code?.startsWith('AGENT_TEAM_')) throw error;
    failure(error?.code === 'ENOENT' ? 'AGENT_TEAM_FILE_MISSING' : 'AGENT_TEAM_FILE_UNREADABLE', field);
  }
}
function validateManifest(manifest) {
  if (!object(manifest) || !Array.isArray(manifest.roles)) failure('AGENT_TEAM_INVALID_MANIFEST');
  if (manifest.controller !== 'A1' || manifest.execution?.remoteOperationsOwner !== 'A1') failure('AGENT_TEAM_INVALID_CONTROLLER');
  if (manifest.releaseGate !== 'BLOCKED') failure('AGENT_TEAM_RELEASE_GATE_CHANGED');
  if (!object(manifest.execution) || manifest.execution.mode !== 'session-supervised'
    || manifest.execution.maxConcurrentAgents !== 7 || manifest.execution.persistentBackgroundAgents !== false)
    failure('AGENT_TEAM_INVALID_EXECUTION_MODE');
  const ids = manifest.roles.map(role => role?.id);
  if (ids.length !== 8 || new Set(ids).size !== 8 || ids.some(id => !AGENT_ROLE_IDS.includes(id))) failure('AGENT_TEAM_INVALID_ROLES');
  for (const role of manifest.roles) {
    if (!object(role) || !AGENT_ROLE_IDS.includes(role.reviewer) || role.reviewer === role.id) failure('AGENT_TEAM_INVALID_REVIEWER', role.id);
  }
  return manifest;
}
async function loadAgentTeam({ rootDirectory = DEFAULT_ROOT } = {}) {
  const root = await repositoryRoot(rootDirectory);
  const text = await readRepositoryFile(root, MANIFEST, 'manifest', { limit: 256 * 1024 });
  let manifest;
  try { manifest = JSON.parse(text); } catch { failure('AGENT_TEAM_INVALID_MANIFEST'); }
  validateManifest(manifest);
  const references = [
    { field: 'commonPrompt', path: manifest.commonPrompt },
    { field: 'progressTemplate', path: manifest.progressTemplate },
    ...manifest.roles.map(role => ({ field: `${role.id}.prompt`, path: role.prompt })),
  ];
  const documents = new Map(await Promise.all(references.map(async reference => [reference.field,
    await readRepositoryFile(root, reference.path, reference.field, { markdown: true })])));
  return { manifest, references, documents };
}

/** Configuration validation only; this result does not grant publication or execution authority. */
export async function checkAgentTeam(options = {}) {
  const { manifest, references } = await loadAgentTeam(options);
  return { version: 1, status: 'valid', controller: 'A1', roleCount: 8, roleIds: [...AGENT_ROLE_IDS], releaseGate: 'BLOCKED',
    execution: { mode: 'session-supervised', maxConcurrentAgents: 7, persistentBackgroundAgents: false, remoteOperationsOwner: 'A1' },
    roles: AGENT_ROLE_IDS.map(id => { const role = manifest.roles.find(value => value.id === id); return { id, reviewer: role.reviewer, prompt: role.prompt }; }),
    checkedFiles: [MANIFEST, ...new Set(references.map(reference => reference.path))],
    meaning: 'Configuration and local Markdown files only; no agents started and no production release authorized.' };
}
export async function readAgentRole(roleId, options = {}) {
  if (!AGENT_ROLE_IDS.includes(roleId)) failure('AGENT_TEAM_UNKNOWN_ROLE');
  const { documents } = await loadAgentTeam(options);
  return `${documents.get('commonPrompt').trimEnd()}\n\n${documents.get(`${roleId}.prompt`).trimEnd()}\n`;
}
export async function runAgentTeamCli(args, { rootDirectory = DEFAULT_ROOT,
  stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text) } = {}) {
  try {
    if (!Array.isArray(args)) failure('AGENT_TEAM_INVALID_ARGUMENTS');
    if (args.length === 1 && args[0] === '--help') { stdout(HELP); return 0; }
    if (args.length === 1 && args[0] === '--check') { stdout(JSON.stringify(await checkAgentTeam({ rootDirectory }), null, 2) + '\n'); return 0; }
    if (args.length === 2 && args[0] === '--role') { stdout(await readAgentRole(args[1], { rootDirectory })); return 0; }
    failure('AGENT_TEAM_INVALID_ARGUMENTS');
  } catch (error) {
    const code = typeof error?.code === 'string' && /^AGENT_TEAM_[A-Z_]+$/.test(error.code) ? error.code : 'AGENT_TEAM_CHECK_FAILED';
    const field = typeof error?.field === 'string' && /^(?:manifest|commonPrompt|progressTemplate|A[1-8](?:\.prompt)?)$/.test(error.field) ? `: ${error.field}` : '';
    stderr(code + field + '\n'); return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runAgentTeamCli(process.argv.slice(2));
