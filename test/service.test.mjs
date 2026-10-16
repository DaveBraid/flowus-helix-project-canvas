import test from 'node:test';
import assert from 'node:assert/strict';
import { Auth, hashPassword, verifyPassword } from '../server/auth.mjs';
import { FlowUs, Projects, graphRecords, validSlug } from '../server/flowus.mjs';
import { createApp } from '../server/index.mjs';

const passwordHash = hashPassword('test-only-password');
test('密码哈希、签名、到期、改密均有效', () => {
  assert(verifyPassword('test-only-password', passwordHash));
  assert(!verifyPassword('wrong', passwordHash));
  let now = 1000; const auth = new Auth('a'.repeat(32), passwordHash, { now: () => now, ttl: 10 });
  const session = auth.issue(); assert(auth.parse(session.token));
  assert.equal(auth.parse(session.token + 'x'), null);
  assert.equal(new Auth('a'.repeat(32), hashPassword('changed')).parse(session.token), null);
  assert(auth.csrf(session, session.csrfToken)); assert(!auth.csrf(session, 'wrong'));
  now = 11000; assert.equal(auth.parse(session.token), null);
  assert.match(auth.cookie('x'), /HttpOnly.*Secure; SameSite=None; Partitioned/);
});
test('简写保留大小写，拒绝路径与空白', () => {
  for (const slug of ['TestProject', 'atec-2026', '测试项目']) assert(validSlug(slug));
  for (const slug of ['', '../x', 'a/b', 'a?b', ' x', 'a b', '__proto__']) assert(!validSlug(slug));
});
test('会话在北京时间下月一日到期，跨年及闰年正确', () => {
  for (const [now, expected] of [['2026-10-15T12:00:00Z', '2026-10-31T16:00:00Z'], ['2026-12-31T15:59:00Z', '2026-12-31T16:00:00Z'], ['2028-02-15T00:00:00Z', '2028-02-29T16:00:00Z'], ['2026-10-31T16:00:00Z', '2026-11-30T16:00:00Z']]) {
    const auth = new Auth('a'.repeat(32), passwordHash, { now: () => Date.parse(now) });
    assert.equal(auth.issue().expiresAt, Date.parse(expected));
  }
});
const record = (id, title, sources = []) => ({ id, properties: { 实验内容: { type: 'title', title: [{ text: { content: title } }] }, 来源实验: { relation: sources.map(id => ({ id })) } } });
test('分支合并依赖页面 ID，改编号保持边，跨项目关联不伪造节点', () => {
  const rows = [record('a', '1. 基线'), record('b', '2. A', ['a']), record('c', '3. B', ['a']), record('d', '4. 合并', ['b', 'c', 'outside'])];
  const graph = graphRecords(rows); assert.equal(graph.edges.length, 4); assert.equal(graph.missingRelations, 1);
  rows[0] = record('a', '9a 改名'); assert.deepEqual(graphRecords(rows).edges, graph.edges);
  rows[1].in_trash = true; assert.equal(graphRecords(rows).nodes.length, 3);
});
test('游标分页读取完整，不接受循环游标', async () => {
  const calls = []; const api = new FlowUs({ token: 'test', interval: 0, fetchImpl: async (url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify(calls.length === 1 ? { results: [1], has_more: true, next_cursor: 'next' } : { results: [2], has_more: false }));
  } });
  assert.deepEqual(await api.all('POST', '/databases/a/query'), [1, 2]); assert.equal(calls[1].start_cursor, 'next');
  api.fetch = async () => new Response(JSON.stringify({ results: [1], has_more: true, next_cursor: 'loop' }));
  await assert.rejects(api.all('POST', '/databases/a/query'), /分页异常/);
});
test('HTTP 401 只交官方 OAuth 提供器强制检查一次，并保留真实 ETag', async () => {
  const checks = []; let requests = 0;
  const api = new FlowUs({ interval: 0, tokenProvider: { getToken: async (force = false) => { checks.push(force); return force ? 'new-test-token' : 'old-test-token'; } }, fetchImpl: async (_url, options) => {
    requests++;
    if (requests === 1) return new Response('{}', { status: 401 });
    assert.equal(options.headers.Authorization, 'Bearer new-test-token');
    return new Response('{"id":"project"}', { headers: { ETag: 'W/"version"' } });
  } });
  assert.equal((await api.request('GET', '/pages/project')).etag, 'W/"version"');
  assert.deepEqual(checks, [false, true]);
});
test('简写不存在、重复、未启用时失败关闭', async () => {
  let rows = []; const projects = new Projects({ all: async () => rows }, { allowed: ['a'] });
  await assert.rejects(projects.resolve('missing'), { status: 404 });
  rows = [{ id: 'a' }, { id: 'b' }]; await assert.rejects(projects.resolve('duplicate'), { status: 409 });
  rows = [{ id: 'b' }]; await assert.rejects(projects.resolve('other'), { status: 404 });
});
test('布局只保存坐标，拒绝跨项目节点与旧版本，采用原位 PATCH', async () => {
  const writes = []; let stored;
  const api = { request: async (method, path, body, revision) => {
    if (method === 'PATCH') { writes.push({ method, path, body, revision }); stored = body.properties['Canvas 状态']; return { data: {}, etag: 'v2' }; }
    return { data: { properties: { 'Canvas 状态': stored } }, etag: 'v2' };
  } };
  const projects = new Projects(api);
  projects.load = async () => ({ project: { id: 'project' }, databaseId: 'db', nodes: [{ id: 'a' }], revision: 'v1', layout: null });
  await assert.rejects(projects.save('test', { revision: 'old', positions: {} }), { status: 409 });
  await assert.rejects(projects.save('test', { revision: 'v1', positions: { foreign: { x: 1, y: 2 } } }), { status: 400 });
  const result = await projects.save('test', { revision: 'v1', positions: { a: { x: 1.2, y: 2.8, zoom: 8 } }, viewport: {} });
  assert.deepEqual(result.layout.nodes, { a: { x: 1, y: 3 } }); assert(!('viewport' in result.layout));
  assert.equal(writes.length, 1); assert.equal(writes[0].revision, 'v1');
  await assert.rejects(projects.save('test', { revision:'v1', positions:{}, cardColor:'url(evil)' }), {status:400});
  const colored = await projects.save('test', { revision:'v1', positions:{a:{x:1,y:3}}, cardColor:'#AABBCC' });
  assert.equal(colored.layout.cardColor, '#aabbcc');
  projects.load = async () => ({ project:{id:'project'}, databaseId:'db', nodes:[{id:'a'}], revision:'v1', layout:colored.layout });
  const moved = await projects.save('test', { revision:'v1', positions:{a:{x:4,y:5}} });
  assert.equal(moved.layout.cardColor, '#aabbcc'); // 兼容未发送颜色的旧客户端。

});
test('HTTP API 需要登录、同源和 CSRF，Cookie 不向脚本暴露', async t => {
  let reads = 0; let saves = 0;
  const auth = new Auth('a'.repeat(32), passwordHash, { secure: false });
  const projects = { graph: async () => { reads++; return { nodes: [] }; }, save: async () => { saves++; return {}; } };
  const server = createApp({ auth, projects, origin: 'http://localhost:3000' });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/projects/test/graph`)).status, 401); assert.equal(reads, 0);
  const login = body => fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await login({ password: 'wrong' })).status, 401);
  const response = await login({ password: 'test-only-password' }); assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0]; const session = await response.json();
  assert(!session.token); assert(session.csrfToken);
  assert.equal((await fetch(`${base}/api/projects/test/graph`, { headers: { cookie } })).status, 200);
  const put = extra => fetch(`${base}/api/projects/test/layout`, { method: 'PUT', headers: { cookie, 'Content-Type': 'application/json', ...extra }, body: '{}' });
  assert.equal((await put({ Origin: 'https://evil.invalid', 'X-CSRF-Token': session.csrfToken })).status, 403);
  assert.equal((await put({ Origin: 'http://localhost:3000' })).status, 403);
  assert.equal((await put({ Origin: 'http://localhost:3000', 'X-CSRF-Token': session.csrfToken })).status, 200); assert.equal(saves, 1);
});
