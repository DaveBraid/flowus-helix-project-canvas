import { plain, alive, validSlug } from './flowus.mjs';

/** 仅同步本服务已有嵌入链接；不建字段、不插入网页、不修改实验或关系。 */
export async function syncUrls(projects) {
  const { api } = projects;
  const rows = (await api.all('POST', `/databases/${projects.database}/query`)).filter(alive);
  const counts = new Map();
  for (const row of rows) {
    const slug = plain(row.properties?.[projects.slugField]?.rich_text);
    counts.set(slug, (counts.get(slug) || 0) + 1);
  }
  let changed = 0;
  for (const row of rows) {
    if (projects.allowed.length && !projects.allowed.includes(row.id)) continue;
    const slug = plain(row.properties?.[projects.slugField]?.rich_text);
    if (!validSlug(slug) || counts.get(slug) !== 1) continue;
    let stored;
    try { stored = JSON.parse(plain(row.properties?.[projects.layoutField]?.rich_text)); } catch { continue; }
    if (stored.ownerProjectId !== row.id || stored.schemaVersion !== 1 || !validSlug(stored.urlSlug) || stored.urlSlug === slug) continue;
    const blocks = await api.all('GET', `/blocks/${row.id}/children`); // 确认简写改变后才读取子块。
    // 仅重写同一项目曾经登记的旧地址，避免改动用户嵌入的其他项目。
    const oldBase = `${projects.publicOrigin}/Helix/${encodeURIComponent(stored.urlSlug)}`;
    const newBase = `${projects.publicOrigin}/Helix/${encodeURIComponent(slug)}`;
    for (const block of blocks.filter(b => b.type === 'embed')) {
      const old = block.embed?.url;
      if (old !== oldBase && !old?.startsWith(`${oldBase}?`)) continue;
      await api.request('PATCH', `/blocks/${block.id}`, { embed: { url: newBase + old.slice(oldBase.length) } });
      changed++;
    }
    const { data: current, etag } = await api.request('GET', `/pages/${row.id}`);
    if (!etag || plain(current.properties?.[projects.slugField]?.rich_text) !== slug) continue;
    let latest;
    try { latest = JSON.parse(plain(current.properties?.[projects.layoutField]?.rich_text)); } catch { continue; }
    if (latest.ownerProjectId !== row.id || latest.urlSlug !== stored.urlSlug) continue;
    latest.urlSlug = slug;
    const content = JSON.stringify(latest);
    const rich_text = Array.from({ length: Math.ceil(content.length / 1800) }, (_, i) => ({ type: 'text', text: { content: content.slice(i * 1800, (i + 1) * 1800) } }));
    await api.request('PATCH', `/pages/${row.id}`, { properties: { [projects.layoutField]: { type: 'rich_text', rich_text } } }, etag);
    changed++;
  }
  if (changed) projects.cache.clear();
  return changed;
}

/** 单线程后台检查；完成一次后再等待，避免任务堆积或并发刷新。 */
export function startUrlSync(projects, interval = 60000) {
  let timer; let stopped = false;
  const tick = async () => {
    try { await syncUrls(projects); } catch { console.warn('URL sync deferred; will retry'); }
    if (!stopped) { timer = setTimeout(tick, interval); timer.unref(); }
  };
  timer = setTimeout(tick, 5000); timer.unref();
  return () => { stopped = true; clearTimeout(timer); };
}
