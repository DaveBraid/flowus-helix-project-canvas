import { readFileSync } from 'node:fs';

export class ServiceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const plain = value => (value || []).map(x => x.plain_text ?? x.text?.content ?? '').join('');
export const property = (page, name) => page.properties?.[name];
export const alive = page => !page.in_trash && !page.archived;
export const validSlug = slug => typeof slug === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,79}$/u.test(slug);

/** 读取运行时秘密；输入环境变量名称，输出秘密值，不写日志。 */
export function secret(name) {
  return process.env[`${name}_FILE`] ? readFileSync(process.env[`${name}_FILE`], 'utf8').trim() : (process.env[name] || '');
}

/** 全实例串行限速；输入请求函数，输出限速后的响应。 */
export class FlowUs {
  constructor({ token, tokenProvider, fetchImpl = fetch, interval = 800, base = 'https://api.flowus.cn' }) {
    this.token = token; this.fetch = fetchImpl; this.interval = interval; this.base = base;
    this.tokenProvider = tokenProvider;
    this.queue = Promise.resolve(); this.next = 0;
  }
  async request(method, path, body, revision) {
    const task = async () => {
      let token = this.tokenProvider ? await this.tokenProvider.getToken() : this.token;
      let refreshed = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise(r => setTimeout(r, Math.max(0, this.next - Date.now())));
        this.next = Date.now() + this.interval; // 预留流量给人工 CLI 操作。
        let response;
        try {
          response = await this.fetch(`${this.base}/v2${path}`, {
            method, signal: AbortSignal.timeout(20000),
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(revision ? { 'If-Match': revision } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        } catch { throw new ServiceError(503, 'FlowUs 暂时无法连接，请稍后重试'); }
        if (response.status === 401 && this.tokenProvider && !refreshed) {
          token = await this.tokenProvider.getToken(true); refreshed = true;
          continue; // 只让官方 CLI 重验一次，避免两个刷新实现竞争。
        }
        if (response.status === 429 && attempt < 2) {
          const seconds = Number(response.headers.get('retry-after'));
          this.next = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 120) * 1000 : 2000 * 2 ** attempt);
          continue;
        }
        if (!response.ok) {
          const status = response.status === 409 ? 409 : response.status === 404 ? 404 : 503;
          throw new ServiceError(status, status === 409 ? '数据已被其他窗口修改，请刷新后重试' : status === 404 ? 'FlowUs 内容不存在或无权访问' : 'FlowUs 请求失败，请检查授权或稍后重试');
        }
        return { data: await response.json(), etag: response.headers.get('etag') };
      }
      throw new ServiceError(503, 'FlowUs 请求过于频繁，请稍后重试');
    };
    const pending = this.queue.then(task, task);
    this.queue = pending.catch(() => {});
    return pending;
  }
  /** 完整读取游标分页；输入接口参数，输出全部记录，拒绝不完整数据。 */
  async all(method, path, body = {}) {
    const values = []; let cursor; const seen = new Set();
    do {
      const params = { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
      const url = method === 'GET' ? `${path}?${new URLSearchParams(params)}` : path;
      const { data } = await this.request(method, url, method === 'GET' ? undefined : params);
      if (!Array.isArray(data.results)) throw new ServiceError(503, 'FlowUs 分页响应不完整');
      values.push(...data.results);
      if (!data.has_more) break;
      cursor = data.next_cursor;
      if (!cursor || seen.has(cursor) || values.length > 10000) throw new ServiceError(503, 'FlowUs 分页异常');
      seen.add(cursor);
    } while (true);
    return values;
  }
}

/** 将实验关系转换成图；输入完整记录，输出节点与边，不推测编号关系。 */
export function graphRecords(records) {
  const current = records.filter(alive); const ids = new Set(current.map(r => r.id));
  const nodes = current.map(record => {
    const props = record.properties || {};
    const title = plain(Object.values(props).find(p => p.type === 'title')?.title) || '未命名实验';
    const formula = props['编号']?.formula;
    const number = formula?.string ?? formula?.number ?? title.split(/\s/)[0].replace(/\.$/, '');
    return { id: record.id, title, number: String(number ?? ''), status: props['状态']?.select?.name || '', url: `https://flowus.cn/${record.id}` };
  });
  const edges = []; const seen = new Set(); let missingRelations = 0;
  for (const record of current) for (const source of record.properties?.['来源实验']?.relation || []) {
    if (!ids.has(source.id)) { missingRelations++; continue; }
    const id = `${source.id}:${record.id}`;
    if (!seen.has(id)) { edges.push({ id, source: source.id, target: record.id }); seen.add(id); }
  }
  return { nodes, edges, missingRelations };
}

/** 项目服务只将业务状态写回 FlowUs；缓存可随时丢弃。 */
export class Projects {
  constructor(api, options = {}) {
    this.api = api;
    this.database = options.database || 'example-projects-database';
    this.slugField = options.slugField || '项目 URL 名'; this.layoutField = options.layoutField || 'Canvas 状态';
    this.cache = new Map(); this.pending = new Map(); this.ttl = options.ttl ?? 30000;
    this.allowed = options.allowed || []; this.publicOrigin = options.publicOrigin || '';
  }
  async resolve(slug) {
    if (!validSlug(slug)) throw new ServiceError(404, '项目不存在');
    const matches = (await this.api.all('POST', `/databases/${this.database}/query`, { filter: { property: this.slugField, rich_text: { equals: slug } } })).filter(alive);
    if (!matches.length) throw new ServiceError(404, '项目不存在');
    if (matches.length !== 1) throw new ServiceError(409, '项目 URL 名重复，请在 FlowUs 中修正');
    if (this.allowed.length && !this.allowed.includes(matches[0].id)) throw new ServiceError(404, '项目尚未启用');
    return matches[0];
  }
  /** 返回最多五分钟的内存快照，仅用于加载预览，不参与保存校验。 */
  preview(slug) {
    const cached=this.cache.get(slug);
    return cached && cached.until + 270000 > Date.now() ? cached.value : null;
  }
  async graph(slug, fresh = false) {
    if (!fresh && this.cache.get(slug)?.until > Date.now()) return this.cache.get(slug).value;
    if (this.pending.has(slug)) return this.pending.get(slug);
    const pending = this.load(slug).then(value => { this.cache.set(slug, { value, until: Date.now() + this.ttl }); if(this.cache.size>100)this.cache.delete(this.cache.keys().next().value); return value; });
    this.pending.set(slug, pending);
    try { return await pending; } finally { this.pending.delete(slug); }
  }
  async load(slug, { relations = true } = {}) {
    const match = await this.resolve(slug);
    const { data: page, etag } = await this.api.request('GET', `/pages/${match.id}`);
    if (!alive(page)) throw new ServiceError(404, '项目不存在');
    const blocks = await this.api.all('GET', `/blocks/${page.id}/children`);
    const candidates = [];
    for (const block of blocks.filter(b => b.type === 'child_database' && alive(b))) {
      const { data: db } = await this.api.request('GET', `/databases/${block.id}`);
      if (db.parent?.page_id === page.id && db.properties?.['来源实验']?.relation?.database_id === db.id) candidates.push(db);
    }
    if (candidates.length !== 1) throw new ServiceError(409, '请保留一个属于本项目、含来源实验自关联的实验表');
    const db = candidates[0];
    const records = await this.api.all('POST', `/databases/${db.id}/query`);
    for (const record of relations ? records : []) {
      const relation = record.properties?.['来源实验'];
      if (!relation?.id) throw new ServiceError(503, '实验来源属性缺少标识，无法确认关联完整性');
      // 官方模型直接携带关联数组；长列表保守分页，显式截断或异常结构也补读。
      if (relation.type === 'relation' && Array.isArray(relation.relation) && relation.relation.length < 20 && relation.has_more !== true && !relation.next_cursor && relation.relation.every(item => item && typeof item.id === 'string')) continue;
      const items = await this.api.all('GET', `/pages/${record.id}/properties/${encodeURIComponent(relation.id)}`);
      relation.relation = items.flatMap(item => item.relation ? (Array.isArray(item.relation) ? item.relation : [item.relation]) : [item]); // 兼容直接 IdRef 与旧版 relation 包装。
      if (relation.relation.some(item => !item || typeof item.id !== 'string')) throw new ServiceError(503, '实验关联响应不完整');
    }
    const { nodes, edges, missingRelations } = graphRecords(records);
    let layoutProperty = property(page, this.layoutField);
    if (!layoutProperty || layoutProperty.type !== 'rich_text') throw new ServiceError(409, '项目缺少文本类型的 Canvas 状态属性');
    if (layoutProperty.rich_text?.length || layoutProperty.has_more) {
      if (!layoutProperty.id) throw new ServiceError(503, '画布状态缺少属性标识，无法确认布局完整性');
      const items = await this.api.all('GET', `/pages/${page.id}/properties/${encodeURIComponent(layoutProperty.id)}`);
      layoutProperty = { ...layoutProperty, rich_text: items.flatMap(item => item.rich_text ? (Array.isArray(item.rich_text) ? item.rich_text : [item.rich_text]) : [item]) }; // 分页结果直接返回 RichText，兼容旧版包装。
      if (!layoutProperty.rich_text.length || layoutProperty.rich_text.some(item => !item || (typeof item.plain_text !== 'string' && typeof item.text?.content !== 'string'))) throw new ServiceError(503, '画布状态分页响应不完整，未覆盖原数据');
    }
    const raw = plain(layoutProperty.rich_text);
    let layout = null; let layoutWarning;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.schemaVersion !== 1) layoutWarning = '画布状态版本暂不支持，未覆盖原数据';
        else if (parsed.ownerProjectId === page.id && parsed.experimentDatabaseId === db.id) {
          const ids = new Set(nodes.map(n => n.id));
          if (parsed.cardColor !== undefined && (typeof parsed.cardColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(parsed.cardColor))) layoutWarning = '画布颜色格式有误，未覆盖原数据';
          else if (!parsed.nodes || typeof parsed.nodes !== 'object' || Array.isArray(parsed.nodes) || Object.entries(parsed.nodes).some(([id, p]) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 1e6 || Math.abs(p.y) > 1e6)) layoutWarning = '画布坐标格式有误，未覆盖原数据';
          else layout = { ...parsed, nodes: Object.fromEntries(Object.entries(parsed.nodes).filter(([id]) => ids.has(id))) };
        } else layoutWarning = '画布所属项目或实验表不匹配，未覆盖原数据';
      } catch { layoutWarning = '画布状态格式有误，未覆盖原数据'; }
    }
    return { project: { id: page.id, title: plain(Object.values(page.properties).find(p => p.type === 'title')?.title), slug }, nodes, edges, layout, revision: etag, databaseId: db.id, layoutWarning, missingRelations };
  }
  /** 原位更新同一画布属性；输入坐标和旧版本，输出确认后的持久状态。 */
  async save(slug, { revision, positions, cardColor }) {
    if (typeof revision !== 'string' || !revision) throw new ServiceError(409, '缺少页面版本，请刷新后重试');
    if (cardColor !== undefined && (typeof cardColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(cardColor))) throw new ServiceError(400, '卡片颜色必须是 RGB 十六进制颜色');
    // 保存只需核验当前项目、实验归属及页面版本，不需要逐条读取连线。
    const graph = await this.load(slug, { relations: false });
    if (graph.layoutWarning) throw new ServiceError(409, graph.layoutWarning);
    if (revision !== graph.revision) throw new ServiceError(409, '项目已更新，请刷新后重试');
    if (!positions || typeof positions !== 'object' || Array.isArray(positions)) throw new ServiceError(400, '坐标格式错误');
    const ids = new Set(graph.nodes.map(n => n.id)); const normalized = {};
    if (Object.keys(positions).length > 1000) throw new ServiceError(400, '单项目节点数量超出当前画布容量');
    for (const [id, point] of Object.entries(positions).sort(([a], [b]) => a.localeCompare(b))) {
      if (!ids.has(id) || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 1e6 || Math.abs(point.y) > 1e6) throw new ServiceError(400, '坐标含无效或不属于本项目的节点');
      normalized[id] = { x: Math.round(point.x), y: Math.round(point.y) };
    }
    const layout = { schemaVersion: 1, ownerProjectId: graph.project.id, experimentDatabaseId: graph.databaseId, urlSlug: slug, nodes: normalized };
    const savedColor = cardColor ?? graph.layout?.cardColor; // 老客户端保存坐标时保留已有颜色。
    if (savedColor !== undefined) layout.cardColor = savedColor.toLowerCase();
    const content = JSON.stringify(layout);
    if (Buffer.byteLength(content) > 64000) throw new ServiceError(400, '布局超过当前安全容量，未保存');
    if (JSON.stringify(graph.layout) === content) return { revision: graph.revision, layout };
    // 分段承载文本，更新仍为单次页面 PATCH，不上传附件。
    const richText = Array.from({ length: Math.ceil(content.length / 1800) }, (_, i) => ({ type: 'text', text: { content: content.slice(i * 1800, (i + 1) * 1800) } }));
    await this.api.request('PATCH', `/pages/${graph.project.id}`, { properties: { [this.layoutField]: { type: 'rich_text', rich_text: richText } } }, revision);
    this.cache.delete(slug);
    const { data: saved, etag } = await this.api.request('GET', `/pages/${graph.project.id}`);
    const savedProperty = property(saved, this.layoutField);
    let confirmed = plain(savedProperty?.rich_text);
    if (savedProperty?.id) {
      const items = await this.api.all('GET', `/pages/${graph.project.id}/properties/${encodeURIComponent(savedProperty.id)}`);
      confirmed = plain(items.flatMap(item => item.rich_text ? (Array.isArray(item.rich_text) ? item.rich_text : [item.rich_text]) : [item]));
    }
    if (confirmed !== content) throw new ServiceError(409, '保存结果已变化，请刷新确认');
    return { revision: etag, layout };
  }
}
