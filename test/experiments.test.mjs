import test from 'node:test';
import assert from 'node:assert/strict';
import { Projects, FlowUs, ServiceError } from '../server/flowus.mjs';
import { pendingExperimentTitle, richText } from '../server/experiments.mjs';

const ids = Array.from({ length: 8 }, (_, i) => `${i + 1}`.repeat(8) + '-1111-4111-8111-' + `${i + 1}`.repeat(12));
const [projectId, dbId, templateId, a, b, c, createdId, foreignId] = ids;
const time = '2026-10-26T01:00:00.000Z'; const revision = `W/"${time}"`;
const heading = (text, n = 1) => ({ id: `heading-${text}`, type: `heading_${n}`, [`heading_${n}`]: { rich_text: [richText(text)], color: 'default' } });
const paragraph = text => ({ id: text, type: 'paragraph', paragraph: { rich_text: [richText(text)], color: 'default' } });
function fixture() {
  const calls = []; let postFailure; let appendResponseLost = false; let currentProject = projectId;
  const graph = { project: { id: projectId }, databaseId: dbId, legacyNumbering: true, nodes: [a, b, c].map((id, i) => ({ id, title: `实验 ${i}`, number: `${i + 1}`, revision, sourceIds: [] })), edges: [{ source: a, target: b }] };
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
      if (method === 'POST' && path === '/pages/' + templateId + '/duplicate') {
        if (postFailure === 'before') throw new ServiceError(503, 'Connection lost before receipt');
        pages.set(createdId, { id: createdId, parent: { database_id: dbId }, last_edited_time: time, created_time: time,
          properties: { 实验内容: { type: 'title', title: [richText(body.title)] } } });
        bodies.set(createdId, structuredClone(template).map((block, index) => ({ ...block, id: 'copy-' + index })));
        if (postFailure === 'after') throw new ServiceError(503, 'Duplicate response lost');
        return { data: { id: createdId, duplicated_from: templateId } };
      }
      if (method === 'PATCH' && path === '/blocks/' + createdId + '/children') {
        const blocks = bodies.get(createdId);
        const after = blocks.findIndex(block => block.id === body.after);
        assert.notEqual(after, -1);
        const added = body.children.map((block, index) => ({ ...structuredClone(block), id: 'quote-' + index }));
        blocks.splice(after + 1, 0, ...added);
        if (appendResponseLost) throw new ServiceError(503, 'Append response lost');
        return { data: { results: added } };
      }
      if (method === 'PATCH' && path === '/pages/' + createdId) {
        const page = pages.get(createdId);
        Object.assign(page.properties, structuredClone(body.properties));
        return { data: structuredClone(page), etag: 'W/"updated"' };
      }
      if (method === 'PATCH' && path.startsWith('/pages/')) return { data: {}, etag: 'W/"updated"' };
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
  const projects = new Projects(api, { templateId });
  projects.load = async () => ({
    ...structuredClone(graph), databaseSchema: structuredClone(db),
    pendingCopies: [...pages.values()].map(page => ({ id: page.id, title: pendingExperimentTitle(page) })).filter(copy => copy.title),
  });
  projects.resolve = async () => ({ id: currentProject });
  return { projects, calls, graph, template, bodies, pages, db,
    failPost: (when = 'before') => { postFailure = when; },
    loseAppendResponse: () => { appendResponseLost = true; },
    moveProject: () => { currentProject = foreignId; } };
}
const input = { title: '合并后的实验', sourceIds: [b, a], requestId: 'create-request-id-0001' };
const append = calls => calls.find(c => c.method === 'PATCH' && c.path === '/blocks/' + createdId + '/children');
const save = calls => calls.find(c => c.method === 'PATCH' && c.path === '/pages/' + createdId);

