/** 读取项目观看位置；输入稳定项目 ID 与可选存储，输出有效视口或空值。 */
export function readViewport(projectId, storage) {
  try {
    const saved = JSON.parse((storage || globalThis.localStorage).getItem(`helix:viewport:${projectId}`));
    if (saved?.schemaVersion !== 1 || ![saved.x, saved.y, saved.zoom].every(Number.isFinite) || Math.abs(saved.x) > 1e6 || Math.abs(saved.y) > 1e6 || saved.zoom < .1 || saved.zoom > 2.5) return null;
    return { x: saved.x, y: saved.y, zoom: saved.zoom };
  } catch { return null; } // 禁用存储或旧数据损坏时，正常适应画布。
}

/** 保存项目观看位置；输入项目 ID 和视口，输出无，存储失败不影响画布。 */
export function writeViewport(projectId, viewport, storage) {
  if (!projectId || ![viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) || Math.abs(viewport.x) > 1e6 || Math.abs(viewport.y) > 1e6 || viewport.zoom < .1 || viewport.zoom > 2.5) return;
  try { (storage || globalThis.localStorage).setItem(`helix:viewport:${projectId}`, JSON.stringify({ schemaVersion: 1, x: viewport.x, y: viewport.y, zoom: viewport.zoom })); } catch {} // iframe 存储受限或空间不足时安全降级。
}
import { WIDTH, HEIGHT } from './graph.mjs';

/** 按窗口限制单卡显示尺寸；大窗口最多原尺寸的 1.1 倍，小窗口保留周围空白。 */
export function zoomLimit(width, height) {
  return width > 0 && height > 0 ? Math.max(.1, Math.min(1.1, width * .75 / WIDTH, height * .55 / HEIGHT)) : 1.1;
}
