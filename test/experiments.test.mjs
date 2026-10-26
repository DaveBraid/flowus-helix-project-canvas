import test from 'node:test';
import assert from 'node:assert/strict';
import { Projects, FlowUs, ServiceError } from '../server/flowus.mjs';
import { richText } from '../server/experiments.mjs';

const ids = Array.from({ length: 8 }, (_, i) => `${i + 1}`.repeat(8) + '-1111-4111-8111-' + `${i + 1}`.repeat(12));
const [projectId, dbId, templateId, a, b, c, createdId, foreignId] = ids;
const time = '2026-10-26T01:00:00.000Z'; const revision = `W/"${time}"`;
const heading = (text, n = 1) => ({ id: `heading-${text}`, type: `heading_${n}`, [`heading_${n}`]: { rich_text: [richText(text)], color: 'default' } });
const paragraph = text => ({ id: text, type: 'paragraph', paragraph: { rich_text: [richText(text)], color: 'default' } });
function fixture() {
  const calls = []; let postFailures = 0; let currentProject = projectId;
  const graph = { project: { id: projectId }, databaseId: dbId, nodes: [a, b, c].map((id, i) => ({ id, title: `实验 ${i}`, number: `${i + 1}`, revision, sourceIds: [] })), edges: [{ source: a, target: b }] };
  const db = { id: dbId, properties: { 实验内容: { type: 'title' }, 来源实验: { type: 'relation', relation: { database_id: dbId } }, 状态: { type: 'select', select: { options: [{ name: '计划中' }, { name: '进行中' }] } }, 编号: { type: 'formula' } } };
  const template = [heading('本阶段问题聚焦'), heading('计划行动'), { type: 'to_do', to_do: { rich_text: [], checked: false } }, heading('下一阶段聚焦问题')];
  const bodies = new Map([a, b].map(id => [id, [heading('记录'), paragraph('不继承的旧结果'), heading('下一阶段聚焦问题'), paragraph(`聚焦-${id}`), heading('附录'), paragraph('不继承的附录')]]));
  const pages = new Map([a, b, c].map(id => [id, { id, parent: { database_id: dbId }, last_edited_time: time }]));
  pages.set(templateId, { id: templateId, last_edited_time: time });
  const api = {
    all: async (method, path) => {
      calls.push({ method, path });
      const id = path.match(/^\/blocks\/([^/]+)\/children$/)?.[1];
      if (id === templateId) return structuredClone(template);
      if (bodies.has(id)) return structuredClone(bodies.get(id));
      throw new Error(`Unexpected read: ${path}`);
    },
    request: async (method, path, body, etag, idempotencyKey) => {
      calls.push({ method, path, body: structuredClone(body), etag, idempotencyKey });
      if (method === 'GET' && path === `/databases/${dbId}`) return { data: structuredClone(db) };
      if (method === 'GET' && path.startsWith('/pages/')) return { data: structuredClone(pages.get(path.split('/').at(-1))), etag: revision };
      if (method === 'POST' && path === '/pages') {
        if (postFailures-- > 0) throw new ServiceError(503, 'Connection lost');
        return { data: { id: createdId, parent: { database_id: dbId }, last_edited_time: time } };
      }
      if (method === 'PATCH' && path.startsWith('/pages/')) return { data: {}, etag: 'W/"updated"' };
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
  const projects = new Projects(api, { templateId });
  projects.load = async () => ({ ...structuredClone(graph), databaseSchema: structuredClone(db) });
  projects.resolve = async () => ({ id: currentProject });
  return { projects, calls, graph, template, bodies, pages, db, failPost: () => { postFailures++; }, moveProject: () => { currentProject = foreignId; } };
}
const input = { title: '合并后的实验', sourceIds: [b, a], requestId: 'create-request-id-0001' };

test('创建一次提交模板和全部来源独立quote，只继承指定小节，不写编号公式', async () => {
  const { projects, calls } = fixture();
  const result = await projects.createExperiment('test', input);
  assert.equal(result.nodeId, createdId);
  const posts = calls.filter(call => call.method === 'POST'); assert.equal(posts.length, 1);
  const body = posts[0].body;
  assert.equal(body.parent.database_id, dbId); assert.deepEqual(Object.keys(body.properties).sort(), ['实验内容', '来源实验', '状态'].sort());
  assert.equal(body.children[1].type, 'quote'); assert.equal(body.children[2].type, 'quote');
  assert.equal(body.children[1].quote.rich_text[0].text.link.url.startsWith(`https://flowus.cn/${a}#`), true);
  assert.equal(body.children[1].children[0].paragraph.rich_text[0].plain_text, `聚焦-${a}`);
  assert.equal(body.children[2].children[0].paragraph.rich_text[0].plain_text, `聚焦-${b}`);
  assert.equal(JSON.stringify(body).includes('不继承的旧结果'), false);
  assert.equal(JSON.stringify(body).includes('不继承的附录'), false);
  assert.equal(Object.hasOwn(body.children[0].heading_1, 'color'), false);
  assert.match(posts[0].idempotencyKey, /^[0-9a-f]{64}$/);
});
test('同一请求并发和成功重试不重复创建，改变内容409', async () => {
  const { projects, calls } = fixture();
  const values = await Promise.all([projects.createExperiment('test', input), projects.createExperiment('test', input)]);
  assert.deepEqual(values[0], values[1]);
  await projects.createExperiment('test', input); assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  await assert.rejects(projects.createExperiment('test', { ...input, title: '不同内容' }), { status: 409 });
});
test('未知创建结果保留同一官方key及payload；简写复用后禁止重放', async () => {
  const { projects, calls, failPost, moveProject } = fixture(); failPost();
  await assert.rejects(projects.createExperiment('test', input), error => error.status === 503 && error.details.retrySameRequest === true);
  await projects.createExperiment('test', input);
  const posts = calls.filter(c => c.method === 'POST'); assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].body, posts[1].body); assert.equal(posts[0].idempotencyKey, posts[1].idempotencyKey);
  moveProject(); await assert.rejects(projects.createExperiment('test', input), { status: 409 });
});
test('未确认请求重试检查实验表及来源归属', async () => {
  const f = fixture(); f.failPost(); await assert.rejects(f.projects.createExperiment('test', input), { status: 503 });
  f.graph.databaseId = foreignId;
  await assert.rejects(f.projects.createExperiment('test', input), { status: 409 });
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});
test('来源跨表、缺失小节、未知块及失效模板均在创建前拒绝', async () => {
  let f = fixture(); await assert.rejects(f.projects.createExperiment('test', { ...input, sourceIds: [foreignId] }), { status: 400 }); assert.equal(f.calls.some(c => c.method === 'POST'), false);
  f = fixture(); f.bodies.set(a, [paragraph('缺少小节')]); await assert.rejects(f.projects.createExperiment('test', input), { status: 409 }); assert.equal(f.calls.some(c => c.method === 'POST'), false);
  f = fixture(); f.template.push({ type: 'image', image: {} }); await assert.rejects(f.projects.createExperiment('test', input), { status: 409 }); assert.equal(f.calls.some(c => c.method === 'POST'), false);
  f = fixture(); f.pages.get(templateId).archived = true; await assert.rejects(f.projects.createExperiment('test', input), { status: 409 });
  f = fixture(); f.pages.get(a).parent.database_id = foreignId; await assert.rejects(f.projects.createExperiment('test', input), { status: 409 });
});
test('空来源保留原模板；准备失败允许同key修正但未尝试远端写', async () => {
  const f = fixture(); f.bodies.set(a, [paragraph('没有小节')]);
  await assert.rejects(f.projects.createExperiment('test', input), { status: 409 });
  const result = await f.projects.createExperiment('test', { ...input, sourceIds: [] }); assert.equal(result.nodeId, createdId);
  const body = f.calls.find(c => c.method === 'POST').body;
  assert.equal(body.children.length, f.template.length); assert.equal(body.children.some(c => c.type === 'quote'), false);
});
test('编辑只PATCH明确提交的字段并用实验ETag，不改正文、来源或公式', async () => {
  const { projects, calls } = fixture();
  await projects.updateExperiment('test', c, { status: '进行中', revision });
  const write = calls.find(c => c.method === 'PATCH'); assert.deepEqual(write.body, { properties: { 状态: { type: 'select', select: { name: '进行中' } } } }); assert.equal(write.etag, revision);
});
test('编辑拒绝旧版、移出表、未知状态、跨表来源、自引用及循环', async () => {
  let f = fixture(); await assert.rejects(f.projects.updateExperiment('test', c, { status: '进行中', revision: 'old' }), { status: 409 });
  f = fixture(); f.pages.get(c).parent.database_id = foreignId; await assert.rejects(f.projects.updateExperiment('test', c, { status: '进行中', revision }), { status: 404 });
  for (const [patch, status] of [[{ status: '不存在' }, 400], [{ sourceIds: [foreignId] }, 400], [{ sourceIds: [a] }, 400], [{ sourceIds: [b] }, 409]]) {
    f = fixture(); await assert.rejects(f.projects.updateExperiment('test', a, { ...patch, revision }), { status }); assert.equal(f.calls.some(c => c.method === 'PATCH'), false);
  }
});
test('保留不可见外部来源：状态可改，提交来源修改则失败关闭', async () => {
  const f = fixture(); f.graph.nodes[2].sourceIds = [foreignId];
  await f.projects.updateExperiment('test', c, { status: '进行中', revision });
  await assert.rejects(f.projects.updateExperiment('test', c, { sourceIds: [], revision }), { status: 409 });
});
test('已完成创建LRU可淘汰，未确认请求不会被丢弃', async () => {
  const f = fixture();
  for (let i = 0; i < 1000; i++) f.projects.experiments.creates.set(`old-${i}`, { result: { nodeId: createdId } });
  await f.projects.createExperiment('test', { ...input, sourceIds: [] }); assert.equal(f.projects.experiments.creates.size, 1000);
  f.projects.experiments.creates = new Map(Array.from({ length: 1000 }, (_, i) => [`unknown-${i}`, {}]));
  await assert.rejects(f.projects.createExperiment('test', { ...input, requestId: 'another-request-00001' }), { status: 503 });
});
test('写入invalidate后并发旧读不能回填，项目锁失败后继续且清理', async () => {
  const p = new Projects({}); let finish;
  p.load = () => new Promise(resolve => { finish = resolve; });
  const read = p.graph('test'); p.invalidate('test'); finish({ nodes: [] }); await read;
  assert.equal(p.preview('test'), null); assert.equal(p.pending.size, 0);
  const order = [];
  await Promise.allSettled([p.withMutation('test', async () => { order.push(1); throw new Error('failure'); }), p.withMutation('test', async () => { order.push(2); })]);
  assert.deepEqual(order, [1, 2]); assert.equal(p.mutations.size, 0);
});
test('FlowUs重试401/429保留官方幂等键', async () => {
  const headers = []; let calls = 0;
  const api = new FlowUs({ interval: 0, token: 'test-only', fetchImpl: async (url, options) => { headers.push(options.headers); return ++calls === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '0.001' } }) : new Response('{"id":"created"}'); } });
  await api.request('POST', '/pages', { children: [] }, undefined, 'stable-key'); assert.equal(headers.length, 2); assert.equal(headers.every(h => h['Idempotency-Key'] === 'stable-key'), true);
});

test('新建一次写入预计连续编号，不重复读取实验表结构', async () => {
  const { projects, calls, graph } = fixture();
  graph.nodes.forEach((node,i)=>{node.createdTime=`2026-01-0${i+1}T00:00:00.000Z`;});
  await projects.createExperiment('test', { ...input, sourceIds: [b] });
  const post=calls.find(c=>c.method==='POST');
  assert.equal(post.body.properties.实验内容.title[0].text.content,'4. 合并后的实验');
  assert(!calls.some(c=>c.path===`/databases/${dbId}`));
});
