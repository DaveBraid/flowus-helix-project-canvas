import test from 'node:test';
import assert from 'node:assert/strict';
import { HelixContent, contentTools } from '../server/helix-content.mjs';

const projectId = '11111111-1111-4111-8111-111111111111';
const pageId = '22222222-2222-4222-8222-222222222222';
const foreignId = '33333333-3333-4333-8333-333333333333';
const createdId = '44444444-4444-4444-8444-444444444444';
const revision = 'W/"2026-10-27T00:00:00Z"';
const paragraph = { type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '正文' } }] } };
function fixture() {
  const calls = []; const scopes = []; let invalidations = 0;
  const file = { object: 'file_upload', method: 'PUT', upload_url: 'https://upload.example.test/object', file_url: 'https://cdn.flowus.cn/object', oss_name: 'oss/object/file.txt', size: 5, headers: { 'Content-Type': 'text/plain' }, expiry_time: new Date(Date.now() + 600000).toISOString() };
  const readback = { id: createdId, type: 'file', file: { type: 'file', file: { oss_name: file.oss_name, size: 5, content_type: 'text/plain' } } };
  let failWrite = false; let failReadback = false;
  const scope = {
    api: {
      request: async (method, path, body) => {
        calls.push({ method, path, body });
        if (path === '/files/upload-url') return { data: structuredClone(file) };
        if (method === 'GET' && path === `/blocks/${createdId}`) {
          if (failReadback) throw Object.assign(new Error('回读失败'), { status: 503 });
          return { data: structuredClone(readback) };
        }
        if (method === 'GET') return { data: { results: [{ id: 'one' }], has_more: true, next_cursor: 'next cursor' } };
        if (failWrite) throw Object.assign(new Error('未知写入结果'), { status: 503 });
        return { data: { object: 'list', results: [{ id: createdId }] }, etag: revision };
      },
      fetch: async () => { throw new Error('附件 attach 不应访问匿名 CDN'); },
    },
    target: async (pid, id, kind) => {
      scopes.push({ pid, id, kind });
      if (pid !== projectId || id !== pageId) throw Object.assign(new Error('范围错误'), { status: 403 });
      return { data: { id, type: 'paragraph' }, etag: revision };
    },
    invalidate: async () => { invalidations++; },
  };
  return { service: new HelixContent(scope), calls, scopes, file, readback, get invalidations() { return invalidations; }, failWrite: () => { failWrite = true; }, failReadback: () => { failReadback = true; } };
}
const append = { projectId, targetId: pageId, children: [paragraph], requestId: 'request-00001' };
const prepare = { projectId, pageId, name: 'file.txt', size: 5, contentType: 'text/plain' };

