import { createHash, timingSafeEqual } from 'node:crypto';
import { ServiceError, plain, alive, validSlug } from './flowus.mjs';
import { richText, pageRevision } from './experiments.mjs';
import { reconcileNumbers } from './numbering.mjs';
import { HelixContent, contentTools } from './helix-content.mjs';

const string = { type: 'string', minLength: 1 };
const uuid = { type: 'string', pattern: '^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' };
const object = { type: 'object' };
const base = { projectId: uuid };
const target = { ...base, targetId: uuid, kind: { type: 'string', enum: ['page', 'block', 'database'] } };
const tool = (name, description, properties, required, readOnly = false, destructive = false) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: false } });
export const helixTools = [
  tool('helix_help', '读取 Helix 工作流、权限边界与工具参数；先查此工具，再调用实际业务工具。', {}, [], true),
  tool('helix_projects_list', '列出 Helix 项目表中的项目和稳定 ID；不搜索其他工作区内容。', {}, [], true),
  tool('helix_project_get', '读取项目、实验关系、状态选项与布局。编号只用于显示，后续操作使用页面 ID。', base, ['projectId'], true),
  tool('helix_project_create', '创建全新空白 Helix 项目、背景区、独立实验表及嵌入。requestId 必须固定重试；不会复制其他项目实验。', { title: string, slug: string, requestId: string }, ['title', 'slug', 'requestId']),
  tool('helix_project_update', '局部修改项目标题、URL 简写或其他原生属性。保留未提供字段；Canvas 状态请用专用布局工具。', { ...base, title: string, slug: string, properties: object, revision: string }, ['projectId', 'revision']),
  tool('helix_page_create', '在项目或其子页面下创建普通资料页。实验记录须使用 helix_experiment_create。', { ...base, parentId: uuid, title: string, requestId: string }, ['projectId', 'parentId', 'title', 'requestId']),
  tool('helix_experiment_create', '新增实验并复制模板、继承各来源聚焦问题、维护编号。sourceIds 使用当前项目页面 ID；未知结果保持原 requestId 重试。', { ...base, title: string, sourceIds: { type: 'array', items: uuid, maxItems: 100, uniqueItems: true }, requestId: string }, ['projectId', 'title', 'sourceIds', 'requestId']),
  tool('helix_experiment_update', '修改实验标题、状态或来源，复用画布校验并协调编号；连接变化不会重写已继承正文。properties 用于完成日期等额外字段。', { ...base, experimentId: uuid, revision: string, title: string, status: string, sourceIds: { type: 'array', items: uuid, maxItems: 100, uniqueItems: true }, properties: object }, ['projectId', 'experimentId', 'revision']),
  tool('helix_graph_reconcile', '读取真实关系并完成连续重编；返回实际更改数量及完整画布。', base, ['projectId']),
  tool('helix_layout_save', '保存节点位置及 RGB 颜色到 FlowUs；不保存观看缩放。位置须为本项目 ID 到 x/y 的映射。', { ...base, revision: string, positions: object, cardColor: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } }, ['projectId', 'revision', 'positions']),
  tool('helix_delete_preview', '读取软删除影响、当前版本和准确目标。不会删除；返回 confirmTargetId 供已获用户授权的删除调用使用。', target, ['projectId', 'targetId', 'kind'], true),
  tool('helix_delete', '将已核对目标放入回收站；不会永久删除。必须与预览目标及版本一致。实验删除后协调编号；DELETE 无原子版本锁。', { ...target, revision: string, confirmTargetId: uuid }, ['projectId', 'targetId', 'kind', 'revision', 'confirmTargetId'], false, true),
  tool('helix_restore', '恢复 Helix 范围内回收站目标及保留子树；恢复实验后协调编号。', target, ['projectId', 'targetId', 'kind']),
  ...contentTools,
];

