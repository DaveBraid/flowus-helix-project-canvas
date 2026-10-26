import { stageNumbers } from './numbering.mjs';
import { createHash } from 'node:crypto';
import { ServiceError, plain, alive, graphRecords } from './flowus.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const textFields = ['rich_text', 'text_color', 'background_color', 'text_align'];
const blockFields = Object.fromEntries(['paragraph', 'quote', 'toggle', 'bulleted_list_item', 'numbered_list_item'].map(type => [type, textFields]));
for (const type of ['heading_1', 'heading_2', 'heading_3']) blockFields[type] = [...textFields, 'is_toggleable'];
Object.assign(blockFields, { to_do: [...textFields, 'checked'], code: ['rich_text', 'language', 'display_mode', 'text_align'], equation: ['expression'], divider: [], callout: [...textFields, 'icon'], table: ['table_width', 'has_column_header', 'has_row_header', 'width_mode'], table_row: ['cells'], column_list: [], column: ['width_ratio'] });

/** 构造完整原生富文本；不把 API 输出专用的颜色别名带回写入。 */
export function richText(content, url = null) {
  return { type: 'text', annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, text_color: 'default', background_color: 'default' }, plain_text: content, href: url, text: { content, link: url ? { url } : null } };
}
function copyRichText(items) {
  if (!Array.isArray(items)) throw new ServiceError(409, '正文富文本结构异常，未创建实验');
  return items.map(item => {
    if (!['text', 'equation', 'mention'].includes(item?.type)) throw new ServiceError(409, '正文包含不支持的富文本，未创建实验');
    const out = { type: item.type, annotations: { ...richText('').annotations }, plain_text: item.plain_text ?? item.text?.content ?? '', href: item.href ?? null };
    for (const key of Object.keys(out.annotations)) if (item.annotations?.[key] !== undefined) out.annotations[key] = item.annotations[key];
    if (item.type === 'text') out.text = { content: item.text?.content ?? '', link: item.text?.link ? { url: item.text.link.url } : null };
    if (item.type === 'equation') out.equation = { expression: item.equation?.expression ?? '' };
    if (item.type === 'mention') {
      const type = item.mention?.type;
      if (type === 'page' || type === 'user') out.mention = { type, [type]: { id: item.mention[type]?.id } };
      else if (type === 'date') out.mention = { type, date: { ...item.mention.date } };
      else throw new ServiceError(409, '正文引用类型暂不支持，未创建实验');
    }
    return out;
  });
}