test('manifest 封闭参数，读取仅查询一页直属块并编码游标', async () => {
  const f = fixture(); const value = await f.service.call('helix_content_read', { projectId, targetId: pageId, kind: 'page', cursor: 'a&b' });
  assert.equal(contentTools.length, 5); assert.ok(contentTools.every(t => t.inputSchema.additionalProperties === false));
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, `/blocks/${pageId}/children?page_size=100&start_cursor=a%26b`);
  assert.equal(value.cursor, 'next cursor'); assert.deepEqual(f.scopes[0], { pid: projectId, id: pageId, kind: 'page' });
});
test('越界对象与路径注入在业务 API 前拒绝', async () => {
  const f = fixture();
  await assert.rejects(f.service.call('helix_content_read', { projectId, targetId: foreignId, kind: 'block' }), { status: 403 });
  await assert.rejects(f.service.call('helix_content_read', { projectId, targetId: '../secret', kind: 'block' }), { status: 400 });
  assert.equal(f.calls.length, 0);
});
test('追加并发和重试复用一次结果，同 key 不同内容冲突', async () => {
  const f = fixture(); await Promise.all([f.service.call('helix_content_append', append), f.service.call('helix_content_append', append)]);
  await f.service.call('helix_content_append', append); assert.equal(f.calls.length, 1); assert.equal(f.invalidations, 1);
  await assert.rejects(f.service.call('helix_content_append', { ...append, children: [{ type: 'divider', divider: {} }] }), { status: 409 });
});
test('未知追加结果不盲重发，错误仍返回调用方', async () => {
  const f = fixture(); f.failWrite();
  for (let i = 0; i < 2; i++) await assert.rejects(f.service.call('helix_content_append', append), { status: 503 });
  assert.equal(f.calls.length, 1);
});
test('跨对象块、任意媒体与结构字段全部拒绝', async () => {
  const f = fixture();
  for (const type of ['child_page', 'child_database', 'synced_block', 'link_to_page', 'image', 'file', 'embed']) await assert.rejects(f.service.call('helix_content_append', { ...append, children: [{ type, [type]: {} }] }), { status: 400 });
  await assert.rejects(f.service.call('helix_content_append', { ...append, children: [{ ...paragraph, parent: pageId }] }), { status: 400 });
  const mention = { type: 'paragraph', paragraph: { rich_text: [{ type: 'mention', mention: { page: { id: foreignId } } }] } };
  await assert.rejects(f.service.call('helix_content_append', { ...append, children: [mention] }), { status: 400 });
  assert.equal(f.calls.length, 0);
});
test('新表默认自适应且嵌套超量被拒绝', async () => {
  const f = fixture(); await f.service.call('helix_content_append', { ...append, children: [{ type: 'table', table: { table_width: 1 }, children: [{ type: 'table_row', table_row: { cells: [[]] } }] }] });
  assert.equal(f.calls[0].body.children[0].table.width_mode, 'adaptive');
  await assert.rejects(f.service.call('helix_content_append', { ...append, children: Array.from({ length: 101 }, () => paragraph) }), { status: 400 });
});
test('块修改仅允许当前类型正文，明确预检版本保护', async () => {
  const f = fixture(); const args = { projectId, blockId: pageId, patch: { paragraph: paragraph.paragraph }, revision };
  for (const patch of [{ ...args.patch, archived: true }, { type: 'heading_1' }, { file: {} }, { paragraph: { synced_from: pageId } }]) await assert.rejects(f.service.call('helix_content_update', { ...args, patch }), { status: 400 });
  await assert.rejects(f.service.call('helix_content_update', { ...args, revision: 'old' }), { status: 409 });
  const result = await f.service.call('helix_content_update', args); assert.equal(result.revisionProtection, 'preflight-only'); assert.equal(f.calls.length, 1);
});
test('附件以客户端PUT成功回执追加并回读，重复调用仅写一次且不访问CDN', async () => {
  const f = fixture(); const upload = await f.service.call('helix_file_prepare', prepare);
  assert.equal(upload.method, 'PUT'); assert.equal(upload.uploadUrl, f.file.upload_url); assert.equal(upload.oss_name, undefined);
  const args = { projectId, pageId, uploadId: upload.uploadId, uploadStatus: 200 };
  const results = await Promise.all([f.service.call('helix_file_attach', args), f.service.call('helix_file_attach', args)]);
  assert.ok(results.every(result => result.verification === 'client-put-receipt-and-flowus-block-readback'));
  assert.ok(results.every(result => result.mimeSource === 'flowus-block-readback'));
  await f.service.call('helix_file_attach', { ...args, uploadStatus: 201 });
  const writes = f.calls.filter(c => c.method === 'PATCH'); assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body.children[0].file.file, { oss_name: f.file.oss_name, size: 5, content_type: 'text/plain' });
  assert.equal(f.calls.filter(c => c.method === 'GET' && c.path === `/blocks/${createdId}`).length, 1);
});
test('附件必须提供有效整数PUT状态，不接受失败状态或缺失回执', async () => {
  const f = fixture(); const { uploadId } = await f.service.call('helix_file_prepare', prepare); const args = { projectId, pageId, uploadId };
  await assert.rejects(f.service.call('helix_file_attach', args), { status: 400 });
  for (const uploadStatus of [0, 202, 206, 302, 403, 500, '200', 200.5, null]) await assert.rejects(f.service.call('helix_file_attach', { ...args, uploadStatus }), { status: 400 });
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 0);
  await f.service.call('helix_file_attach', { ...args, uploadStatus: 204 });
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 1);
});
test('附件拒绝伪造交易、跨页或跨项目交易以及客户端元数据注入', async () => {
  const f = fixture(); const { uploadId } = await f.service.call('helix_file_prepare', prepare);
  const args = { projectId, pageId, uploadId, uploadStatus: 200 };
  await assert.rejects(f.service.call('helix_file_attach', { ...args, pageId: foreignId }), { status: 404 });
  await assert.rejects(f.service.call('helix_file_attach', { ...args, projectId: foreignId }), { status: 404 });
  await assert.rejects(f.service.call('helix_file_attach', { ...args, uploadId: 'fake' }), { status: 404 });
  await assert.rejects(f.service.call('helix_file_attach', { ...args, oss_name: 'foreign' }), { status: 400 });
  assert.equal(f.calls.length, 1);
});
test('附件大小及MIME严格匹配官方范围，未知追加结果不重发', async () => {
  const f = fixture();
  for (const value of [{ size: 104857601 }, { size: 0 }, { contentType: 'image/unknown' }, { name: '../file.txt' }]) await assert.rejects(f.service.call('helix_file_prepare', { ...prepare, ...value }), { status: 400 });
  const { uploadId } = await f.service.call('helix_file_prepare', prepare); f.failWrite();
  for (let i = 0; i < 2; i++) await assert.rejects(f.service.call('helix_file_attach', { projectId, pageId, uploadId, uploadStatus: 200 }), { status: 503 });
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 1);
});
test('附件回读失败或内部元数据不匹配时保留写入结果，禁止重复追加', async () => {
  for (const alter of [f => f.failReadback(), f => { f.readback.file.file.oss_name = 'foreign'; }, f => { f.readback.file.file.size = 6; }, f => { f.readback.file.file.content_type = 'image/png'; }]) {
    const f = fixture(); const { uploadId } = await f.service.call('helix_file_prepare', prepare); alter(f);
    const args = { projectId, pageId, uploadId, uploadStatus: 200 };
    for (let i = 0; i < 2; i++) await assert.rejects(f.service.call('helix_file_attach', args), { status: 503 });
    assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 1); assert.equal(f.invalidations, 1);
  }
});
test('兼容真实内部文件回读省略MIME，来源明确标注上传请求且不重复追加', async () => {
  const f = fixture();
  f.readback.file.caption = []; delete f.readback.file.file.content_type;
  const { uploadId } = await f.service.call('helix_file_prepare', prepare);
  const args = { projectId, pageId, uploadId, uploadStatus: 200 };
  const result = await f.service.call('helix_file_attach', args);
  assert.equal(result.verification, 'client-put-receipt-and-flowus-block-readback'); assert.equal(result.mimeSource, 'upload-request');
  await f.service.call('helix_file_attach', args); assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 1);
});