/** 验证内网凭据；输入请求头和独立秘密，输出是否匹配，不接受浏览器 Cookie。 */
export function internalAuthorized(header, secret) {
  if (typeof secret !== 'string' || secret.length < 32 || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const a = createHash('sha256').update(header.slice(7)).digest(), b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}
function id(value) { if (typeof value !== 'string' || !new RegExp(uuid.pattern).test(value)) throw new ServiceError(400, '需要有效页面 ID'); return value.toLowerCase(); }
function title(value) { if (typeof value !== 'string' || !value.trim() || value.length > 300 || /[\r\n\x00-\x1f]/.test(value)) throw new ServiceError(400, '标题须为 1–300 字符单行文本'); return value.trim(); }
function key(value) { if (typeof value !== 'string' || !/^[\w-]{16,100}$/.test(value)) throw new ServiceError(400, 'requestId 须为 16–100 位字母、数字、下划线或连字符'); return value; }
const hashKey = (...values) => createHash('sha256').update(values.join(':')).digest('hex');
const pathFor = (kind, value) => `/${{ page: 'pages', block: 'blocks', database: 'databases' }[kind]}/${id(value)}`;
function version(result) { return result.etag || pageRevision(result.data); }
function expectVersion(result, revision) { if (!revision || revision !== version(result)) throw new ServiceError(409, '目标已变化，请重新读取'); }

/** 业务入口与范围检查集中于此；MCP 和画布复用 Projects/Experiments，不复制凭据或另建业务库。 */
export class HelixActions {
  constructor(projects) { this.projects = projects; this.api = projects.api; this.content = new HelixContent(this); this.creates = new Map(); this.pageCreates = new Map(); }
  async project(projectId, allowTrash = false) {
    const result = await this.api.request('GET', `/pages/${id(projectId)}`);
    if (result.data.parent?.database_id !== this.projects.database || (!allowTrash && !alive(result.data)) || (this.projects.allowed.length && !this.projects.allowed.includes(result.data.id))) throw new ServiceError(403, '目标不在已授权 Helix 项目范围');
    return result;
  }
  async slug(projectId) {
    const { data } = await this.project(projectId); const slug = plain(data.properties?.[this.projects.slugField]?.rich_text);
    if (!validSlug(slug) || (await this.projects.resolve(slug)).id !== data.id) throw new ServiceError(409, '项目简写无效或不唯一');
    return slug;
  }
  /** 向上验证真实父级链；输入项目、目标和种类，输出目标元数据，跨项目及循环均拒绝。 */
  async target(projectId, targetId, kind, { allowTrash = false } = {}) {
    if (!['page', 'block', 'database'].includes(kind)) throw new ServiceError(400, '目标类型无效');
    const root = await this.project(projectId, allowTrash && projectId === targetId);
    if (targetId === projectId && kind === 'database') throw new ServiceError(400, '项目根不是数据库');
    const result = targetId === projectId && kind === 'page' ? root : await this.api.request('GET', pathFor(kind, targetId));
    if (!allowTrash && !alive(result.data)) throw new ServiceError(404, '目标已在回收站');
    let current = result.data; const visited = new Set();
    for (let depth = 0; depth < 64; depth++) {
      if (current.id === projectId) return result;
      if (visited.has(current.id) || (!alive(current) && current !== result.data)) break;
      visited.add(current.id);
      const parent = current.parent || {};
      const [type, parentId] = parent.page_id ? ['page', parent.page_id] : parent.database_id ? ['database', parent.database_id] : parent.block_id ? ['block', parent.block_id] : [];
      if (!parentId) break;
      if (parentId === projectId) return result;
      if (parentId === this.projects.database) break;
      current = (await this.api.request('GET', pathFor(type, parentId))).data;
    }
    throw new ServiceError(403, '目标不在指定 Helix 项目内');
  }
  async invalidate(projectId) {
    for (const [slug, cached] of this.projects.cache) if (cached.value?.project?.id === projectId) this.projects.invalidate(slug);
    try { const { data } = await this.project(projectId, true); const slug = plain(data.properties?.[this.projects.slugField]?.rich_text); if (slug) this.projects.invalidate(slug); } catch {} // 写入结果不因失效缓存失败而伪装成未提交。
  }
  /** 额外属性禁止覆盖工作流字段或注入表外关联；输入真实页面和补丁，输出无。 */
  async properties(projectId, page, properties, reserved = []) {
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) throw new ServiceError(400, '属性补丁无效');
    for (const [name, value] of Object.entries(properties)) {
      const field = page.properties?.[name] || Object.values(page.properties || {}).find(p => p.id === name);
      if (!field || reserved.includes(name) || reserved.some(n => page.properties?.[n]?.id === name) || ['title', 'formula', 'rollup', 'created_time', 'last_edited_time', 'unique_id'].includes(field.type)) throw new ServiceError(400, `属性 ${name} 只读或须使用专用参数`);
      if (!value || value.type !== field.type) throw new ServiceError(400, `属性 ${name} 类型不匹配`);
      for (const related of value.relation || []) await this.target(projectId, related.id, 'page');
    }
  }
  async reconciled(slug, result) {
    try { return { ...result, ...(await this.projects.withMutation(slug, () => reconcileNumbers(this.projects, slug))) }; }
    catch (error) { return { ...result, saved: true, needsReconcile: true, warning: error.message }; } // 已提交成功时不得让 AI 误重建。
  }
  async call(name, args = {}) {
    const definition = helixTools.find(t => t.name === name);
    if (!definition || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !Object.hasOwn(definition.inputSchema.properties, k)) || definition.inputSchema.required?.some(k => !Object.hasOwn(args, k))) throw new ServiceError(400, '工具或参数无效');
    if (contentTools.some(t => t.name === name)) return this.content.call(name, args);
    if (name === 'helix_help') return { tools: helixTools, workflow: '项目和实验使用稳定 ID；创建实验复用模板继承，关系及删除后统一协调编号。正文按块增量更新。软删除须先预览并匹配目标和版本。', scope: '仅配置的 Helix Projects 表及各项目后代；不开放任意 API 路径，不永久删除。', limits: ['DELETE/块 PATCH 仅预读版本保护，非原子锁', '追加和上传交易仅内存去重，未知结果先读回', 'FlowUs 是唯一业务数据源，缓存可丢弃'] };
    if (name === 'helix_projects_list') {
      return { projects: (await this.api.all('POST', `/databases/${this.projects.database}/query`)).filter(p => alive(p) && (!this.projects.allowed.length || this.projects.allowed.includes(p.id))).map(p => ({ id: p.id, title: plain(Object.values(p.properties || {}).find(v => v.type === 'title')?.title), slug: plain(p.properties?.[this.projects.slugField]?.rich_text), revision: pageRevision(p) })) };
    }
    if (name === 'helix_project_create') return this.createProject(args);
    const projectId = id(args.projectId);
    if (['helix_delete_preview', 'helix_delete', 'helix_restore'].includes(name)) return this.trash(name, { ...args, projectId });
    const slug = await this.slug(projectId);
    if (name === 'helix_project_get') return this.projects.graph(slug, true);
    if (name === 'helix_graph_reconcile') return this.projects.withMutation(slug, () => reconcileNumbers(this.projects, slug));
    if (name === 'helix_layout_save') return this.projects.withMutation(slug, () => this.projects.save(slug, { revision: args.revision, positions: args.positions, cardColor: args.cardColor }));
    if (name === 'helix_experiment_create') {
      const result = await this.projects.createExperiment(slug, { title: args.title, sourceIds: args.sourceIds, requestId: args.requestId });
      return result.graphPatch ? { ...result, saved: true } : this.reconciled(slug, result);
    }
    if (name === 'helix_experiment_update') {
      const patch = Object.fromEntries(['title', 'status', 'sourceIds', 'revision'].filter(k => Object.hasOwn(args, k)).map(k => [k, args[k]]));
      if (args.properties && ['title', 'status', 'sourceIds'].some(k => k in args)) throw new ServiceError(400, '额外属性与工作流字段请分两次更新，各次读取最新版本');
      let result;
      if (args.properties) result = await this.projects.withMutation(slug, async () => {
        const graph = await this.projects.load(slug, { forCreate: true });
        if (!graph.nodes.some(n => n.id === args.experimentId)) throw new ServiceError(403, '实验不在当前实验表');
        const page = await this.target(projectId, args.experimentId, 'page'); expectVersion(page, args.revision);
        await this.properties(projectId, page.data, args.properties, ['来源实验', '状态', '编号']);
        const updated = await this.api.request('PATCH', `/pages/${id(args.experimentId)}`, { properties: args.properties }, args.revision);
        this.projects.invalidate(slug); return { nodeId: args.experimentId, revision: version(updated) };
      });
      else result = await this.projects.updateExperiment(slug, id(args.experimentId), patch);
      return this.reconciled(slug, result);
    }
    if (name === 'helix_project_update') return this.projects.withMutation(slug, async () => {
      const page = await this.project(projectId); expectVersion(page, args.revision);
      const properties = args.properties || {}; await this.properties(projectId, page.data, properties, [this.projects.slugField, this.projects.layoutField]);
      if (args.title !== undefined) { const field = Object.keys(page.data.properties).find(k => page.data.properties[k].type === 'title'); properties[field] = { type: 'title', title: [richText(title(args.title))] }; }
      if (args.slug !== undefined) {
        if (!validSlug(args.slug)) throw new ServiceError(400, '项目简写无效');
        const matches = await this.api.all('POST', `/databases/${this.projects.database}/query`, { filter: { property: this.projects.slugField, rich_text: { equals: args.slug } } });
        if (matches.some(p => alive(p) && p.id !== projectId)) throw new ServiceError(409, '项目简写已被使用');
        properties[this.projects.slugField] = { type: 'rich_text', rich_text: [richText(args.slug)] };
      }
      if (!Object.keys(properties).length) throw new ServiceError(400, '未提供修改内容');
      const result = await this.api.request('PATCH', `/pages/${projectId}`, { properties }, args.revision);
      this.projects.invalidate(slug); if (args.slug) this.projects.invalidate(args.slug);
      return { projectId, revision: version(result), url: `${this.projects.publicOrigin}/Helix/${encodeURIComponent(args.slug || slug)}`, embeddedUrlSync: '已有嵌入由后台巡检更新' };
    });
    if (name === 'helix_page_create') {
      await this.target(projectId, args.parentId, 'page');
      const requestId = key(args.requestId), pageTitle = title(args.title), cacheKey = `${projectId}:${requestId}`;
      const fingerprint = JSON.stringify([args.parentId,pageTitle]), previous = this.pageCreates.get(cacheKey);
      if (previous) { if (previous.fingerprint !== fingerprint) throw new ServiceError(409,'同一 requestId 不能更改页面内容'); return previous.promise; }
      if (this.pageCreates.size >= 1000) throw new ServiceError(503,'本进程页面创建记录已满，请先核对已有操作');
      // OAuth 刷新可能改变官方幂等范围；当前进程保留未知结果，避免盲重放。
      const promise = this.api.request('POST', '/pages', { parent: { page_id: id(args.parentId) }, properties: { title: { type: 'title', title: [richText(pageTitle)] } } }, undefined, hashKey('helix-page', projectId, requestId)).then(result => ({page:result.data,revision:version(result)}));
      this.pageCreates.set(cacheKey,{fingerprint,promise}); return promise;
    }
    throw new ServiceError(404, '工具未实现');
  }
  async createProject(args) {
    const projectTitle = title(args.title); if (!validSlug(args.slug)) throw new ServiceError(400, '项目简写无效');
    if (this.projects.allowed.length) throw new ServiceError(403, '启用了固定项目白名单，新增项目须先调整服务器授权范围');
    const requestId = key(args.requestId), fingerprint = JSON.stringify([projectTitle, args.slug]);
    return this.projects.withMutation('__create_project__', async () => {
      let entry = this.creates.get(requestId);
      if (entry && entry.fingerprint !== fingerprint) throw new ServiceError(409, '同一 requestId 不能更改项目内容');
      if (!entry) { if (this.creates.size >= 100) throw new ServiceError(503, '项目创建重试缓存已满'); entry = { fingerprint }; this.creates.set(requestId, entry); }
      const matches = (await this.api.all('POST', `/databases/${this.projects.database}/query`, { filter: { property: this.projects.slugField, rich_text: { equals: args.slug } } })).filter(alive);
      if (matches.some(p => p.id !== entry.projectId)) throw new ServiceError(409, '项目简写已存在；未覆盖，请核对是否上次创建已成功');
      if (!entry.projectId) {
        if (entry.creationStarted) throw new ServiceError(409,'上次项目创建结果未知，请先检查项目表，禁止盲目重建');
        const { data: db } = await this.api.request('GET', `/databases/${this.projects.database}`);
        const field = Object.keys(db.properties).find(k => db.properties[k].type === 'title');
        const children = [ { object:'block',type:'heading_1',heading_1:{rich_text:[richText('项目背景')]} }, {object:'block',type:'paragraph',paragraph:{rich_text:[]}}, {object:'block',type:'heading_1',heading_1:{rich_text:[richText('实验情况')]}} ];
        if (this.projects.publicOrigin) children.push({object:'block',type:'embed',embed:{url:`${this.projects.publicOrigin}/Helix/${encodeURIComponent(args.slug)}`}});
        entry.creationStarted = true;
        const created = await this.api.request('POST', '/pages', { parent:{database_id:this.projects.database}, properties:{[field]:{type:'title',title:[richText(projectTitle)]},[this.projects.slugField]:{type:'rich_text',rich_text:[richText(args.slug)]},[this.projects.layoutField]:{type:'rich_text',rich_text:[]}},children }, undefined, hashKey('helix-project',requestId));
        entry.projectId = created.data.id;
      }
      try {
        const children = await this.api.all('GET', `/blocks/${entry.projectId}/children`);
        const databases = children.filter(b => alive(b) && b.type === 'child_database');
        if (databases.length > 1) throw new ServiceError(409,'项目包含多个子表，请手动核对');
        if (!entry.databaseId && databases.length) entry.databaseId = databases[0].id;
        if (!entry.databaseId) {
          if (entry.databaseStarted) throw new ServiceError(409,'上次实验表创建结果未知，请先检查项目子表，禁止重复创建');
          entry.databaseStarted = true;
          const created = await this.api.request('POST', '/databases', { parent:{page_id:entry.projectId},is_inline:true,title:[richText('实验记录')],properties:{实验内容:{type:'title'},状态:{type:'select',select:{options:[{name:'计划中',color:'purple'},{name:'进行中',color:'orange'},{name:'待记录',color:'blue'},{name:'已完成',color:'green'},{name:'已暂停',color:'pink'},{name:'已终止',color:'grey'}]}},完成日期:{type:'date'},编号:{type:'formula',formula:{expression:'replace(replace(prop("实验内容"), " .*", ""), "[.]$", "")'}}} });
          entry.databaseId = created.data.id;
        }
        await this.api.request('PATCH', `/databases/${entry.databaseId}`, {properties:{来源实验:{type:'relation',relation:{database_id:entry.databaseId}}}});
        const graph = await this.projects.load(args.slug); return { projectId:entry.projectId,databaseId:entry.databaseId,graph,url:`${this.projects.publicOrigin}/Helix/${encodeURIComponent(args.slug)}` };
      } catch (error) { throw new ServiceError(error.status || 503, `项目页面已创建，初始化未完成：${error.message}`, { projectId:entry.projectId,databaseId:entry.databaseId,requestId,resumeSameRequest:true }); }
    });
  }
  /** 专用回收站流程；以官方删除回执确认，避免回收站失去读取权限时误报失败。 */
  async trash(name, args) {
    const {projectId, targetId, kind} = args;
    const current = await this.target(projectId, id(targetId), kind, {allowTrash:true});
    const isProject = targetId === projectId;
    if (kind === 'block' && (isProject || ['page', 'page_root', 'child_page', 'child_database', 'database', 'collection', 'collection_view'].includes(current.data.type))) throw new ServiceError(400, '页面或实验表须使用对应的 page/database 删除工具参数');
    const project = await this.project(projectId, isProject);
    const slug = plain(project.data.properties?.[this.projects.slugField]?.rich_text);
    let graph;
    if (!isProject && alive(project.data)) { try { graph = await this.projects.load(slug,{forCreate:true}); } catch(error) { if(kind === 'page' && current.data.parent?.database_id) throw error; } }
    const isExperiment = kind === 'page' && current.data.parent?.database_id === graph?.databaseId;
    if (name === 'helix_delete_preview') return { targetId, projectId, kind, revision:version(current), inTrash:!alive(current.data), confirmTargetId:targetId, title:plain(Object.values(current.data.properties || {}).find(p=>p.type==='title')?.title), descendantsPreserved:true, downstream:graph?.nodes.filter(n=>n.sourceIds.includes(targetId)).map(n=>({id:n.id,title:n.title})) || [], warning:'软删除保留子树；移除后续实验指向此记录的来源关系并重编，不自动跨接。恢复不重建已移除关系。DELETE 无原子版本锁；页面范围授权可能无法恢复回收站对象。' };
    if (name === 'helix_delete' && args.confirmTargetId !== targetId) throw new ServiceError(400,'确认目标与删除目标不一致');
    return this.projects.withMutation(slug || projectId, async () => {
      const latest = await this.target(projectId,targetId,kind,{allowTrash:true});
      let confirmed = latest;
      if (name === 'helix_delete') {
        if (alive(latest.data)) {
          expectVersion(latest,args.revision);
          confirmed = await this.api.request('DELETE',pathFor(kind,targetId));
          // 403/404 不能证明删除；仅接受同一对象的明确成功回执。
          if (confirmed.data?.id !== targetId || confirmed.data.in_trash !== true) throw new ServiceError(503,'删除回执不完整，请在 FlowUs 核对结果，勿盲目重试');
        }
      } else {
        if (!alive(latest.data)) await this.api.request('PATCH',pathFor(kind,targetId),{in_trash:false},kind === 'page' ? version(latest) : undefined);
        confirmed = await this.api.request('GET',pathFor(kind,targetId));
      }
      const inTrash = !alive(confirmed.data);
      if (inTrash !== (name === 'helix_delete')) throw new ServiceError(409,'回收站状态未确认，请读取目标后重试');
      this.projects.invalidate(slug);
      const result = {targetId,projectId,kind,inTrash,revision:version(confirmed),saved:true};
      if(isExperiment) {
        try {
          if (inTrash) await this.detachDeletedSource(slug,targetId); // 只清理本次已确认删除的 ID。
          return {...result,...await reconcileNumbers(this.projects,slug)};
        }
        catch(error) { return {...result,needsReconcile:true,warning:error.message}; }
      }
      return result;
    });
  }
  /** 删除后保留其他来源；逐记录读取并以 ETag 写入，失败交由调用方报告部分完成。 */
  async detachDeletedSource(slug, targetId) {
    const graph = await this.projects.load(slug,{forCreate:true});
    for (const node of graph.nodes.filter(n => n.sourceIds?.includes(targetId))) {
      const page = await this.api.request('GET',`/pages/${id(node.id)}`);
      if (!alive(page.data) || page.data.parent?.database_id !== graph.databaseId || !page.etag) throw new ServiceError(409,'后续实验已变化，未清理来源关系');
      const field = Object.entries(page.data.properties || {}).find(([name,p]) => name === '来源实验' && p.type === 'relation');
      if (!field || !Array.isArray(field[1].relation)) throw new ServiceError(409,'后续实验来源字段无法核对');
      const relation = field[1].relation.filter(p => p.id !== targetId).map(p => ({id:p.id}));
      if (relation.length !== field[1].relation.length) await this.api.request('PATCH',`/pages/${node.id}`,{properties:{[field[0]]:{type:'relation',relation}}},page.etag);
    }
  }
}
