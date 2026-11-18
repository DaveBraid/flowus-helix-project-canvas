import { ServiceError, plain, alive } from './flowus.mjs';

const prefix = /^\d+(?:\.\d+)*(?:[ \t]*·[ \t]*\d+|[a-z])?\.?\s+/i;

/** 合流回到各来源共有的最深分支，按路径段比较，避免把 2.1 和 2.10 当成同一分支。 */
function commonBranch(branches) {
  const shared = branches[0].split('.');
  for (const branch of branches.slice(1)) {
    const parts = branch.split('.');
    const difference = shared.findIndex((part, index) => part !== parts[index]);
    if (difference !== -1) shared.length = difference;
  }
  return shared.join('.');
}

/** 按来源关系计算分支路径与阶段序号。显式保留旧规则的项目继续使用 DAG 编号。 */
export function stageNumbers({ nodes, edges, legacyNumbering = false }) {
  // 用创建时间和页面 ID 固定同级次序，重编后的标题不参与排序。
  const ordered = [...nodes].sort((a, b) => (a.createdTime || '').localeCompare(b.createdTime || '') || a.id.localeCompare(b.id));
  const rank = new Map(ordered.map((n, i) => [n.id, i]));
  const incoming = new Map(ordered.map(n => [n.id, []]));
  const outgoing = new Map(ordered.map(n => [n.id, []]));
  for (const e of edges) {
    if (!incoming.has(e.target) || !outgoing.has(e.source)) continue;
    if (!incoming.get(e.target).includes(e.source)) {
      incoming.get(e.target).push(e.source); outgoing.get(e.source).push(e.target);
    }
  }
  const compare = (a, b) => rank.get(a) - rank.get(b);
  const degree = new Map([...incoming].map(([id, sources]) => [id, sources.length]));
  const roots = ordered.filter(n => !degree.get(n.id)).map(n => n.id);
  const queue = [...roots], topo = [];
  while (queue.length) {
    const id = queue.shift(); topo.push(id);
    for (const target of outgoing.get(id)) {
      degree.set(target, degree.get(target) - 1);
      if (!degree.get(target)) { queue.push(target); queue.sort(compare); }
    }
  }
  if (topo.length !== nodes.length) throw new ServiceError(409, '实验关系存在循环，未自动重编编号');
  if (legacyNumbering) return legacyStageNumbers(topo, incoming, outgoing, compare);
  if (roots.length > 1) throw new ServiceError(409, '多起点的分支编号规则尚未确认');

  const numbers = new Map();
  const paths = new Map();
  const stages = new Map();
  const starts = new Map();
  const branchCounts = new Map();
  for (const id of topo) {
    const sources = incoming.get(id);
    let branch = '';
    if (sources.length === 1) branch = starts.get(id) ?? paths.get(sources[0]);
    if (sources.length > 1) branch = commonBranch(sources.map(source => paths.get(source)));
    const stage = (stages.get(branch) || 0) + 1;
    stages.set(branch, stage);
    paths.set(id, branch);
    numbers.set(id, branch ? branch + '·' + stage : String(stage));

    // 流入合流节点的边不占分支号。同一分支先合流再分叉时，子分支号接着分配。
    const children = outgoing.get(id).filter(target => incoming.get(target).length === 1);
    if (children.length < 2) continue;
    const used = branchCounts.get(branch) || 0;
    children.sort(compare).forEach((target, index) => {
      const suffix = String(used + index + 1);
      starts.set(target, branch ? branch + '.' + suffix : suffix);
    });
    branchCounts.set(branch, used + children.length);
  }
  return numbers;
}

/** 沿用显式保留项目的原 DAG 编号，包括多起点、合流和旧分支号。 */
function legacyStageNumbers(topo, incoming, outgoing, compare) {
  const branches = new Map();
  for (const [id, targets] of outgoing) {
    if (targets.length > 1) branches.set(id, targets.filter(t => incoming.get(t).length === 1).sort(compare));
  }
  const numbers = new Map(), branchCounts = new Map(); let largest = 0;
  for (const id of topo) {
    const sources = incoming.get(id);
    const siblings = sources.length === 1 ? branches.get(sources[0]) : null;
    if (siblings?.includes(id)) {
      const major = Number(numbers.get(sources[0]).split('.')[0]) + 1;
      const branch = (branchCounts.get(major) || 0) + 1; branchCounts.set(major, branch);
      numbers.set(id, `${major}.${branch}`); largest = Math.max(largest, major);
    } else {
      const major = Math.max(largest + 1, ...sources.map(s => Number(numbers.get(s).split('.')[0]) + 1));
      numbers.set(id, String(major)); largest = major;
    }
  }
  return numbers;
}