/** 读取并复制支持的原生块；遇到媒体或子页先停止，避免静默丢失正文。 */
async function copyBlocks(api, blocks, budget = { count: 0 }, depth = 0) {
  if (depth > 24 || blocks.length > 100) throw new ServiceError(413, '模板或引用正文层级过深或单层超过 100 块，未创建实验');
  const result = [];
  for (const block of blocks.filter(alive)) {
    if (++budget.count > 2000) throw new ServiceError(413, '模板及引用正文超过 2000 块，未创建实验');
    const fields = blockFields[block.type];
    if (!fields) throw new ServiceError(409, `模板或引用正文包含暂不支持的 ${block.type} 块，未创建实验`);
    const payload = block[block.type];
    if (!payload || typeof payload !== 'object') throw new ServiceError(409, '正文块结构异常，未创建实验');
    const value = {};
    for (const key of fields) if (payload[key] !== undefined) {
      if (key === 'rich_text' || key === 'caption') value[key] = copyRichText(payload[key]);
      else if (key === 'cells') value.cells = payload.cells.map(copyRichText);
      else if (key === 'icon') {
        if (payload.icon === null) value.icon = null;
        else if (payload.icon.type === 'emoji') value.icon = { type: 'emoji', emoji: payload.icon.emoji };
        else throw new ServiceError(409, '模板图标类型暂不支持，未创建实验');
      } else value[key] = payload[key];
    }
    const out = { object: 'block', type: block.type, [block.type]: value };
    if (block.has_children) out.children = await copyBlocks(api, await api.all('GET', `/blocks/${block.id}/children`), budget, depth + 1);
    result.push(out);
  }
  return result;
}
function headingLevel(block) { return /^heading_[123]$/.test(block.type) ? Number(block.type.at(-1)) : 0; }
function section(blocks, names) {
  const matches = blocks.map((block, i) => names.includes(plain(block[block.type]?.rich_text).trim()) && headingLevel(block) ? i : -1).filter(i => i >= 0);
  if (matches.length !== 1) throw new ServiceError(409, `无法唯一定位“${names[0]}”小节，未创建实验`);
  const start = matches[0]; const level = headingLevel(blocks[start]); let end = start + 1;
  while (end < blocks.length && !(headingLevel(blocks[end]) && headingLevel(blocks[end]) <= level)) end++;
  return { start, end, blocks: blocks.slice(start + 1, end) };
}
function titleValue(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 300 || /[\r\n\u0000-\u001f]/.test(value)) throw new ServiceError(400, '实验名称须为 1–300 字符的单行文本');
  return value.trim();
}
function sourceValues(values) {
  if (!Array.isArray(values) || values.length > 100 || values.some(id => !uuid(id)) || new Set(values.map(id => id.toLowerCase())).size !== values.length) throw new ServiceError(400, '来源须为最多 100 个不同的实验页面 ID');
  return values.map(id => id.toLowerCase()).sort();
}
function validateSources(graph, ids, target) {
  const known = new Set(graph.nodes.map(node => node.id));
  if (ids.some(id => !known.has(id) || id === target)) throw new ServiceError(400, '来源必须是当前实验表内其他有效实验');
  const edges = graph.edges.filter(edge => edge.target !== target).concat(ids.map(source => ({ source, target })));
  const visiting = new Set(); const visited = new Set(); const next = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of edges) if (next.has(edge.source) && next.has(edge.target)) next.get(edge.source).push(edge.target);
  const visit = id => {
    if (visiting.has(id)) throw new ServiceError(409, '来源关系形成循环，未保存');
    if (visited.has(id)) return;
    visiting.add(id); for (const child of next.get(id) || []) visit(child); visiting.delete(id); visited.add(id);
  };
  for (const id of next.keys()) visit(id);
}
function titleField(db) {
  const fields = Object.entries(db.properties || {}).filter(([, value]) => value.type === 'title');
  if (fields.length !== 1) throw new ServiceError(409, '实验表标题属性不唯一');
  return fields[0][0];
}
export const pageRevision = page => typeof page?.last_edited_time === 'string' ? `W/"${page.last_edited_time}"` : null; // 官方弱 ETag 以 last_edited_time 生成。

