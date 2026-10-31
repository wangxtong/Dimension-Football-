import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLAN_URL = new URL('../config/agent-workstreams.json',import.meta.url);
export async function loadAgentPlan() {
  return JSON.parse(await readFile(PLAN_URL,'utf8'));
}
export function verifyAgentPlan(plan) {
  if (plan?.version !== 1 || !Array.isArray(plan.roles) || plan.roles.length !== 8) throw Error('AGENT_PLAN_INVALID');
  const ids = plan.roles.map(r=>r.id);
  if (new Set(ids).size !== 8 || !['A1','A2','A3','A4','A5','A6','A7','A8'].every(id=>ids.includes(id))) throw Error('AGENT_ROLE_SET_INVALID');
  const issues = new Set(), profiles = new Set();
  for (const role of plan.roles) {
    if (!/^A[1-8]$/.test(role.id) || !Number.isSafeInteger(role.issue) || role.issue < 1 || issues.has(role.issue)
      || typeof role.profile !== 'string' || !/^\.github\/agents\/a[1-8]-[a-z0-9-]+\.agent\.md$/.test(role.profile) || profiles.has(role.profile)
      || role.reviewedBy === role.id || !ids.includes(role.reviewedBy)
      || !['P0','P1','P2'].includes(role.priority) || !Array.isArray(role.owns) || role.owns.length === 0
      || !Array.isArray(role.accept) || role.accept.length === 0
      || !Array.isArray(role.dependsOn) || role.dependsOn.some(dep=>dep===role.id||!ids.includes(dep))) throw Error('AGENT_ROLE_INVALID');
    for (const path of role.owns) {
      if (typeof path !== 'string' || path.startsWith('/') || path.includes('..') || !/^[.A-Za-z0-9/_-]+$/.test(path))
        throw Error('AGENT_OWNERSHIP_INVALID');
    }
    issues.add(role.issue);profiles.add(role.profile);
  }
  return plan;
}
const safePath = value => typeof value === 'string' && value.length < 256 && !value.startsWith('/')
  && !value.includes('..') && !value.includes('\\') && /^[.A-Za-z0-9/_-]+$/.test(value);
export function routeAgent(plan, { role, issue, path } = {}) {
  verifyAgentPlan(plan);
  if (role !== undefined) {
    if (!/^A[1-8]$/.test(role)) throw Error('UNKNOWN_AGENT_ROLE');
    return plan.roles.find(r=>r.id===role);
  }
  if (issue !== undefined) {
    if (!/^[1-9]\d*$/.test(String(issue))) throw Error('INVALID_AGENT_ISSUE');
    return plan.roles.find(r=>r.issue===Number(issue))||null;
  }
  if (path !== undefined) {
    if (!safePath(path)) throw Error('INVALID_AGENT_PATH');
    const matched=[];
    for (const r of plan.roles) for (const entry of r.owns)
      if (entry.endsWith('/') ? path.startsWith(entry) : path===entry)
        matched.push({role:r,span:entry.length});
    matched.sort((a,b)=>b.span-a.span||a.role.id.localeCompare(b.role.id));
    if (matched.length>1 && matched[0].span===matched[1].span && matched[0].role.id!==matched[1].role.id)
      throw Error('AGENT_OWNERSHIP_AMBIGUOUS');
    return matched[0]?.role||null;
  }
  return plan.roles;
}
function parse(argv) {
  if (argv.length === 1 && argv[0] === '--list') return {};
  if (argv.length === 2 && ['--role','--issue','--path'].includes(argv[0]))
    return {[argv[0].slice(2)]:argv[1]};
  throw Error('Usage: node scripts/agents-route.mjs --list | --role A4 | --issue 15 | --path collector/forecast.mjs');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const p=verifyAgentPlan(await loadAgentPlan());
    process.stdout.write(JSON.stringify(routeAgent(p,parse(process.argv.slice(2))),null,2)+'\n');
  } catch (error) {
    process.stderr.write('AGENT_ROUTING_INVALID\n');
    process.exitCode=1;
  }
}
