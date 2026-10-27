import test from 'node:test';
import assert from 'node:assert/strict';
import { HelixActions, helixTools, internalAuthorized } from '../server/helix-actions.mjs';

const ids = Array.from({ length: 10 }, (_, n) => `${n + 1}`.padStart(8, '0') + '-1111-4111-8111-111111111111');
const [projectsId, projectId, otherProjectId, databaseId, pageId, blockId, ancestorId, otherPageId, otherDatabaseId] = ids;
const revision = 'W/"2026-10-27T00:00:00Z"';
function fixture() {
  /** 构造内存业务源；输入无，输出业务入口、可修改记录及全部 API 调用。 */
  const records = new Map(); const calls = [];
  const record = (id, parent, extra = {}) => ({ id, parent, last_edited_time: '2026-10-27T00:00:00Z', ...extra });
  records.set(projectId, record(projectId, { database_id: projectsId }, { properties: { '项目 URL 名': { type: 'rich_text', rich_text: [{ plain_text: 'demo' }] } } }));
  records.set(otherProjectId, record(otherProjectId, { database_id: projectsId }));
  records.set(databaseId, record(databaseId, { page_id: projectId }));
  records.set(otherDatabaseId, record(otherDatabaseId, { page_id: projectId }));
  records.set(pageId, record(pageId, { database_id: databaseId }));
  records.set(blockId, record(blockId, { page_id: pageId }));
  records.set(ancestorId, record(ancestorId, { page_id: projectId }));
  records.set(otherPageId, record(otherPageId, { page_id: otherProjectId }));
  const projects = {
    database: projectsId, allowed: [], slugField: '项目 URL 名', layoutField: 'Canvas 状态', cache: new Map(),
    invalidate() {},
    withMutation: async (_, operation) => operation(),
    load: async () => ({ databaseId, nodes: [] }),
    resolve: async () => ({ id: projectId }),
    api: { request: async (method, path, body) => {
      calls.push({ method, path, body });
      const entry = records.get(path.split('/').at(-1));
      assert.ok(entry, `unexpected path: ${path}`);
      if (method === 'DELETE') entry.in_trash = true;
      if (method === 'PATCH') Object.assign(entry, body);
      return { data: structuredClone(entry), etag: revision };
    } },
  };
  return { actions: new HelixActions(projects), projects, records, calls };
}

test('内网凭据仅接受足长秘密的精确 Bearer 值', () => {
  const secret = 's'.repeat(32);
  assert.equal(internalAuthorized(`Bearer ${secret}`, secret), true);
  for (const header of [undefined, null, [], {}, '', secret, `bearer ${secret}`, `Bearer ${secret} `, `Bearer ${'x'.repeat(32)}`]) assert.equal(internalAuthorized(header, secret), false);
  for (const invalid of [undefined, null, '', 'short']) assert.equal(internalAuthorized(`Bearer ${secret}`, invalid), false);
});

test('工具参数契约封闭且删除要求明确目标与版本', async () => {
  assert.ok(helixTools.every(t => t.inputSchema.additionalProperties === false));
  const f = fixture();
  for (const args of [
    { projectId, targetId: pageId, kind: 'page', revision },
    { projectId, targetId: pageId, kind: 'page', confirmTargetId: pageId },
    { projectId, targetId: pageId, kind: 'page', revision, confirmTargetId: pageId, permanent: true },
  ]) await assert.rejects(f.actions.call('helix_delete', args), { status: 400 });
  assert.equal(f.calls.length, 0);
});

test('真实父链允许项目直属及深层页面、块和数据库', async () => {
  const f = fixture();
  for (const [targetId, kind] of [[projectId, 'page'], [databaseId, 'database'], [pageId, 'page'], [blockId, 'block']]) {
    const result = await f.actions.target(projectId, targetId, kind); assert.equal(result.data.id, targetId);
  }
});

