import test from 'node:test';
import assert from 'node:assert/strict';
import { Auth, hashPassword } from '../server/auth.mjs';
import { FlowUs, Projects } from '../server/flowus.mjs';
import { createApp } from '../server/index.mjs';

const passwordHash = hashPassword('regression-password');

/** 创建不监听端口的登录测试服务；输入无，输出服务对象。 */
function loginApp() {
  return createApp({ auth: new Auth('r'.repeat(32), passwordHash, { secure: false }), projects: {}, origin: 'http://localhost' });
}

/** 将延迟请求体送入真实 HTTP 处理器；输入服务和异步正文，输出响应。 */
function submitLogin(app, body, extraHeaders = {}) {
  return new Promise(resolve => {
    const req = {
      url: '/api/login', method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', ...extraHeaders }, socket: { remoteAddress: 'test-ip' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(await body); },
      pause() {},
    };
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, writeHead(status) { this.status = status; }, end(content) { resolve({ status: this.status, headers: this.headers, content }); } };
    app.emit('request', req, res);
  });
}

test('并发登录在读取正文前共用八次配额', async () => {
  const app = loginApp(); let release;
  const body = new Promise(resolve => { release = resolve; });
  const requests = Array.from({ length: 12 }, () => submitLogin(app, body));
  release('{"password":"wrong"}');
  const statuses = (await Promise.all(requests)).map(response => response.status);
  assert.equal(statuses.filter(status => status === 401).length, 8);
  assert.equal(statuses.filter(status => status === 429).length, 4);
  assert.equal((await submitLogin(app, '{"password":"wrong"}')).status, 429);
});

test('登录慢正文十秒超时并关闭连接', async t => {
  const app = loginApp();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release; const body = new Promise(resolve => { release = resolve; });
  const pending = submitLogin(app, body);
  t.mock.timers.tick(10000);
  const response = await pending;
  assert.equal(response.status, 408);
  assert.equal(response.headers.Connection, 'close');
  release('{"password":"wrong"}');
});

test('登录按实际流量限制正文大小并提前拒绝过大声明', async () => {
  assert.equal((await submitLogin(loginApp(), 'x'.repeat(100001))).status, 413);
  assert.equal((await submitLogin(loginApp(), '{}', { 'content-length': '100001' })).status, 413);
});

/** 构建遵循官方分页结构的 FlowUs 替身；输入布局和旧版包装开关，输出项目服务与访问记录。 */
function projectFixture({ layout = { schemaVersion: 1, ownerProjectId: 'p', experimentDatabaseId: 'db', nodes: { a: { x: 20, y: 30 } } }, wrapped = false, invalidRichText = false, batchRelations = null } = {}) {
  const calls = [];
  const rich = text => ({ type: 'text', text: { content: text }, plain_text: text });
  const raw = typeof layout === 'string' ? layout : JSON.stringify(layout);
  const record = id => ({ id, properties: { 名称: { type: 'title', title: [rich(id)] }, 来源实验: { id: 'source', type: 'relation', relation: batchRelations ?? [], ...(batchRelations ? {} : {has_more: true}) } } });
  const list = (results, next = null) => ({ results, has_more: next !== null, next_cursor: next });
  const api = new FlowUs({ token: 'test-only', interval: 0, fetchImpl: async (url, options) => {
    const parsed = new URL(url); const path = parsed.pathname.slice(3); const cursor = parsed.searchParams.get('start_cursor'); calls.push({ path, cursor });
    let data;
    if (path === '/databases/projects/query') data = list([{ id: 'p' }]);
    else if (path === '/pages/p') data = { id: 'p', properties: { 名称: { type: 'title', title: [rich('项目')] }, 'Canvas 状态': { id: 'canvas', type: 'rich_text', rich_text: [rich(raw.slice(0, 5))] } } };
    else if (path === '/blocks/p/children') data = list([{ id: 'db', type: 'child_database' }]);
    else if (path === '/databases/db') data = { id: 'db', parent: { page_id: 'p' }, properties: { 来源实验: { relation: { database_id: 'db' } } } };
    else if (path === '/databases/db/query') data = list([record('a'), record('b'), record('c')]);
    else if (path === '/pages/c/properties/source') { const item = { id: cursor ? 'b' : 'a' }; data = list([wrapped ? { relation: item } : item], cursor ? null : 'next'); }
    else if (path.endsWith('/properties/source')) data = list([]);
    else if (path === '/pages/p/properties/canvas') { const item = rich(cursor ? raw.slice(5) : raw.slice(0, 5)); data = invalidRichText ? list([{ id: 'invalid' }]) : list([wrapped ? { rich_text: item } : item], cursor ? null : 'next'); }
    else throw new Error(`Unexpected request ${options.method} ${path}`);
    return new Response(JSON.stringify(data), { headers: { etag: 'v1', 'content-type': 'application/json' } });
  } });
  return { projects: new Projects(api, { database: 'projects' }), calls };
}

for (const wrapped of [false, true]) test(`全部关系和非空布局逐条分页读取（${wrapped ? '旧包装' : '直接对象'}）`, async () => {
  const { projects, calls } = projectFixture({ wrapped });
  const graph = await projects.load('test');
  assert.deepEqual(graph.edges.map(edge => [edge.source, edge.target]), [['a', 'c'], ['b', 'c']]);
  assert.deepEqual(graph.layout.nodes, { a: { x: 20, y: 30 } });
  assert.equal(graph.layoutWarning, undefined);
  for (const id of ['a', 'b', 'c']) assert(calls.some(call => call.path === `/pages/${id}/properties/source`));
  assert(calls.some(call => call.path === '/pages/p/properties/canvas' && call.cursor === 'next'));
});

for (const patch of [{ schemaVersion: 2 }, { ownerProjectId: 'other' }, { experimentDatabaseId: 'other' }, { nodes: { a: { x: 'invalid', y: 0 } } }]) test(`非空异常布局拒绝自动覆盖：${Object.keys(patch)[0]}`, async () => {
  const layout = { schemaVersion: 1, ownerProjectId: 'p', experimentDatabaseId: 'db', nodes: {}, ...patch };
  const { projects } = projectFixture({ layout });
  const graph = await projects.load('test');
  assert.equal(graph.layout, null); assert(graph.layoutWarning);
  await assert.rejects(projects.save('test', { revision: 'v1', positions: {} }), { status: 409 });
});

test('非空画布属性分页结构损坏时失败关闭', async () => {
  const { projects } = projectFixture({ invalidRichText: true });
  await assert.rejects(projects.load('test'), { status: 503 });
});

test('保存预检跳过来源关系，仍完整读取布局和当前实验归属', async () => {
  const { projects, calls } = projectFixture();
  const graph = await projects.load('test', { relations: false });
  assert.deepEqual(graph.nodes.map(n=>n.id), ['a','b','c']);
  assert.deepEqual(graph.layout.nodes, {a:{x:20,y:30}});
  assert(!calls.some(c=>c.path.endsWith('/properties/source')));
  assert(calls.some(c=>c.path==='/databases/db/query'));
  assert(calls.some(c=>c.path==='/pages/p/properties/canvas'&&c.cursor==='next'));
});


test('批量短关系数组复用，20条以上仍完整分页补读', async () => {
 for (const count of [0, 1, 19, 20, 25]) {
  const {projects,calls}=projectFixture({batchRelations:Array.from({length:count},()=>({id:'a'}))});
  await projects.load('test');
  assert.equal(calls.some(c=>c.path.endsWith('/properties/source')),count>=20);
 }
});
