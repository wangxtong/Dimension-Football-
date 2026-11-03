// 维度足球看板 · 独立于阿里云的生产入口。
// 只依赖 Node 24：读环境变量 + 读本地日报账本 + 直接提供构建后的静态资源。
import { readFileSync, existsSync, statSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';

const DIST = process.env.SITE_DIST || '/opt/dimension-site/dist';
const DATA = process.env.SITE_DATA || '/var/lib/dimension-site';
const ORIGIN = process.env.SITE_ORIGIN || 'http://127.0.0.1:8099';
const PORT = Number(process.env.SITE_PORT || 8099);
const BIND = process.env.SITE_BIND || '0.0.0.0';

const { default: dash } = await import(join(DIST, 'server/index.js'));

const sha = s => createHash('sha256').update(s).digest('hex');
// 与 Cloudflare R2 / KV 同形的最小文件 BUCKET：日报按 reportId 不可变存放。
const BUCKET = {
  async get(key) {
    const file = join(DATA, key);
    if (!existsSync(file)) return null;
    const s = readFileSync(file, 'utf8');
    return { size: Buffer.byteLength(s), etag: sha(s), text: async () => s };
  },
  async put(key, value) {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    const file = join(DATA, key);
    const tmp = file + '.tmp' + process.pid;
    writeFileSync(tmp, s);
    renameSync(tmp, file);
    return { etag: sha(s) };
  },
};

const env = {
  DASHBOARD_AUTH: process.env.DASHBOARD_AUTH,
  DASHBOARD_SESSION_SECRET: process.env.DASHBOARD_SESSION_SECRET,
  DASHBOARD_ORIGIN: ORIGIN,
  HOSTED_PUBLICATION_ENABLED: 'true',
  VANTIS_RESEARCH_WEB_ENABLED: 'true',
  BUCKET,
};
if (!env.DASHBOARD_AUTH || !env.DASHBOARD_SESSION_SECRET) {
  console.error('缺少 DASHBOARD_AUTH / DASHBOARD_SESSION_SECRET；拒绝以无鉴权方式启动。');
  process.exit(2);
}

const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : null;
    const request = new Request(ORIGIN + req.url, {
      method: req.method,
      headers: req.headers,
      body: body && body.length ? body : undefined,
      duplex: 'half',
    });
    const response = await dash.fetch(request, env);
    const buf = Buffer.from(await response.arrayBuffer());
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(response.status, headers);
    res.end(buf);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('SERVER_ERROR');
    console.error('request failed', error?.message);
  }
});
server.listen(PORT, BIND, () => console.log(`dimension-site listening on ${BIND}:${PORT} origin=${ORIGIN}`));
