import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** 由人工验收入口显式调用；输入已配置的 HelixActions 和测试页，输出无秘密的上传结果。 */
export async function verifyContentUpload(actions, { projectId, pageId }, fetchImpl = fetch) {
  const bytes = new TextEncoder().encode(`Helix MCP upload verification ${randomUUID()}\n`);
  const prepared = await actions.call('helix_file_prepare', { projectId, pageId, name: `helix-upload-check-${Date.now()}.txt`, size: bytes.byteLength, contentType: 'text/plain' });
  const url = new URL(prepared.uploadUrl);
  assert.equal(url.protocol, 'https:'); assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(prepared.method, 'PUT');
  assert.equal(Object.keys(prepared.headers).some(key => key.toLowerCase() === 'content-length'), false); // 由客户端计算真实字节数。
  const response = await fetchImpl(url.href, { method: 'PUT', headers: prepared.headers, body: bytes, redirect: 'error', signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, `对象存储上传失败：${response.status}`);
  await response.arrayBuffer(); // 读完上传响应，及时释放连接。
  const attached = await actions.call('helix_file_attach', { projectId, pageId, uploadId: prepared.uploadId, uploadStatus: response.status });
  const blockId = attached.data?.results?.[0]?.id;
  assert.ok(blockId, '附件追加未返回新块 ID');
  const { data: block } = await actions.api.request('GET', `/blocks/${blockId}`);
  assert.equal(block.type, 'file'); assert.equal(block.file?.type, 'file');
  assert.equal(block.file.file.size, bytes.byteLength); assert.ok(block.file.file.oss_name);
  if (block.file.file.content_type !== undefined) assert.equal(block.file.file.content_type, 'text/plain');
  assert.equal(attached.verification, 'client-put-receipt-and-flowus-block-readback');
  return { projectId, pageId, blockId, bytes: bytes.byteLength, storagePutStatus: response.status, verification: attached.verification, mimeSource: attached.mimeSource, independentStoredBytesVerified: false, cleanupRequired: true };
}

// 仅导出函数；node --test 或 import 不会执行真实写入，也不自动删除验收附件。
