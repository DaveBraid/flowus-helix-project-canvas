import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Auth, verifyPassword } from './auth.mjs';
import { FlowUs, Projects, ServiceError, secret, validSlug } from './flowus.mjs';
import { startUrlSync } from './sync.mjs';
import { CliOAuth } from './oauth.mjs';
import { reconcileNumbers } from './numbering.mjs';

/** 读取有大小限制的 JSON 请求，避免无界内存分配。 */
async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new ServiceError(415, '需要 JSON 请求');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 100000) throw new ServiceError(413, '请求过大'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new ServiceError(400, 'JSON 格式错误'); }
}

/** 创建 HTTP 服务；依赖可注入以验证鉴权、项目边界及失败行为。 */
export function createApp({ auth, projects, origin, dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist') }) {
  const attempts = new Map(); let activeLogin = false;
  const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self' https://flowus.cn https://*.flowus.cn; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, origin); const path = url.pathname;
      if (path === '/healthz' && req.method === 'GET') return send(res, 200, { ok: true });
      const session = auth.fromRequest(req);
      if (path === '/api/session' && req.method === 'GET') return send(res, 200, session ? { authenticated: true, csrfToken: session.csrfToken, expiresAt: session.expiresAt } : { authenticated: false });
      if (path.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method)) {
        if (req.headers.origin !== origin) throw new ServiceError(403, '请求来源无效'); // 同源校验覆盖登录 CSRF。
      }
      if (path === '/api/login' && req.method === 'POST') {
        // 仅信任同机反向代理覆盖的客户端地址；每地址限制并保护 scrypt CPU。
        const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
        const now = Date.now();
        for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
        const attempt = attempts.get(ip) || { count: 0, until: now + 15 * 60000 };
        if (attempt.count >= 8 || activeLogin || attempts.size > 10000) throw new ServiceError(429, '登录尝试过多，请稍后重试');
        attempt.count++; attempts.set(ip, attempt); // 请求体到达前原子占位，慢请求和并发请求共用配额。
        if (Number(req.headers['content-length']) > 100000) throw new ServiceError(413, '请求过大');
        let body; let bodyTimer;
        try {
          body = await Promise.race([
            jsonBody(req), // 流式读取同样限制 100 KB，不信任 Content-Length。
            new Promise((_, reject) => { bodyTimer = setTimeout(() => {
              res.setHeader('Connection', 'close'); req.pause?.(); // 超时响应后关闭连接，不保留未读请求体。
              reject(new ServiceError(408, '登录请求超时，请重试'));
            }, 10000); }),
          ]);
        } finally { clearTimeout(bodyTimer); }
        activeLogin = true;
        let valid;
        try { valid = verifyPassword(body?.password, auth.passwordHash); } finally { activeLogin = false; }
        if (!valid) throw new ServiceError(401, '密码不正确');
        attempts.delete(ip);
        const issued = auth.issue(); res.setHeader('Set-Cookie', auth.cookie(issued.token));
        return send(res, 200, { authenticated: true, csrfToken: issued.csrfToken, expiresAt: issued.expiresAt });
      }
      if (path.startsWith('/api/')) {
        if (!session) throw new ServiceError(401, '请先登录');
        if (!['GET', 'HEAD'].includes(req.method) && !auth.csrf(session, req.headers['x-csrf-token'])) throw new ServiceError(403, '会话校验失败，请重新登录');
        if (path === '/api/logout' && req.method === 'POST') { res.setHeader('Set-Cookie', auth.cookie('', true)); return send(res, 200, { ok: true }); }
        const reconcile = path.match(/^\/api\/projects\/([^/]+)\/reconcile$/);
        if (reconcile && req.method === 'POST') {
          const slug = decodeURIComponent(reconcile[1]);
          return send(res, 200, await projects.withMutation(slug, () => reconcileNumbers(projects, slug)));
        }
        const experiment = path.match(/^\/api\/projects\/([^/]+)\/experiments(?:\/([^/]+))?$/);
        if (experiment) {
          const slug = decodeURIComponent(experiment[1]);
          if (!experiment[2] && req.method === 'POST') return send(res, 201, await projects.createExperiment(slug, await jsonBody(req)));
          if (experiment[2] && req.method === 'PATCH') return send(res, 200, await projects.updateExperiment(slug, decodeURIComponent(experiment[2]), await jsonBody(req)));
        }
        const match = path.match(/^\/api\/projects\/([^/]+)\/(graph|layout|preview)$/);
        if (match) {
          const slug = decodeURIComponent(match[1]);
          if (match[2] === 'preview' && req.method === 'GET') return send(res, 200, projects.preview(slug));
          if (match[2] === 'graph' && req.method === 'GET') return send(res, 200, await projects.graph(slug, url.searchParams.get('fresh') === '1'));
          if (match[2] === 'layout' && req.method === 'PUT') return send(res, 200, await projects.save(slug, await jsonBody(req)));
        }
        throw new ServiceError(404, '接口不存在');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new ServiceError(405, '方法不支持');
      const match = path.match(/^\/Helix\/([^/]+)\/?$/);
      let file;
      if (match && validSlug(decodeURIComponent(match[1]))) {
        if (session) await projects.resolve(decodeURIComponent(match[1])); // 已登录访问不存在的简写返回 HTTP 404。
        file = resolve(dist, 'index.html');
      } else if (/^\/assets\/[a-zA-Z0-9_.-]+$/.test(path)) file = resolve(dist, `.${path}`);
      else throw new ServiceError(404, '页面不存在');
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[extname(file)] || 'application/octet-stream';
      if (!(await stat(file)).isFile()) throw new ServiceError(404, '资源不存在');
      const data = await readFile(file); res.writeHead(200, { 'Content-Type': mime }); res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      const status = error instanceof ServiceError ? error.status : error instanceof URIError ? 400 : error.code === 'ENOENT' ? 404 : 500;
      send(res, status, { error: status === 500 ? '服务发生错误，请稍后重试' : error.message, ...(error instanceof ServiceError && error.details ? error.details : {}) });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const origin = process.env.PUBLIC_ORIGIN || 'http://localhost:3000';
  if (!process.env.FLOWUS_PROJECTS_DATABASE_ID) throw new Error('FLOWUS_PROJECTS_DATABASE_ID is required');
  const tokenProvider = process.env.FLOWUS_CONFIG_DIR ? new CliOAuth({ configDir: process.env.FLOWUS_CONFIG_DIR, cliPath: process.env.FLOWUS_CLI_PATH || '/usr/local/bin/flowus', workspaceId: process.env.FLOWUS_WORKSPACE_ID || undefined }) : null;
  const token = tokenProvider ? undefined : secret('FLOWUS_TOKEN');
  if (!tokenProvider && !token) throw new Error('Independent FlowUs authorization is required');
  const auth = new Auth(secret('SESSION_SECRET'), secret('PASSWORD_HASH'), { secure: !origin.startsWith('http://localhost') });
  const projects = new Projects(new FlowUs({ token, tokenProvider }), { database: process.env.FLOWUS_PROJECTS_DATABASE_ID, publicOrigin: origin, allowed: (process.env.PROJECT_IDS || '').split(',').filter(Boolean) });
  const server = createApp({ auth, projects, origin });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const stopSync = startUrlSync(projects);
  server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Helix service ready'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopSync(); server.close(() => process.exit(0)); });
}