test('原生复制模板并把全部来源引述插入副本标题后，最后写关联和状态', async () => {
  const { projects, calls } = fixture();
  const result = await projects.createExperiment('test', input);
  assert.equal(result.nodeId, createdId);
  const posts = calls.filter(call => call.method === 'POST'); assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/pages/' + templateId + '/duplicate');
  assert.equal(posts[0].body.parent_id, dbId);
  assert.match(posts[0].body.title, /^Helix 新建中 [0-9a-f]{64}$/);
  const body = append(calls).body;
  assert.equal(body.after, 'copy-0');
  assert.deepEqual(body.children.map(child => child.type), ['quote', 'quote']);
  assert.equal(body.children[0].quote.rich_text[0].text.link.url.startsWith('https://flowus.cn/' + a + '#'), true);
  assert.equal(body.children[0].children[0].paragraph.rich_text[0].plain_text, '聚焦-' + a);
  assert.equal(body.children[1].children[0].paragraph.rich_text[0].plain_text, '聚焦-' + b);
  assert.equal(JSON.stringify(body).includes('不继承的旧结果'), false);
  assert.equal(JSON.stringify(body).includes('不继承的附录'), false);
  assert.deepEqual(Object.keys(save(calls).body.properties).sort(), ['实验内容', '来源实验', '状态'].sort());
  assert.equal(save(calls).etag, revision);
  assert.ok(calls.indexOf(save(calls)) > calls.indexOf(append(calls)));
});
test('新建实验继承来源附件和模板媒体，内部文件仅写入稳定引用', async () => {
  const f = fixture();
  const file = { oss_name: 'oss/test/focus.png', size: 94853 };
  const caption = [richText('聚焦问题截图')];
  f.bodies.get(a).splice(4, 0, { type: 'file', file: { type: 'file', caption,
    file: { ...file, url: 'https://example.com/temporary', expiry_time: time } } });
  const image = { type: 'external', external: { url: 'https://example.com/template.png' }, caption_align: 'center' };
  f.template.push({ type: 'image', image });

  await f.projects.createExperiment('test', input);
  assert.deepEqual(append(f.calls).body.children[0].children[1].file, { type: 'file', file, caption });
  assert.deepEqual(f.bodies.get(createdId).at(-1).image, image);
});

