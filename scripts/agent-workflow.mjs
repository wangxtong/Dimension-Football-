import { readFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(resolve(root, 'config/agent-workflow.json'), 'utf8'));
const fail = message => { throw new Error(message); };
const inside = path => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
};

async function validate() {
  if (manifest.version !== 1 || !Array.isArray(manifest.roles)) fail('Invalid workflow manifest');
  const ids = new Set();
  for (const role of manifest.roles) {
    if (!/^[a-z][a-z-]*$/.test(role.id) || ids.has(role.id)) fail('Invalid or duplicate role');
    ids.add(role.id);
    if (typeof role.name !== 'string' || !role.name.trim()) fail(`Missing name: ${role.id}`);
    for (const field of ['paths', 'hints', 'reviewers']) {
      if (!Array.isArray(role[field]) || role[field].some(x => typeof x !== 'string' || !x.trim())) fail(`Invalid ${field}: ${role.id}`);
    }
    if (!/^\.agents\/skills\/vantis-[a-z-]+\/SKILL\.md$/.test(role.skill)) fail(`Invalid skill path: ${role.id}`);
    const file = await realpath(resolve(root, role.skill));
    if (!inside(file)) fail(`Skill outside repository: ${role.id}`);
    const content = await readFile(file, 'utf8');
    const expected = role.skill.split('/')[2];
    if (!content.startsWith(`---\nname: ${expected}\n`) || !/^description: .+$/m.test(content)
      || !content.includes('\n---\n') || !content.includes('## 角色提示词')) fail(`Missing skill metadata or prompt: ${role.id}`);
  }
  if (!ids.has(manifest.coordinator)) fail('Missing coordinator');
  for (const role of manifest.roles) for (const id of role.reviewers) if (!ids.has(id)) fail(`Unknown reviewer: ${id}`);
  if (JSON.stringify(Object.keys(manifest.findings).sort()) !== JSON.stringify(['A01','A02','A03','A04','A05'])) fail('Audit finding coverage must include A01–A05');
  for (const [id, finding] of Object.entries(manifest.findings)) {
    if (!ids.has(finding.owner) || !['P1', 'P2'].includes(finding.priority)
      || !['open', 'in_progress', 'verified'].includes(finding.status) || !Array.isArray(finding.reviewers)
      || finding.reviewers.some(role => !ids.has(role))) fail(`Invalid finding: ${id}`);
  }
  const backlog = await realpath(resolve(root, manifest.audit.backlog));
  if (!inside(backlog) || !/^[a-f0-9]{40}$/.test(manifest.audit.commit)) fail('Invalid audit baseline');
}

function parse(args) {
  const result = { task: [], files: [], roles: [], findings: [] };
  const keys = { '--task': 'task', '--file': 'files', '--role': 'roles', '--finding': 'findings' };
  for (let i = 0; i < args.length; i += 2) {
    const key = keys[args[i]], value = args[i + 1];
    if (!key || !value?.trim() || value.startsWith('--')) fail('Expected --task, --file, --role or --finding followed by a value');
    result[key].push(value);
  }
  result.files = result.files.map(file => {
    const path = file.replaceAll('\\', '/').replace(/^\.\//, '');
    if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) fail('Use repository-relative file paths');
    return path;
  });
  return result;
}

function route(options) {
  const owners = new Map(), reviewers = new Set(), text = options.task.join(' ').toLowerCase();
  const add = (id, reason) => owners.set(id, [...(owners.get(id) || []), reason]);
  for (const id of options.roles) {
    if (!manifest.roles.some(role => role.id === id)) fail(`Unknown role: ${id}`);
    add(id, 'explicit-role');
  }
  const findingIds = new Set([...options.findings.map(id => id.toUpperCase()), ...Array.from(text.matchAll(/\ba0[1-5]\b/g), match => match[0].toUpperCase())]);
  for (const id of findingIds) {
    const finding = manifest.findings[id];
    if (!finding) fail(`Unknown finding: ${id}`);
    add(finding.owner, id);
    finding.reviewers.forEach(role => reviewers.add(role));
  }
  for (const file of options.files) {
    // Longest prefix identifies the most specific owner; an exact file match
    // takes precedence over its directory. AGENT_ is a documented filename prefix.
    const matches = manifest.roles.flatMap(role => role.paths.filter(pattern =>
      pattern.endsWith('/') || pattern.endsWith('_') ? file.startsWith(pattern) : file === pattern
    ).map(pattern => ({ id: role.id, length: pattern.length })));
    const longest = Math.max(0, ...matches.map(match => match.length));
    matches.filter(match => match.length === longest).forEach(match => add(match.id, `file:${file}`));
  }
  // Text hints are a fallback. Explicit findings, roles and file ownership win.
  if (!owners.size) for (const role of manifest.roles) {
    const matched = role.hints.filter(hint => text.includes(hint.toLowerCase()));
    if (matched.length) add(role.id, `hint:${matched.join(',')}`);
  }
  const needsClarification = !owners.size;
  if (needsClarification) add(manifest.coordinator, 'unclassified-task');
  for (const id of owners.keys()) manifest.roles.find(role => role.id === id).reviewers.forEach(role => reviewers.add(role));
  const describe = id => {
    const { name, skill } = manifest.roles.find(role => role.id === id);
    return { id, name, skill };
  };
  return {
    mode: 'routing-only', coordinator: describe(manifest.coordinator), needsClarification,
    owners: [...owners].map(([id, reasons]) => ({ ...describe(id), reasons })),
    reviewers: [...reviewers].map(describe),
    findings: [...findingIds].map(id => ({ id, ...manifest.findings[id] })),
    instructions: '协调者确认任务含义后读取列出的 SKILL.md；复核与实现分阶段进行。此命令不启动模型、子智能体、API 请求或生产任务。'
  };
}

try {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help') {
    console.log('Usage: node scripts/agent-workflow.mjs check | route [--task TEXT] [--file PATH] [--finding A01] [--role ID]\nOptions may repeat. Output is JSON; route only selects local role skills.');
  } else {
    if (!['check', 'route'].includes(command)) fail('Unknown command');
    await validate();
    if (command === 'check') {
      if (args.length) fail('check takes no arguments');
      console.log(JSON.stringify({ valid: true, roles: manifest.roles.length, findings: Object.keys(manifest.findings).length }));
    } else console.log(JSON.stringify(route(parse(args)), null, 2));
  }
} catch (error) {
  console.error(`Agent workflow: ${error.message}`);
  process.exitCode = 1;
}
