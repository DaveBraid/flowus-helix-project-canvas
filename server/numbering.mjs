import { ServiceError, plain, alive } from './flowus.mjs';

const prefix = /^\d+(?:\.\d+)*(?:[a-z])?\.?\s+/i;

/** 沿用 Ob Helix 的 DAG 编号规则；输入完整图，输出稳定的连续大号和分支小号。 */
export function stageNumbers({ nodes, edges }) {
  // 创建时间承担 Ob 的固定物理序列；不能以正在改写的编号作为重试顺序。
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
  const queue = ordered.filter(n => !degree.get(n.id)).map(n => n.id), topo = [];
  while (queue.length) {
    const id = queue.shift(); topo.push(id);
    for (const target of outgoing.get(id)) {
      degree.set(target, degree.get(target) - 1);
      if (!degree.get(target)) { queue.push(target); queue.sort(compare); }
    }
  }
  if (topo.length !== nodes.length) throw new ServiceError(409, '实验关系存在循环，未自动重编编号');
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

/** 受保护的显式刷新触发重编；逐记录版本校验，失败后可按当前真实数据安全续跑。 */
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
  const numbers = stageNumbers(graph); let changed = 0, confirmed;
  try {
    for (const node of graph.nodes) {
      const number = numbers.get(node.id);
      const expected = `${number}. ${node.title.replace(prefix, '')}`;
      if (node.title === expected) continue;
      const { data: page, etag } = await projects.api.request('GET', `/pages/${node.id}`);
      const title = Object.entries(page.properties || {}).find(([, p]) => p.type === 'title');
      if (!alive(page) || page.parent?.database_id !== graph.databaseId || !title || plain(title[1].title) !== node.title || !etag) {
        throw new ServiceError(409, '实验在重编期间已变化，请刷新后重试');
      }
      // 关系变化会改变整个编号计划；不能用最新版本掩盖旧计划。
      if (node.revision && page.last_edited_time !== node.revision && etag !== node.revision) throw new ServiceError(409, '实验在重编期间已变化，请刷新后重试');
      await projects.api.request('PATCH', `/pages/${node.id}`, { properties: { [title[0]]: { type: 'title', title: numberedTitle(title[1].title, number) } } }, etag);
      changed++;
    }
    confirmed = changed ? await projects.load(slug) : graph;
    // 多页更新无事务：若期间关系变化，报告需重试，不误报整图已完成。
    const finalNumbers = stageNumbers(confirmed);
    if (confirmed.nodes.some(n => n.title !== `${finalNumbers.get(n.id)}. ${n.title.replace(prefix, '')}`)) {
      confirmed = undefined;
      throw new ServiceError(409, '关系在重编期间变化，请刷新后继续');
    }
    return { changed, graph: confirmed };
  } catch (error) {
    if (changed) throw new ServiceError(error.status || 503, `已重编 ${changed} 条；${error.message}。再次刷新可继续完成`);
    throw error;
  } finally {
    projects.invalidate(slug);
    if (confirmed) {
      projects.cache.set(slug, { value: confirmed, until: Date.now() + projects.ttl });
      if (projects.cache.size > 100) projects.cache.delete(projects.cache.keys().next().value);
    }
  }
}
