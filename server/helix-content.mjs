import { createHash, randomUUID } from 'node:crypto';
import { ServiceError } from './flowus.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new ServiceError(400, message); };
const textFields = ['rich_text', 'text_color', 'background_color', 'color', 'text_align'];
const fields = Object.fromEntries(['paragraph', 'quote', 'toggle', 'bulleted_list_item', 'numbered_list_item'].map(type => [type, textFields]));
for (const type of ['heading_1', 'heading_2', 'heading_3']) fields[type] = [...textFields, 'is_toggleable'];
Object.assign(fields, { to_do: [...textFields, 'checked'], code: ['rich_text', 'language', 'display_mode', 'text_align'], equation: ['expression'], divider: [], callout: [...textFields, 'icon'], table: ['table_width', 'has_column_header', 'has_row_header', 'width_mode'], table_row: ['cells'], column_list: [], column: ['width_ratio'] });
const mime = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/tiff', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'text/plain', 'text/csv', 'text/markdown', 'text/html', 'application/zip', 'application/x-rar-compressed', 'application/gzip', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'video/mp4', 'video/webm', 'video/quicktime', 'application/json', 'application/xml', 'application/octet-stream']);
const idSchema = { type: 'string', format: 'uuid' };
const string = { type: 'string' };
function manifest(name, description, properties, required, readOnly = false) {
  /** 生成封闭工具参数；输入字段定义，输出 MCP 工具描述。 */
  return { name, description, inputSchema: { type: 'object', properties: { projectId: idSchema, ...properties }, required: ['projectId', ...required], additionalProperties: false }, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false } };
}
export const contentTools = [
  manifest('helix_content_read', '读取项目内页面或块及一页直接子块；游标原样续读。', { targetId: idSchema, kind: { enum: ['page', 'block'] }, cursor: string }, ['targetId', 'kind'], true),
  manifest('helix_content_append', '追加项目内原生正文；相同 requestId 仅在本进程去重，未知结果禁止重放。媒体使用附件工具。', { targetId: idSchema, children: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object' } }, requestId: string }, ['targetId', 'children', 'requestId']),
  manifest('helix_content_update', '修改现有块的正文和格式；revision 仅作预读检查，官方未承诺块更新原子版本锁。', { blockId: idSchema, patch: { type: 'object' }, revision: string }, ['blockId', 'patch', 'revision']),
  manifest('helix_file_prepare', '申请不超过 100 MiB 的内部文件上传；按返回 method/headers 上传原始字节，随后 attach。', { pageId: idSchema, name: string, size: { type: 'integer', minimum: 1, maximum: 104857600 }, contentType: { type: 'string', enum: [...mime] } }, ['pageId', 'name', 'size', 'contentType']),
  manifest('helix_file_attach', '客户端须提供实际 PUT 成功响应状态；按本进程上传交易追加内部文件并回读元数据，不独立核验存储字节。', { pageId: idSchema, uploadId: string, uploadStatus: { type: 'integer', enum: [200, 201, 204] } }, ['pageId', 'uploadId', 'uploadStatus']),
];
function keys(value, allowed) {
  /** 拒绝隐藏的结构或身份字段；输入对象和白名单，无返回值。 */
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('正文包含不支持的字段');
}
function rich(items) {
  /** 只接收文字与公式；引用对象需另走明确的项目关系工具。 */
  if (!Array.isArray(items) || items.length > 1000) fail('富文本须为最多 1000 项的数组');
  for (const item of items) {
    keys(item, ['type', 'text', 'equation', 'annotations', 'plain_text', 'href']);
    if (item.type === 'text') {
      keys(item.text, ['content', 'link']);
      if (typeof item.text.content !== 'string') fail('文字内容必须为字符串');
      if (item.text.link != null) {
        keys(item.text.link, ['url']);
        if (typeof item.text.link.url !== 'string' || !/^https?:\/\//i.test(item.text.link.url)) fail('文字链接仅支持 HTTP(S)');
      }
    } else if (item.type === 'equation') {
      keys(item.equation, ['expression']); if (typeof item.equation.expression !== 'string') fail('公式必须为字符串');
    } else fail('正文暂仅支持文字与公式富文本');
    if (item.annotations !== undefined) keys(item.annotations, ['bold', 'italic', 'strikethrough', 'underline', 'code', 'color', 'text_color', 'background_color']);
  }
}
function payload(type, value) {
  /** 校验块内容字段；输入当前类型与局部内容，输出独立副本。 */
  if (!fields[type]) fail('该块类型不支持通用正文修改');
  keys(value, fields[type]);
  if (value.rich_text !== undefined) rich(value.rich_text);
  if (value.cells !== undefined) { if (!Array.isArray(value.cells)) fail('表格行须包含单元格数组'); for (const cell of value.cells) rich(cell); }
  if (value.icon != null) { keys(value.icon, ['type', 'emoji']); if (value.icon.type !== 'emoji' || typeof value.icon.emoji !== 'string') fail('提示块仅支持 emoji 图标'); }
  return structuredClone(value);
}
function children(values, depth = 0, budget = { count: 0 }) {
  /** 递归校验原生正文；限制总量并禁止跨对象结构与任意媒体来源。 */
  if (!Array.isArray(values) || values.length > 100 || depth > 20 || (depth === 0 && values.length === 0)) fail('正文每层最多 100 块、最多 20 层');
  return values.map(block => {
    if (++budget.count > 1000) fail('单次正文最多 1000 块');
    if (!object(block) || !fields[block.type]) fail('仅支持原生文本、表格和列；媒体请使用附件工具');
    keys(block, ['object', 'type', block.type, 'children']);
    if (block.object !== undefined && block.object !== 'block') fail('正文 object 必须为 block');
    const out = { type: block.type, [block.type]: payload(block.type, block[block.type]) };
    if (block.type === 'table') out.table.width_mode ??= 'adaptive'; // 新表默认匹配页面宽度。
    if (block.children !== undefined) out.children = children(block.children, depth + 1, budget);
    return out;
  });
}

export class HelixContent {
  constructor(scope) {
    /** 接收项目范围和 API；在当前实例保留追加与上传交易，防止盲重放。 */
    this.scope = scope; this.appends = new Map(); this.uploads = new Map();
  }
  async call(name, args) {
    /** 分发封闭工具；先校验调用参数，再执行有项目范围的操作。 */
    const tool = contentTools.find(item => item.name === name);
    if (!tool) throw new ServiceError(404, '未知正文工具');
    keys(args, Object.keys(tool.inputSchema.properties));
    if (tool.inputSchema.required.some(key => args[key] === undefined)) fail('缺少工具必填参数');
    for (const key of ['projectId', 'targetId', 'blockId', 'pageId']) if (args[key] !== undefined && !uuid(args[key])) fail('项目与目标必须为 UUID');
    if (name === 'helix_content_read') return this.read(args);
    if (name === 'helix_content_append') return this.append(args);
    if (name === 'helix_content_update') return this.update(args);
    if (name === 'helix_file_prepare') return this.prepare(args);
    return this.attach(args);
  }
  async read({ projectId, targetId, kind, cursor }) {
    /** 返回目标元数据及一页直属内容；不递归读取跨页面后代。 */
    if (!['page', 'block'].includes(kind) || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 10000))) fail('正文类型或游标无效');
    const { data, etag } = await this.scope.target(projectId, targetId, kind);
    const params = new URLSearchParams({ page_size: '100', ...(cursor ? { start_cursor: cursor } : {}) });
    const { data: page } = await this.scope.api.request('GET', `/blocks/${targetId}/children?${params}`);
    if (!Array.isArray(page.results) || (page.has_more && !page.next_cursor)) throw new ServiceError(503, '正文分页响应不完整');
    return { target: data, revision: etag, children: page.results, hasMore: Boolean(page.has_more), cursor: page.has_more ? page.next_cursor : null };
  }
  async append({ projectId, targetId, children: values, requestId }) {
    /** 追加校验后的正文；相同请求复用结果，未知结果保留并拒绝盲重放。 */
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) fail('requestId 须为 8–128 位字母、数字、下划线或短横线');
    const body = { children: children(values) }; const key = `${projectId}:${requestId}`;
    const digest = createHash('sha256').update(JSON.stringify({ targetId, body })).digest('hex');
    await this.scope.target(projectId, targetId, 'block');
    const prior = this.appends.get(key);
    if (prior) { if (prior.digest !== digest) throw new ServiceError(409, 'requestId 已用于不同正文'); return prior.promise; }
    if (this.appends.size >= 1000) throw new ServiceError(503, '本进程追加请求记录已满，请先核对已有操作');
    const promise = this.scope.api.request('PATCH', `/blocks/${targetId}/children`, body).then(async result => { await this.scope.invalidate(projectId); return result; });
    this.appends.set(key, { digest, promise });
    return promise;
  }
  async update({ projectId, blockId, patch, revision }) {
    /** 仅更新现有块内容；版本比对仅保证预检，不承诺原子乐观锁。 */
    if (typeof revision !== 'string' || !revision) fail('必须提供读取时的 revision');
    const current = await this.scope.target(projectId, blockId, 'block');
    if (!current.etag || current.etag !== revision) throw new ServiceError(409, '正文版本已变化或无法验证，请重新读取');
    keys(patch, [current.data.type]);
    if (Object.keys(patch).length !== 1) fail('更新必须包含当前块类型的正文');
    const body = { [current.data.type]: payload(current.data.type, patch[current.data.type]) };
    const result = await this.scope.api.request('PATCH', `/blocks/${blockId}`, body);
    await this.scope.invalidate(projectId);
    return { ...result, revisionProtection: 'preflight-only' };
  }
  async prepare({ projectId, pageId, name, size, contentType }) {
    /** 申请上传交易；记录服务端返回的完整对象信息，不信任客户端媒体地址。 */
    if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\u0000-\u001f/\\]/.test(name) || !Number.isSafeInteger(size) || size < 1 || size > 104857600 || !mime.has(contentType)) fail('文件名、大小或 MIME 不符合上传限制');
    await this.scope.target(projectId, pageId, 'page');
    for (const [id, entry] of this.uploads) if (entry.expires < Date.now()) this.uploads.delete(id); // 过期交易不可重用，及时释放记录。
    if (this.uploads.size >= 100) throw new ServiceError(503, '待处理上传过多，请先完成已有上传');
    const { data } = await this.scope.api.request('POST', '/files/upload-url', { filename: name, content_type: contentType, content_length: size, parent: { page_id: pageId } });
    const expires = Date.parse(data.expiry_time);
    if (data.method !== 'PUT' || data.size !== size || !data.oss_name || !data.upload_url || !object(data.headers) || !Number.isFinite(expires) || expires <= Date.now()) throw new ServiceError(503, '上传交易响应不完整');
    const uploadId = randomUUID(); this.uploads.set(uploadId, { projectId, pageId, contentType, data: structuredClone(data), expires });
    return { uploadId, method: data.method, uploadUrl: data.upload_url, headers: data.headers, size, expiresAt: data.expiry_time };
  }
  async attach({ projectId, pageId, uploadId, uploadStatus }) {
    /** 以客户端 PUT 回执追加内部文件并回读元数据；不声称独立验证真实字节。 */
    if (!Number.isInteger(uploadStatus) || ![200, 201, 204].includes(uploadStatus)) fail('uploadStatus 必须来自实际 PUT 的 200、201 或 204 响应');
    const entry = this.uploads.get(uploadId);
    if (!entry || entry.projectId !== projectId || entry.pageId !== pageId) throw new ServiceError(404, '找不到当前项目页面的上传交易');
    await this.scope.target(projectId, pageId, 'page');
    if (entry.pending) return entry.pending;
    if (entry.expires <= Date.now()) throw new ServiceError(409, '上传交易已过期，请重新申请');
    entry.pending = (async () => {
      const body = { children: [{ type: 'file', file: { type: 'file', file: { oss_name: entry.data.oss_name, size: entry.data.size, content_type: entry.contentType } } }] };
      entry.writeStarted = true; // 请求发出后保留结果，连接中断时也不重复追加。
      const result = await this.scope.api.request('PATCH', `/blocks/${pageId}/children`, body);
      await this.scope.invalidate(projectId);
      const blockId = result.data?.results?.[0]?.id;
      if (!uuid(blockId)) throw new ServiceError(503, '附件已提交但新块 ID 无法确认，请先核对页面');
      const { data: block } = await this.scope.api.request('GET', `/blocks/${blockId}`);
      const file = block.file?.file;
      if (block.id !== blockId || block.type !== 'file' || block.file?.type !== 'file' || file?.oss_name !== entry.data.oss_name || file?.size !== entry.data.size || (file?.content_type !== undefined && file.content_type !== entry.contentType)) throw new ServiceError(503, '附件已提交但内部文件元数据未核验通过，请先核对页面');
      return { ...result, verification: 'client-put-receipt-and-flowus-block-readback', mimeSource: file.content_type === undefined ? 'upload-request' : 'flowus-block-readback' };
    })().catch(error => { if (!entry.writeStarted) entry.pending = null; throw error; });
    return entry.pending;
  }
}