test('同一请求并发和成功重试不重复创建，改变内容409', async () => {
  const { projects, calls } = fixture();
  const values = await Promise.all([projects.createExperiment('test', input), projects.createExperiment('test', input)]);
  assert.deepEqual(values[0], values[1]);
  await projects.createExperiment('test', input); assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  await assert.rejects(projects.createExperiment('test', { ...input, title: '不同内容' }), { status: 409 });
});
test('分支编号用于正常新建，未约定编号的来源关系在写入前拒绝', async () => {
  const f = fixture();
  f.graph.legacyNumbering = false;
  f.graph.edges.push({ source: a, target: c });
  await assert.rejects(f.projects.createExperiment('test', input), /多起点或合流/);
  await assert.rejects(f.projects.updateExperiment('test', c, { sourceIds: [a, b], revision }), /多起点或合流/);
  assert.ok(f.calls.every(call => !['POST', 'PATCH'].includes(call.method)));
  await f.projects.createExperiment('test', { ...input, title: '后续实验', sourceIds: [b] });
  const title = save(f.calls).body.properties.实验内容.title;
  assert.equal(title[0].plain_text, '1·2. 后续实验');
});
test('复制回执丢失后按临时标题恢复同一副本；简写复用后禁止重放', async () => {
  const { projects, calls, failPost, moveProject } = fixture(); failPost('after');
  await assert.rejects(projects.createExperiment('test', input), error => error.status === 503 && error.details.retrySameRequest === true);
  await projects.createExperiment('test', input);
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  moveProject(); await assert.rejects(projects.createExperiment('test', input), { status: 409 });
});
test('找不到复制结果时不盲复制；已提交的引述回读确认后不重复追加', async () => {
  let f = fixture(); f.failPost();
  for (let i = 0; i < 2; i++) await assert.rejects(f.projects.createExperiment('test', input), { status: 503 });
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);

  f = fixture(); f.loseAppendResponse();
  await assert.rejects(f.projects.createExperiment('test', input), { status: 503 });
  assert.equal((await f.projects.createExperiment('test', input)).nodeId, createdId);
  assert.equal(f.calls.filter(c => c.method === 'PATCH' && c.path === '/blocks/' + createdId + '/children').length, 1);
});
test('未确认请求重试检查实验表及来源归属', async () => {
  const f = fixture(); f.failPost(); await assert.rejects(f.projects.createExperiment('test', input), { status: 503 });
  f.graph.databaseId = foreignId;
  await assert.rejects(f.projects.createExperiment('test', input), { status: 409 });
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});
test('来源跨表、缺失小节、无稳定引用的附件、未知块及失效模板均在创建前拒绝', async () => {
  let f = fixture(); await assert.rejects(f.projects.createExperiment('test', { ...input, sourceIds: [foreignId] }), { status: 400 }); assert.equal(f.calls.some(c => c.method === 'POST'), false);
  f = fixture(); f.bodies.set(a, [paragraph('缺少小节')]); await assert.rejects(f.projects.createExperiment('test', input), { status: 409 }); assert.equal(f.calls.some(c => c.method === 'POST'), false);
  f = fixture(); f.template.push({ type: 'file', file: { type: 'file', file: { url: 'https://example.com/temporary' } } }); await assert.rejects(f.projects.createExperiment('test', input), { status: 409 }); assert.equal(f.calls.some(c => c.method === 'POST'), false);
  f = fixture(); f.template.push({ type: 'child_page', child_page: {} }); await assert.rejects(f.projects.createExperiment('test', input), { status: 409 }); assert.equal(f.calls.some(c => c.method === 'POST'), false);
  f = fixture(); f.pages.get(templateId).archived = true; await assert.rejects(f.projects.createExperiment('test', input), { status: 409 });
  f = fixture(); f.pages.get(a).parent.database_id = foreignId; await assert.rejects(f.projects.createExperiment('test', input), { status: 409 });
});
test('空来源保留原模板；准备失败允许同key修正但未尝试远端写', async () => {
  const f = fixture(); f.bodies.set(a, [paragraph('没有小节')]);
  await assert.rejects(f.projects.createExperiment('test', input), { status: 409 });
  const result = await f.projects.createExperiment('test', { ...input, sourceIds: [] }); assert.equal(result.nodeId, createdId);
  assert.equal(f.bodies.get(createdId).length, f.template.length);
  assert.equal(append(f.calls), undefined);
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

test('保存新实验时写入预计连续编号，不重复读取实验表结构', async () => {
  const { projects, calls, graph } = fixture();
  graph.nodes.forEach((node,i)=>{node.createdTime=`2026-01-0${i+1}T00:00:00.000Z`;});
  await projects.createExperiment('test', { ...input, sourceIds: [b] });
  assert.equal(save(calls).body.properties.实验内容.title[0].text.content,'4. 合并后的实验');
  assert(!calls.some(c=>c.path===`/databases/${dbId}`));
});

test('完整创建响应直接返回真实图；编号变化或响应不完整时回退协调', async () => {
  for (const mode of ['append', 'branch', 'incomplete']) {
    const f = fixture();
    f.graph.nodes = f.graph.nodes.slice(0, 2).map((n, i) => ({ ...n, title: `${i + 1}. 实验`, createdTime: `2026-01-0${i + 1}T00:00:00Z` }));
    const original = f.projects.api.request;
    f.projects.api.request = async (method, path, body, ...rest) => {
      const result = await original(method, path, body, ...rest);
      if (method === 'PATCH' && path === '/pages/' + createdId && mode === 'incomplete') delete result.data.created_time;
      return result;
    };
    const result = await f.projects.createExperiment('test', { ...input, sourceIds: [mode === 'branch' ? a : b] });
    if (mode === 'append') {
      assert.equal(result.graphPatch.nodes.at(-1).id, createdId);
      assert.equal(result.graphPatch.nodes.at(-1).title, '3. 合并后的实验');
      assert.equal(result.graphPatch.edges.at(-1).source, b);
      assert.equal(f.calls.filter(c => c.path === `/pages/${b}`).length, 1);
    } else assert.equal(result.graphPatch, undefined);
  }
});

test('来源版本不一致时拒绝创建', async () => {
  const f = fixture();
  f.graph.nodes.find(n => n.id === b).revision = 'old';
  await assert.rejects(f.projects.createExperiment('test', { ...input, sourceIds: [b] }), { status: 409 });
  assert.equal(f.calls.some(c => c.method === 'POST'), false);
});

test('模板缓存每次核对版本、返回独立副本，改版和归档不复用旧正文', async () => {
 const f=fixture(); const exp=f.projects.experiments;
 const first=await exp.template();first.children.length=0;
 const count=f.calls.length;assert.equal((await exp.template()).children.length,f.template.length);
 assert.equal(f.calls.length-count,1);
 const original=f.projects.api.request;
 f.projects.api.request=async (...args)=>{const r=await original(...args);if(args[1]===`/pages/${templateId}`)r.etag='W/"new"';return r;};
 f.template.push(paragraph('新版模板'));
 assert.equal((await exp.template()).children.at(-1).paragraph.rich_text[0].plain_text,'新版模板');
 f.pages.get(templateId).archived=true;
 await assert.rejects(exp.template(),{status:409});assert.equal(exp.templateCache,null);
});
test('缓存模板和来源内容合计仍执行块数上限',async()=>{
 const f=fixture();await f.projects.experiments.template();f.projects.experiments.templateCache.count=2000;
 await assert.rejects(f.projects.createExperiment('test',{...input,sourceIds:[a]}),{status:413});
 assert.equal(f.calls.some(c=>c.method==='POST'),false);
});
