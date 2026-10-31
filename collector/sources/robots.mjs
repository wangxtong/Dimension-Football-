export const CRAWLER_AGENT = 'DimensionFootballCrawler';

// A bounded robots parser: most-specific agent group, longest matching path,
// Allow wins ties. Crawl-delay is honored as an additional pacing hint.
export function robotsPolicy(text, url) {
  const groups = []; let group = null, hasRules = false;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.split('#', 1)[0].trim().match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const [, rawName, value] = match, name = rawName.toLowerCase();
    if (name === 'user-agent') {
      if (!group || hasRules) { group = { agents: [], rules: [], delayMs: 0 }; groups.push(group); hasRules = false; }
      group.agents.push(value.toLowerCase());
    } else if (group && ['allow', 'disallow', 'crawl-delay'].includes(name)) {
      hasRules = true;
      if (name === 'crawl-delay' && /^\d+(?:\.\d+)?$/.test(value)) group.delayMs = Math.max(group.delayMs, Number(value) * 1000);
      else if (value && value.length <= 2048 && ['allow', 'disallow'].includes(name)) group.rules.push({ allow: name === 'allow', path: value });
    }
  }
  const agent = CRAWLER_AGENT.toLowerCase();
  const score = group => Math.max(-1, ...group.agents.map(value => value === '*' ? 0 : value && agent.includes(value) ? value.length : -1));
  const best = Math.max(-1, ...groups.map(score)), selected = groups.filter(group => score(group) === best && best >= 0);
  const target = new URL(url), path = target.pathname + target.search;
  let allowed = true, length = -1;
  for (const rule of selected.flatMap(group => group.rules)) {
    const end = rule.path.endsWith('$'), pattern = end ? rule.path.slice(0, -1) : rule.path;
    const regex = '^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (end ? '$' : '');
    const specificity = pattern.replaceAll('*', '').length;
    if (new RegExp(regex).test(path) && (specificity > length || specificity === length && rule.allow)) {
      allowed = rule.allow; length = specificity;
    }
  }
  return { allowed, delayMs: Math.max(0, ...selected.map(group => group.delayMs)) };
}
