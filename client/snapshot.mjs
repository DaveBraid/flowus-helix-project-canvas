const prefix = 'helix:snapshot:';
const maxAge = 7 * 86400000; // 最多保留七天的展示副本，不能作为写入依据。

/** 读取有界预览；输入项目简写，输出缓存图或 null，损坏和禁用存储时降级。 */
export function readSnapshot(slug, storage) {
  try {
    storage ||= globalThis.localStorage;
    const saved = JSON.parse(storage.getItem(prefix + slug));
    if (saved?.version !== 1 || !Number.isFinite(saved.at) || Date.now() - saved.at > maxAge || saved.at > Date.now() ||
      !saved.graph?.project?.id || !Array.isArray(saved.graph.nodes) || !Array.isArray(saved.graph.edges)) return null;
    return saved.graph;
  } catch { return null; }
}

/** 保存已验证图及实际坐标；输入项目简写和图，输出无；最多十个项目、每项两百万字符。 */
export function writeSnapshot(slug, graph, storage) {
  try {
    storage ||= globalThis.localStorage;
    if (graph.preview || graph.readOnlyError) return;
    const raw = JSON.stringify({ version: 1, at: Date.now(), graph });
    if (raw.length > 2000000) { storage.removeItem(prefix + slug); return; }
    storage.removeItem(prefix + slug);
    const keys = Object.keys(storage).filter(key => key.startsWith(prefix));
    while (keys.length >= 10) storage.removeItem(keys.shift());
    storage.setItem(prefix + slug, raw);
  } catch {} // 配额不足不阻止真实数据读取。
}

/** 清除无效简写或退出后的预览；输入简写或空值，输出无。 */
export function clearSnapshots(slug, storage) {
  try {
    storage ||= globalThis.localStorage;
    if (slug) storage.removeItem(prefix + slug);
    else for (const key of Object.keys(storage)) if (key.startsWith(prefix)) storage.removeItem(key);
  } catch {}
}