/** 只替换标题首部编号；保留标题富文本、正文和其余属性。 */
export function numberedTitle(title, number) {
  let remaining = prefix.exec(plain(title))?.[0].length || 0;
  const rest = structuredClone(title);
  for (const item of rest) if (item.annotations) {
    const { color, ...annotations } = item.annotations;
    item.annotations = { ...annotations, text_color: annotations.text_color || color || 'default', background_color: annotations.background_color || 'default' };
  }
  while (remaining && rest.length) {
    const item = rest[0], value = item.text?.content ?? item.plain_text ?? '';
    if (remaining >= value.length) { remaining -= value.length; rest.shift(); }
    else {
      if (!item.text) throw new ServiceError(409, '标题编号不在文本片段中，请先在 FlowUs 修正');
      item.text.content = value.slice(remaining); item.plain_text = item.text.content; remaining = 0;
    }
  }
  const text = `${number}. `;
  return [{ type: 'text', text: { content: text, link: null }, plain_text: text, href: null,
    annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, text_color: 'default', background_color: 'default' } }, ...rest];
}

/** 由来源边反查每条实验的直接下级，只列出需要写回的记录。 */
function childLinkChanges(graph) {
  const changes = new Map();
  if (!graph.childLinks) return changes;
  const desired = new Map(graph.nodes.map(node => [node.id, []]));
  for (const { source, target } of graph.edges) desired.get(source).push(target);
  for (const [id, children] of desired) {
    const actual = new Set(graph.childLinks.records[id]);
    if (actual.size !== children.length || children.some(id => !actual.has(id))) changes.set(id, children);
  }
  return changes;
}

/** 刷新时复核编号与下级导航，合并同页写入并验证版本。 */
export async function reconcileNumbers(projects, slug) {
  const graph = await projects.load(slug);
  if (graph.missingRelations) {
    const known = new Set(graph.nodes.map(n => n.id));
    const missing = new Set(graph.nodes.flatMap(n => n.sourceIds || []).filter(id => !known.has(id)));
    // 仅确认回收站中的来源可忽略；404 也可能无权限，不能误判成删除。
    if (!missing.size) throw new ServiceError(409, '来源关系不完整，未重编编号');
    for (const id of missing) {
      const { data: source } = await projects.api.request('GET', `/pages/${id}`);
      if (alive(source) || source.parent?.database_id !== graph.databaseId) throw new ServiceError(409, '存在表外或不可确认的来源，请在 FlowUs 检查后刷新；未重编编号');
    }
  }
  const numbers = stageNumbers(graph);
  const childChanges = childLinkChanges(graph);
  let changed = 0, changedChildren = 0, confirmed;
  try {
    for (const node of graph.nodes) {
      const number = numbers.get(node.id);
      const changeTitle = node.title !== `${number}. ${node.title.replace(prefix, '')}`;
      const changeChildren = childChanges.has(node.id);
      if (!changeTitle && !changeChildren) continue;
      const { data: page, etag } = await projects.api.request('GET', `/pages/${node.id}`);
      const title = Object.entries(page.properties || {}).find(([, p]) => p.type === 'title');
      if (!alive(page) || page.parent?.database_id !== graph.databaseId || !title || plain(title[1].title) !== node.title || !etag) {
        throw new ServiceError(409, '实验在重编期间已变化，请刷新后重试');
      }
      // 关系变化会改变整个编号计划；不能用最新版本掩盖旧计划。
      if (node.revision && page.last_edited_time !== node.revision && etag !== node.revision) throw new ServiceError(409, '实验在重编期间已变化，请刷新后重试');
      const properties = {};
      if (changeTitle) properties[title[0]] = { type: 'title', title: numberedTitle(title[1].title, number) };
      if (changeChildren) {
        const field = page.properties['下级实验'];
        if (field?.type !== 'relation' || field.id !== graph.childLinks.propertyId) throw new ServiceError(409, '下级实验属性已变化，请刷新后重试');
        properties.下级实验 = { type: 'relation', relation: childChanges.get(node.id).map(id => ({ id })) };
      }
      await projects.api.request('PATCH', `/pages/${node.id}`, { properties }, etag);
      if (changeTitle) changed++;
      if (changeChildren) changedChildren++;
    }
    confirmed = changed || changedChildren ? await projects.load(slug) : graph;
    // 多页更新无事务：若期间关系变化，报告需重试，不误报整图已完成。
    const finalNumbers = stageNumbers(confirmed);
    if (graph.childLinks && confirmed.childLinks?.propertyId !== graph.childLinks.propertyId) {
      confirmed = undefined;
      throw new ServiceError(409, '下级实验属性已变化，请刷新后重试');
    }
    if (childLinkChanges(confirmed).size || confirmed.nodes.some(n => n.title !== `${finalNumbers.get(n.id)}. ${n.title.replace(prefix, '')}`)) {
      confirmed = undefined;
      throw new ServiceError(409, '关系在重编期间变化，请刷新后继续');
    }
    return { changed, ...(changedChildren ? { changedChildren } : {}), graph: confirmed };
  } catch (error) {
    if (changed || changedChildren) throw new ServiceError(error.status || 503, `已重编 ${changed} 条，更新 ${changedChildren} 条下级实验。${error.message}。再次刷新可继续完成`);
    throw error;
  } finally {
    projects.invalidate(slug);
    if (confirmed) {
      projects.cache.set(slug, { value: confirmed, until: Date.now() + projects.ttl });
      if (projects.cache.size > 100) projects.cache.delete(projects.cache.keys().next().value);
    }
  }
}
