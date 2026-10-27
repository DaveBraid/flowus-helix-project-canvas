import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.mjs';
import { ServiceError } from '../server/flowus.mjs';

async function fixture(t, internalToken = 'test-internal-secret-'.repeat(3)) {
  /** 启动仅回环测试服务；输入测试生命周期及秘密，输出地址与模拟调用记录。 */
  const calls = []; let browserSessions = 0;
  const auth = { fromRequest: () => { browserSessions++; return { csrfToken: 'browser-csrf' }; } };
  const actions = { call: async (name, args) => {
    calls.push({ name, args });
    if (name === 'fail') throw new ServiceError(403, '目标不在指定 Helix 项目内');
    return { name, args, mocked: true };
  } };
  const server = createApp({ auth, projects: {}, actions, origin: 'http://localhost:3000', internalToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, calls, internalToken, get browserSessions() { return browserSessions; } };
}

test('内网工具接口拒绝匿名、浏览器 Cookie、CSRF 和错误机器令牌', async t => {
  const f = await fixture(t);
  for (const headers of [{}, { cookie: 'valid-browser-session', 'x-csrf-token': 'browser-csrf' }, { authorization: 'Bearer wrong' }, { authorization: f.internalToken }, { authorization: `bearer ${f.internalToken}` }]) {
    const response = await fetch(`${f.base}/internal/mcp/tools`, { headers }); assert.equal(response.status, 401);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.browserSessions, 0);
});

test('足长独立 Bearer 可列出18个封闭工具并调用模拟业务入口', async t => {
  const f = await fixture(t); const headers = { authorization: `Bearer ${f.internalToken}`, 'content-type': 'application/json' };
  const listed = await fetch(`${f.base}/internal/mcp/tools`, { headers }); assert.equal(listed.status, 200);
  const { tools } = await listed.json(); assert.equal(tools.length, 18); assert.ok(tools.some(tool => tool.name === 'helix_help'));
  const body = { name: 'helix_help', arguments: {} };
  const called = await fetch(`${f.base}/internal/mcp/call`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(called.status, 200); assert.deepEqual(f.calls, [{ name: body.name, args: {} }]); assert.equal(f.browserSessions, 0);
});

test('空或过短服务端秘密不能被同值请求激活', async t => {
  for (const secret of ['', 'short']) {
    const f = await fixture(t, secret);
    assert.equal((await fetch(`${f.base}/internal/mcp/tools`, { headers: { authorization: `Bearer ${secret}` } })).status, 401);
    assert.equal(f.calls.length, 0);
  }
});

test('内网 HTTP 严格路由和正文格式，业务拒绝保留403', async t => {
  const f = await fixture(t); const headers = { authorization: `Bearer ${f.internalToken}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${f.base}/internal/mcp/tools`, { method: 'POST', headers })).status, 404);
  assert.equal((await fetch(`${f.base}/internal/unknown`, { headers })).status, 404);
  assert.equal((await fetch(`${f.base}/internal/mcp/call`, { method: 'POST', headers: { authorization: headers.authorization }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${f.base}/internal/mcp/call`, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(`${f.base}/internal/mcp/call`, { method: 'POST', headers, body: JSON.stringify({ name: 'helix_help', arguments: {}, path: '/pages/foreign' }) })).status, 400);
  assert.equal(f.calls.length, 0);
  const denied = await fetch(`${f.base}/internal/mcp/call`, { method: 'POST', headers, body: JSON.stringify({ name: 'fail', arguments: {} }) });
  assert.equal(denied.status, 403); assert.match((await denied.json()).error, /指定 Helix 项目/);
});
