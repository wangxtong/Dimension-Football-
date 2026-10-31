export const CRAWLER_AGENT = 'DimensionFootballCrawler';

// RFC 9309 compares octets. Decode only ASCII unreserved escapes; reserved
// escapes stay escaped, while literal non-ASCII becomes its UTF-8 octets.
function canonicalOctets(value) {
  return value.replace(/%[0-9a-f]{2}|[^\x00-\x7f]/giu, part => {
    if (part.startsWith('%')) {
      const char = String.fromCharCode(parseInt(part.slice(1), 16));
      return /[A-Za-z0-9._~-]/.test(char) ? char : part.toUpperCase();
    }
    return encodeURIComponent(part);
  });
}

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
  const target = new URL(url), path = canonicalOctets(target.pathname + target.search);
  let allowed = true, length = -1;
  for (const rule of selected.flatMap(group => group.rules)) {
    const end = rule.path.endsWith('$'), pattern = canonicalOctets(end ? rule.path.slice(0, -1) : rule.path);
    const regex = '^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (end ? '$' : '');
    const specificity = pattern.replaceAll('*', '').length;
    if (new RegExp(regex).test(path) && (specificity > length || specificity === length && rule.allow)) {
      allowed = rule.allow; length = specificity;
    }
  }
  return { allowed, delayMs: Math.max(0, ...selected.map(group => group.delayMs)) };
}