/** 实验写入只操作当前项目实验表；创建正文一次提交，按官方幂等键重试。 */
export class Experiments {
  constructor(projects, templateId) { this.projects = projects; this.templateId = templateId; this.creates = new Map(); }
  /** 按模板版本复用原生正文；输入无，输出独立副本，修改模板后自动重读。 */
  async template() {
    if (this.templatePending) return structuredClone(await this.templatePending);
    const pending = (async () => {
      if (!uuid(this.templateId)) throw new ServiceError(503, '服务尚未配置实验记录模板');
      const api = this.projects.api;
      const { data: page, etag } = await api.request('GET', `/pages/${this.templateId}`);
      if (!alive(page) || !etag) { this.templateCache = null; throw new ServiceError(409, '模板无效或缺少版本，未创建实验'); }
      if (this.templateCache?.revision === etag) return this.templateCache;
      this.templateCache = null;
      const blocks = await api.all('GET', `/blocks/${this.templateId}/children`);
      const target = section(blocks, ['本阶段问题聚焦', '本轮聚焦问题']);
      const budget = { count: 0 }; const children = await copyBlocks(api, blocks, budget);
      const { data: confirmed, etag: revision } = await api.request('GET', `/pages/${this.templateId}`);
      if (!alive(confirmed) || revision !== etag) throw new ServiceError(409, '准备期间模板已变化，未创建实验');
      return this.templateCache = { revision, children, start: target.start, count: budget.count };
    })();
    this.templatePending = pending;
    try { return structuredClone(await pending); } finally { if (this.templatePending === pending) this.templatePending = null; }
  }
  async create(slug, input) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['title', 'sourceIds', 'requestId'].includes(key))) throw new ServiceError(400, '新增实验参数无效');
    const title = titleValue(input.title); const ids = sourceValues(input.sourceIds);
    if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestId)) throw new ServiceError(400, '缺少有效的创建请求 ID');
    if (!uuid(this.templateId)) throw new ServiceError(503, '服务尚未配置实验记录模板');
    const fingerprint = JSON.stringify({ slug, title, ids }); const key = `${slug}:${input.requestId}`;
    let entry = this.creates.get(key);
    if (entry && entry.fingerprint !== fingerprint) throw new ServiceError(409, '同一创建请求不能更改内容，请先确认原请求结果');
    if (!entry) {
      if (this.creates.size >= 1000) {
        const done = [...this.creates].find(([, item]) => item.result);
        if (done) this.creates.delete(done[0]); // 已完成请求有界保留；未确认请求不能被静默淘汰。
      }
      if (this.creates.size >= 1000) throw new ServiceError(503, '创建请求缓存已满，请联系管理员确认待处理请求');
      entry = { fingerprint }; this.creates.set(key, entry);
    }
    this.creates.delete(key); this.creates.set(key, entry);
    return this.projects.withMutation(slug, async () => {
      if (entry.projectId) {
        const project = await this.projects.resolve(slug);
        if (project.id !== entry.projectId) throw new ServiceError(409, '项目简写已指向其他项目，禁止重放原创建请求');
      }
      if (entry.result) { const { graphPatch, ...result } = entry.result; return result; } // 重放不能返回旧图快照。
      const api = this.projects.api;
      if (!entry.body) {
        const graph = await this.projects.load(slug, { forCreate: true }); validateSources(graph, ids);
        const db = graph.databaseSchema;
        const budget = { count: 0 };
        const quotes = [];
        const sources = graph.nodes.filter(node => ids.includes(node.id)).sort((a, b) => a.number.localeCompare(b.number, 'zh-CN', { numeric: true }) || a.id.localeCompare(b.id));
        for (const source of sources) {
          const sourceRevision = source.revision || (await api.request('GET', `/pages/${source.id}`)).etag; // 刚查询的记录版本充当读取前快照。
          const blocks = await api.all('GET', `/blocks/${source.id}/children`);
          const focus = section(blocks, ['下一阶段聚焦问题']);
          const content = await copyBlocks(api, focus.blocks, budget);
          const url = `https://flowus.cn/${source.id}#${blocks[focus.start].id}`;
          const { data: sourcePage, etag: confirmedSource } = await api.request('GET', `/pages/${source.id}`);
          if (!sourceRevision || confirmedSource !== sourceRevision || !alive(sourcePage) || sourcePage.parent?.database_id !== graph.databaseId) throw new ServiceError(409, '继承期间来源已变化，未创建实验');
          quotes.push({ object: 'block', type: 'quote', quote: { rich_text: [richText(`来源：${source.title}`, url)] }, ...(content.length ? { children: content } : {}) });
        }
        const template = await this.template(); // 提交时仍向 FlowUs 核对版本；命中缓存只需一次请求。
        if (budget.count + template.count > 2000) throw new ServiceError(413, '模板及引用正文超过 2000 块，未创建实验');
        const children = template.children;
        children.splice(template.start + 1, 0, ...quotes);
        if (children.length > 100) throw new ServiceError(413, '模板与来源引用合计超过 100 个顶层块，未创建实验');
        // 先写预计编号；普通追加无需再 PATCH 标题及重读，分支变更仍由协调器校正。
        const pendingId = `pending:${input.requestId}`;
        const number = stageNumbers({ nodes: [...graph.nodes, { id: pendingId, createdTime: new Date().toISOString() }], edges: [...graph.edges, ...ids.map(source => ({ source, target: pendingId }))] }).get(pendingId);
        const properties = { [titleField(db)]: { type: 'title', title: [richText(`${number}. ${title}`)] }, 来源实验: { type: 'relation', relation: ids.map(id => ({ id })) } };
        if (db.properties?.状态?.select?.options?.some(option => option.name === '计划中')) properties.状态 = { type: 'select', select: { name: '计划中' } };
        entry.graph = graph;
        entry.projectId = graph.project.id; entry.databaseId = graph.databaseId;
        entry.body = { parent: { database_id: graph.databaseId }, properties, children };
        if (Buffer.byteLength(JSON.stringify(entry.body)) > 1024 * 1024) { delete entry.body; throw new ServiceError(413, '新实验正文超过 1 MB，未创建实验'); }
        entry.idempotencyKey = createHash('sha256').update(`helix-create:${graph.project.id}:${input.requestId}`).digest('hex');
      }
      if (entry.attempted) {
        const latest = await this.projects.load(slug);
        if (latest.project.id !== entry.projectId || latest.databaseId !== entry.databaseId) throw new ServiceError(409, '项目或实验表已变化，禁止重放原创建请求');
        validateSources(latest, ids);
        delete entry.graph; // 未确认重试不复用旧图，交由完整协调确认。
      }
      entry.attempted = true;
      try {
        const { data, etag } = await api.request('POST', '/pages', entry.body, undefined, entry.idempotencyKey);
        if (!uuid(data?.id) || (data.parent?.database_id && data.parent.database_id !== entry.databaseId)) throw new ServiceError(503, '创建响应不完整');
        entry.result = { nodeId: data.id, revision: etag || pageRevision(data) };
        // 仅完整真实响应且全图编号无需改写时，省去重复整图读取。
        const props = data.properties;
        if (entry.graph && !entry.graph.missingRelations && alive(data) && data.parent?.database_id === entry.databaseId && data.created_time && pageRevision(data)
          && Object.values(props || {}).some(p => p.type === 'title') && Array.isArray(props?.来源实验?.relation) && !props.来源实验.has_more) {
          const node = graphRecords([data]).nodes[0];
          const expectedSources = [...node.sourceIds].sort();
          const patch = { projectId: entry.projectId, databaseId: entry.databaseId, nodes: [...entry.graph.nodes, node],
            edges: [...entry.graph.edges, ...ids.map(source => ({ id: `${source}:${data.id}`, source, target: data.id }))], missingRelations: 0 };
          const numbers = stageNumbers(patch);
          if (JSON.stringify(expectedSources) === JSON.stringify(ids) && patch.nodes.every(n => n.title.startsWith(`${numbers.get(n.id)}. `) && n.number === numbers.get(n.id))) entry.result.graphPatch = patch;
        }
        delete entry.graph; delete entry.body;
        this.projects.invalidate(slug); return entry.result;
      } catch (error) {
        this.projects.invalidate(slug);
        if (error.status === 409) throw error;
        throw new ServiceError(503, '新增实验结果尚未确认，请保留同一请求重试，勿换请求 ID 重复创建', { retrySameRequest: true, requestId: input.requestId });
      }
    }).catch(error => { if (!entry.attempted && this.creates.get(key) === entry) this.creates.delete(key); throw error; });
  }
  async update(slug, id, input) {
    if (!uuid(id)) throw new ServiceError(404, '实验不存在');
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['title', 'sourceIds', 'status', 'revision'].includes(key)) || !['title', 'sourceIds', 'status'].some(key => Object.hasOwn(input, key))) throw new ServiceError(400, '实验修改参数无效');
    if (typeof input.revision !== 'string' || !input.revision || input.revision.length > 200) throw new ServiceError(409, '缺少实验页面版本，请刷新重试');
    return this.projects.withMutation(slug, async () => {
      const graph = await this.projects.load(slug); const node = graph.nodes.find(node => node.id === id);
      if (!node) throw new ServiceError(404, '实验不属于当前项目或已归档');
      const api = this.projects.api; const { data: current, etag } = await api.request('GET', `/pages/${id}`);
      if (!alive(current) || current.parent?.database_id !== graph.databaseId) throw new ServiceError(404, '实验不属于当前实验表');
      if (!etag || etag !== input.revision) throw new ServiceError(409, '实验已被其他窗口修改，请刷新重试');
      const { data: db } = await api.request('GET', `/databases/${graph.databaseId}`); const properties = {};
      if (Object.hasOwn(input, 'title')) properties[titleField(db)] = { type: 'title', title: [richText(titleValue(input.title))] };
      if (Object.hasOwn(input, 'status')) {
        if (typeof input.status !== 'string' || !db.properties?.状态?.select?.options?.some(option => option.name === input.status)) throw new ServiceError(400, '状态不在当前实验表选项中');
        properties.状态 = { type: 'select', select: { name: input.status } };
      }
      if (Object.hasOwn(input, 'sourceIds')) {
        if (node.sourceIds.some(source => !graph.nodes.some(n => n.id === source))) throw new ServiceError(409, '现有来源含表外引用，请在 FlowUs 中处理，未清除原关系');
        const ids = sourceValues(input.sourceIds); validateSources(graph, ids, id);
        for (const sourceId of ids) {
          const { data: source } = await api.request('GET', `/pages/${sourceId}`);
          if (!alive(source) || source.parent?.database_id !== graph.databaseId) throw new ServiceError(409, '来源已移出当前实验表，未保存');
        }
        properties.来源实验 = { type: 'relation', relation: ids.map(source => ({ id: source })) };
      }
      const { data, etag: updated } = await api.request('PATCH', `/pages/${id}`, { properties }, etag);
      this.projects.invalidate(slug);
      return { nodeId: id, revision: updated || pageRevision(data) };
    });
  }
}