test('跨项目与冒充项目根在写入前拒绝', async () => {
  const f = fixture();
  await assert.rejects(f.actions.target(projectId, otherPageId, 'page'), { status: 403 });
  await assert.rejects(f.actions.target(pageId, blockId, 'block'), { status: 403 });
  await assert.rejects(f.actions.target(projectId, projectId, 'database'), { status: 400 });
  f.projects.allowed = [otherProjectId];
  await assert.rejects(f.actions.target(projectId, pageId, 'page'), { status: 403 });
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('循环父链与超过深度上限的父链不能绕过范围', async () => {
  const f = fixture();
  f.records.get(pageId).parent = { block_id: blockId }; f.records.get(blockId).parent = { page_id: pageId };
  await assert.rejects(f.actions.target(projectId, pageId, 'page'), { status: 403 });
  assert.ok(f.calls.length <= 5);
  let previous = pageId;
  for (let i = 0; i < 65; i++) {
    const next = `${i + 100}`.padStart(8, '0') + '-1111-4111-8111-111111111111';
    f.records.get(previous).parent = { block_id: next }; f.records.set(next, { id: next, parent: { page_id: projectId } }); previous = next;
  }
  await assert.rejects(f.actions.target(projectId, pageId, 'page'), { status: 403 });
});

test('回收站目标仅允许显式读取，已删除祖先始终阻断子对象操作', async () => {
  const f = fixture(); f.records.get(pageId).in_trash = true;
  await assert.rejects(f.actions.target(projectId, pageId, 'page'), { status: 404 });
  assert.equal((await f.actions.target(projectId, pageId, 'page', { allowTrash: true })).data.id, pageId);
  for (const allowTrash of [false, true]) await assert.rejects(f.actions.target(projectId, blockId, 'block', { allowTrash }), { status: 403 });
  f.records.get(pageId).in_trash = false; f.records.get(projectId).archived = true;
  await assert.rejects(f.actions.target(projectId, pageId, 'page', { allowTrash: true }), { status: 403 });
});

test('额外属性不能通过名称或属性 ID 覆盖工作流字段', async () => {
  const f = fixture();
  const properties = {
    来源实验: { id: 'source-field', type: 'relation' }, 状态: { id: 'state-field', type: 'select' },
    编号: { id: 'number-field', type: 'formula' }, 'Canvas 状态': { id: 'canvas-field', type: 'rich_text' },
    实验内容: { id: 'title-field', type: 'title' }, 完成日期: { id: 'date-field', type: 'date' },
  };
  const page = { properties }, reserved = ['来源实验', '状态', '编号', 'Canvas 状态'];
  for (const name of ['来源实验', 'source-field', '状态', 'state-field', '编号', 'number-field', 'Canvas 状态', 'canvas-field', '实验内容', 'title-field']) {
    const field = properties[name] || Object.values(properties).find(p => p.id === name);
    await assert.rejects(f.actions.properties(projectId, page, { [name]: { type: field.type } }, reserved), { status: 400 });
  }
  await f.actions.properties(projectId, page, { 完成日期: { type: 'date', date: { start: '2026-10-27' } } }, reserved);
  assert.equal(f.calls.length, 0);
});

test('额外关联不能注入其他项目页面', async () => {
  const f = fixture(); const page = { properties: { 相关记录: { id: 'relation', type: 'relation' } } };
  await assert.rejects(f.actions.properties(projectId, page, { 相关记录: { type: 'relation', relation: [{ id: otherPageId }] } }), { status: 403 });
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('项目内额外关联通过范围预检，关联字段的表约束交由 FlowUs 校验', async () => {
  const f = fixture(); f.records.get(otherPageId).parent = { database_id: otherDatabaseId };
  const page = { parent: { database_id: databaseId }, properties: { 相关记录: { id: 'relation', type: 'relation', relation: { database_id: databaseId } } } };
  await f.actions.properties(projectId, page, { 相关记录: { type: 'relation', relation: [{ id: otherPageId }] } });
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('删除预览不写入；目标或版本不匹配均不删除', async () => {
  const f = fixture(); const args = { projectId, targetId: pageId, kind: 'page' };
  const preview = await f.actions.call('helix_delete_preview', args);
  assert.equal(preview.confirmTargetId, pageId); assert.equal(preview.revision, revision); assert.equal(preview.inTrash, false);
  await assert.rejects(f.actions.call('helix_delete', { ...args, revision, confirmTargetId: blockId }), { status: 400 });
  await assert.rejects(f.actions.call('helix_delete', { ...args, revision: 'stale', confirmTargetId: pageId }), { status: 409 });
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0); assert.equal(f.records.get(pageId).in_trash, undefined);
});

test('已授权删除读回回收站状态，重复调用不重复删除', async () => {
  const f = fixture(); const args = { projectId, targetId: ancestorId, kind: 'page', revision, confirmTargetId: ancestorId };
  const first = await f.actions.call('helix_delete', args); assert.equal(first.inTrash, true);
  const second = await f.actions.call('helix_delete', args); assert.equal(second.inTrash, true);
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 1);
  const result = await f.actions.call('helix_restore', { projectId, targetId: ancestorId, kind: 'page' }); assert.equal(result.inTrash, false);
});

test('实际项目及实验更新入口保护额外字段，拒绝前不发送 PATCH', async () => {
  const f = fixture();
  f.records.get(projectId).properties['Canvas 状态'] = { id: 'canvas-field', type: 'rich_text' };
  for (const name of ['Canvas 状态', 'canvas-field']) await assert.rejects(f.actions.call('helix_project_update', { projectId, revision, properties: { [name]: { type: 'rich_text', rich_text: [] } } }), { status: 400 });
  f.records.get(pageId).properties = { 来源实验: { id: 'source-field', type: 'relation' }, 状态: { id: 'state-field', type: 'select' }, 编号: { id: 'number-field', type: 'formula' } };
  f.projects.load = async () => ({ databaseId, nodes: [{ id: pageId }] });
  for (const [name, type] of [['来源实验', 'relation'], ['source-field', 'relation'], ['状态', 'select'], ['state-field', 'select'], ['编号', 'formula'], ['number-field', 'formula']]) await assert.rejects(f.actions.call('helix_experiment_update', { projectId, experimentId: pageId, revision, properties: { [name]: { type } } }), { status: 400 });
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 0);
});

test('删除 API 明确失败时不报告成功，后续重试仍先读取目标', async () => {
  const f = fixture(); const original = f.projects.api.request;
  f.projects.api.request = async (method, ...args) => {
    if (method === 'DELETE') throw Object.assign(new Error('provider rejected delete'), { status: 503 });
    return original(method, ...args);
  };
  const args = { projectId, targetId: ancestorId, kind: 'page', revision, confirmTargetId: ancestorId };
  await assert.rejects(f.actions.call('helix_delete', args), { status: 503 });
  assert.equal(f.records.get(ancestorId).in_trash, undefined);
  f.projects.api.request = original;
  assert.equal((await f.actions.call('helix_delete', args)).inTrash, true);
});

test('删除回执已确认，即使回收站不能读取也返回已保存', async () => {
  const f = fixture(); const original = f.projects.api.request; let deleted = false;
  f.projects.api.request = async (method, ...args) => {
    if (deleted) throw Object.assign(new Error('recycle bin forbidden'), { status: 403 });
    const result = await original(method, ...args);
    if (method === 'DELETE') { deleted = true; return { data: { id: ancestorId, object: 'page', in_trash: true } }; }
    return result;
  };
  const result = await f.actions.call('helix_delete', { projectId, targetId: ancestorId, kind: 'page', revision, confirmTargetId: ancestorId });
  assert.equal(result.saved, true); assert.equal(result.inTrash, true);
  await assert.rejects(f.actions.call('helix_restore', { projectId, targetId: ancestorId, kind: 'page' }), { status: 403 });
});

test('清理已删除来源仅移除指定 ID，保留其他来源且传递 ETag', async () => {
  const f = fixture(); let written;
  f.projects.load = async () => ({ databaseId, nodes: [{ id: pageId, sourceIds: [ancestorId, otherPageId] }] });
  f.records.get(pageId).properties = { 来源实验: { type: 'relation', relation: [{ id: ancestorId }, { id: otherPageId }] } };
  const original = f.projects.api.request;
  f.projects.api.request = async (method, path, body, etag) => { if (method === 'PATCH') written = {body, etag}; return original(method,path,body); };
  await f.actions.detachDeletedSource('demo', ancestorId);
  assert.deepEqual(written, { body: { properties: { 来源实验: { type: 'relation', relation: [{ id: otherPageId }] } } }, etag: revision });
});

test('项目根不能通过普通块删除路径绕过页面流程', async () => {
  const f = fixture();
  await assert.rejects(f.actions.call('helix_delete_preview', { projectId, targetId: projectId, kind: 'block' }), { status: 400 });
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('普通资料页创建同请求并发去重，未知结果不跨 OAuth 刷新盲重放', async () => {
  const f = fixture(); const original = f.projects.api.request; let writes = 0;
  f.projects.api.request = async (method,...args) => {
    if (method === 'POST') { writes++; return {data:{id:ancestorId},etag:revision}; }
    return original(method,...args);
  };
  const input = {projectId,parentId:projectId,title:'资料页',requestId:'page-create-test-20261027'};
  const results = await Promise.all([f.actions.call('helix_page_create',input),f.actions.call('helix_page_create',input)]);
  assert.equal(writes,1); assert.deepEqual(results[0],results[1]);
  await assert.rejects(f.actions.call('helix_page_create',{...input,title:'另一个标题'}),{status:409});
  f.projects.api.request = async (method,...args) => { if(method === 'POST'){writes++;throw Object.assign(new Error('unknown result'),{status:503});}return original(method,...args); };
  const uncertain = {...input,requestId:'page-unknown-test-20261027'};
  for(let i=0;i<2;i++) await assert.rejects(f.actions.call('helix_page_create',uncertain),{status:503});
  assert.equal(writes,2);
});
