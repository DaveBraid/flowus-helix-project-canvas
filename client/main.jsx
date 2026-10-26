import React, { useState, useRef, useEffect, useCallback, useId, useMemo, memo } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { ReactFlow, ReactFlowProvider, Background, BaseEdge, Handle, Position, ViewportPortal, applyNodeChanges, useReactFlow, useStore } from '@xyflow/react';
import { Plus, GitBranch, Trash2, Palette, X, ZoomIn, ZoomOut, Scan, Network, RefreshCw, ExternalLink, LogOut, LoaderCircle, LockKeyhole, ArrowUpRight, RotateCcw, Lightbulb, Play, NotebookPen, CircleCheckBig, Pause, CircleX, Circle } from 'lucide-react';
import '@xyflow/react/dist/style.css';
import './style.css';

import { WIDTH, HEIGHT, lineageFocus, orderSavedPositions, edgeRoute, canvasBounds } from './graph.mjs';
import { arrange } from './graph.mjs';
import ExperimentEditor from './ExperimentEditor.jsx';
import { readSnapshot, writeSnapshot, clearSnapshots } from './snapshot.mjs';
import { readViewport, writeViewport, zoomLimit } from './viewport.mjs';

/** 监听浏览器实际主题；输入无，输出亮暗模式，兼容系统与宿主提供的色彩方案。 */
function useColorScheme() {
  const [scheme, setScheme] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      const next = media.matches ? 'dark' : 'light';
      document.documentElement.dataset.theme = next; // CSS 与 ReactFlow 共用系统主题。
      setScheme(next);
    };
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return scheme;
}

/** 将已有状态映射到原 Helix 图标和色调；输入状态文字，输出展示配置。 */
function statusAppearance(status = '') {
  if (/完成|completed|done/i.test(status)) return { Icon: CircleCheckBig, tone: 'completed' };
  if (/终止|取消|terminated|cancelled/i.test(status)) return { Icon: CircleX, tone: 'terminated' };
  if (/暂停|搁置|paused/i.test(status)) return { Icon: Pause, tone: 'paused' };
  if (/记录|整理|recording/i.test(status)) return { Icon: NotebookPen, tone: 'recording' };
  if (/进行|执行|active|doing|progress/i.test(status)) return { Icon: Play, tone: 'active' };
  if (/计划|想法|构思|未开始|待开始|idea|planned|todo/i.test(status)) return { Icon: Lightbulb, tone: 'idea' };
  return { Icon: Circle, tone: 'idea' };
}

/** 复现原 Helix 三次贝塞尔曲线；输入端点，输出无文字的只读有向连线。 */
function HelixEdge({ sourceX, sourceY, targetX, targetY, source, target, data }) {
  const markerId = `helix-arrow-${useId().replace(/:/g, '')}`;
  const { path } = edgeRoute({sourceX, sourceY, targetX, targetY, source, target}, data?.nodes || [], data?.lane || 0);
  return <g opacity={data?.dimmed ? 0.12 : 1}>
    <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--relation-inherit)"/></marker></defs>
    <BaseEdge path={path} markerEnd={`url(#${markerId})`} style={{ stroke: 'var(--relation-inherit)', strokeWidth: 2.2 }} interactionWidth={12}/>
  </g>;
}
const edgeTypes = { helix: HelixEdge };

/** 请求同源接口；输入路径与请求选项，输出 JSON，失败保留 HTTP 状态。 */
async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { ...options.body && { 'Content-Type': 'application/json' }, ...options.headers } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.message || payload.error || `请求失败（${response.status}）`), { status: response.status, retrySameRequest: payload.retrySameRequest });
  return payload;
}

/** 展示实验节点；输入标题和状态，输出可打开原页面的节点卡片。 */
const ExperimentNode = memo(function ExperimentNode({ id, data, selected }) {
  const drag = useRef(null);
  const suppressClick = useRef(false);
  const { Icon, tone } = statusAppearance(data.status);
  const title = data.number ? data.title.replace(new RegExp(`^${data.number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[.]?\\s+`), '') : data.title;
  return <article className={`experiment ${selected ? 'selected' : ''} ${data.dimmed ? 'lineage-dimmed' : ''}`}>
    <Handle type="target" position={Position.Left} isConnectable={false}/>
    <div className="node-meta"><span className="number">阶段 {data.number || '—'}</span><Hint label="修改实验状态"><button type="button" className={`status nodrag nopan is-${tone}`} disabled={data.readOnly} aria-label={`修改 ${data.title} 的状态`} onClick={event => { event.stopPropagation(); data.onAction({ type: 'status', nodeId: id, anchor: event.currentTarget.getBoundingClientRect() }); }}><Icon size={12} aria-hidden="true"/><span>{data.status || '未设置状态'}</span></button></Hint></div>
    <a className="node-title nodrag nopan" href={data.url} target="_top" title="在 FlowUs 中打开">{title || '未命名实验'}</a>
    <div className="node-project">{data.projectTitle}</div>
    <div className="node-relations">{data.incoming ? `来源 ${data.incoming}` : '起始阶段'}{data.outgoing > 0 ? `　后续 ${data.outgoing}` : ''}</div>
    <div className="node-actions nodrag nopan" aria-label="实验操作">
      <Hint label="从此实验新增后续实验"><button type="button" disabled={data.readOnly} aria-label={`从 ${data.title} 新增实验`} onClick={event => { event.stopPropagation(); data.onAction({ type: 'create', sourceId: id }); }}><Plus size={13}/><span>新增</span></button></Hint>
      <Hint label="拖到其他实验连接；点击选择目标"><button type="button" disabled={data.readOnly} aria-label={`从 ${data.title} 连接已有实验`}
        onPointerDown={event => { if (event.button !== 0) return; event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, moved: false }; }}
        onPointerMove={event => { if (!drag.current) return; if (Math.hypot(event.clientX - drag.current.x, event.clientY - drag.current.y) > 5) drag.current.moved = true; if (drag.current.moved) data.onConnectionPreview(id, { x: event.clientX, y: event.clientY }); }}
        onPointerUp={event => { const pending = drag.current; drag.current = null; if (!pending) return; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); data.onConnectionPreview(null); if (pending.moved) { suppressClick.current = true; const targetId = document.elementFromPoint(event.clientX, event.clientY)?.closest('.react-flow__node')?.dataset.id; if (targetId && targetId !== id) data.onAction({ type: 'connect', sourceId: id, targetId }); } }}
        onPointerCancel={() => { drag.current = null; data.onConnectionPreview(null); }}
        onClick={event => { event.stopPropagation(); if (suppressClick.current) { suppressClick.current = false; return; } data.onAction({ type: 'connect', sourceId: id }); }}><GitBranch size={13}/><span>连接</span></button></Hint>
      <Hint label="查看影响并前往 FlowUs 删除"><button type="button" disabled={data.readOnly} className="node-delete" aria-label={`删除实验 ${data.title}`} onClick={event => { event.stopPropagation(); data.onAction({ type: 'delete', nodeId: id }); }}><Trash2 size={13}/><span>删除</span></button></Hint>
    </div>
    <Handle type="source" position={Position.Right} isConnectable={false}/>
  </article>;
});
const nodeTypes = { experiment: ExperimentNode };

/** 显示不依赖原生 title 的浮动提示；输入提示与触发元素，输出支持悬停及键盘的控件。 */
function Hint({ label, children }) {
  const id = useId();
  const triggerRef = useRef(null);
  const [anchor, setAnchor] = useState(null);
  const show = () => setAnchor(triggerRef.current?.getBoundingClientRect());
  const hide = () => setAnchor(null);
  useEffect(() => {
    window.addEventListener('resize', hide);
    return () => window.removeEventListener('resize', hide);
  }, []);
  return <span ref={triggerRef} className="hint-trigger" onPointerEnter={show} onPointerLeave={hide} onFocus={show} onBlur={hide} onKeyDown={event => { if (event.key === 'Escape') hide(); }}>
    {React.cloneElement(children, { 'aria-describedby': anchor ? id : undefined })}
    {anchor && createPortal(<span className="hint-popover" id={id} role="tooltip" ref={element => {
      if (!element) return;
      const { width, height } = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - 8))}px`; // 提示保持在 iframe 视口内。
      element.style.top = `${anchor.bottom + height + 16 <= window.innerHeight ? anchor.bottom + 8 : Math.max(8, anchor.top - height - 8)}px`;
    }}>{label}</span>, document.body)}
  </span>;
}

/** 展示带中文提示的工具按钮；输入图标和动作，输出可访问按钮。 */
function Tool({ label, children, ...props }) {
  return <Hint label={label}><button type="button" className="tool" title={label} aria-label={label} {...props}>{children}</button></Hint>;
}

/** 提供 RGB 实时调色；输入颜色和更新回调，输出不占固定空间的浮层。 */
function ColorPicker({ color, onChange, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const dismiss = event => { if (!ref.current?.contains(event.target) && !event.target.closest('[aria-label="卡片颜色"]')) onClose(); };
    const escape = event => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [onClose]);
  const rgb = [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16));
  const channel = (index, value) => {
    const next = [...rgb]; next[index] = Math.max(0, Math.min(255, Number(value) || 0));
    onChange('#' + next.map(n => Math.round(n).toString(16).padStart(2, '0')).join(''));
  };
  return <section ref={ref} className="color-picker" role="dialog" aria-label="RGB 卡片调色盘">
    <header><span>卡片颜色</span><Tool label="关闭调色盘" onClick={onClose}><X size={16}/></Tool></header>
    <input type="color" aria-label="选择 RGB 颜色" value={color} onChange={event => onChange(event.target.value)}/>
    {['R', 'G', 'B'].map((label, i) => <label className="color-channel" key={label}><span>{label}</span><input aria-label={`${label} 滑杆`} type="range" min="0" max="255" value={rgb[i]} onChange={event => channel(i, event.target.value)}/><input aria-label={`${label} 数值`} type="number" min="0" max="255" value={rgb[i]} onChange={event => channel(i, event.target.value)}/></label>)}
    <footer><code>{color.toUpperCase()}</code><button type="button" onClick={() => onChange('#808080')}>恢复灰色</button></footer>
  </section>;
}

/** 提供访问密码登录；输入登录回调，输出表单与 Cookie 检查结果。 */
function Login({ onLogin }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cookieBlocked, setCookieBlocked] = useState(false);
  /** 校验密码及会话 Cookie；输入表单事件，输出登录结果。 */
  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError('');
    let passwordAccepted = false;
    try {
      await request('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
      passwordAccepted = true;
      const session = await request('/api/session'); // 登录后重新读取，确认浏览器已接收会话 Cookie。
      if (!session.authenticated) { setCookieBlocked(true); throw new Error('浏览器未保存登录 Cookie。请单独打开此页面后登录。'); }
      onLogin(session);
    } catch (failure) {
      if (passwordAccepted && failure.status === 401) { setCookieBlocked(true); setError('浏览器未保存登录 Cookie。请单独打开此页面后登录。'); }
      else setError(failure.status === 401 ? '访问密码不正确，请重试。' : failure.message);
    }
    finally { setBusy(false); }
  }
  return <div className="center-screen"><form className="login-card" onSubmit={submit}>
    <div className="brand-mark"><Network size={26}/></div><h1>Helix</h1><p>项目脉络，一目了然。</p>
    <label htmlFor="password">访问密码 <span className="session-note">登录保持至下月1日（北京时间）</span></label><div className="password-field"><LockKeyhole size={16}/><input id="password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} placeholder="输入访问密码" autoFocus/></div>
    <button className="primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17}/> : '进入关系图'}</button>
    {error && <div className="form-error" role="alert">{error}</div>}
    {cookieBlocked && <a className="standalone" href={window.location.href} target="_blank" rel="noopener noreferrer">单独打开页面 <ExternalLink size={14}/></a>}
  </form></div>;
}

/** 管理关系图加载、节点布局及保存；输入会话和项目标识，输出画布。 */
function Canvas({ session, slug, onExpired, colorScheme }) {
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [project, setProject] = useState(null);
  const [phase, setPhase] = useState('loading');
  const [notice, setNotice] = useState('');
  const [saveState, setSaveState] = useState('');
  const [busy, setBusy] = useState(false);
  const [hovered, setHovered] = useState(null);
  const [cardColor, setCardColor] = useState('#808080');
  const colorRef = useRef('#808080');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editor, setEditor] = useState(null);
  useEffect(() => {
    if (editor?.type === 'create') request(`/api/projects/${encodeURIComponent(slug)}/prepare-create`, { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken }, body: '{}' }).catch(() => {}); // 打开弹层时准备；失败仍由正式提交给出错误。
  }, [editor?.type, slug, session.csrfToken]);
  const [connectionPreview, setConnectionPreview] = useState(null);
  const [statusOptions, setStatusOptions] = useState([]);
  const mutationRef = useRef(false);
  const viewportProjectRef = useRef(null);
  const viewportReadyRef = useRef(false);
  const viewportTouchedRef = useRef(false);
  const openEditor = useCallback(value => { setPickerOpen(false); setHovered(null); setEditor(value); }, []);
  const previewConnection = useCallback((sourceId, point) => setConnectionPreview(sourceId ? { sourceId, point } : null), []);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  const flow = useReactFlow();
  const maxZoom = useStore(state => zoomLimit(state.width, state.height));
  const maxZoomRef = useRef(maxZoom);
  maxZoomRef.current = maxZoom;
  useEffect(() => {
    if (flow.getZoom() > maxZoom) flow.zoomTo(maxZoom, { duration: 0 }); // 窗口变小时收紧倍率，不触发数据刷新。
  }, [flow, maxZoom]);
  const graphRef = useRef(null);
  const nodesRef = useRef([]);
  const revisionRef = useRef(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const savingTaskRef = useRef(null);
  const exitingRef = useRef(false);
  const conflictRef = useRef(false);
  const layoutWarningRef = useRef(false);
  const loadingRef = useRef(false);
  const timerRef = useRef(null);
  const versionRef = useRef(0);
  const endpoint = `/api/projects/${encodeURIComponent(slug)}`;

  /** 保存当前节点位置；输入无，输出保存状态，冲突时停止覆盖。 */
  const save = useCallback(async () => {
    if (savingTaskRef.current) return savingTaskRef.current; // 退出操作等待同一个在途保存。
    if (!dirtyRef.current || conflictRef.current || layoutWarningRef.current) return;
    const task = (async () => {
    savingRef.current = true; setSaveState('正在保存布局');
    const version = versionRef.current;
    try {
      const positions = Object.fromEntries(nodesRef.current.map(node => [node.id, node.position]));
      const result = await request(`${endpoint}/layout`, { method: 'PUT', headers: { 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ revision: revisionRef.current, positions, cardColor: colorRef.current }) });
      revisionRef.current = result.revision;
      dirtyRef.current = version !== versionRef.current; // 保存期间再次拖动，保留下一次保存任务。
      setSaveState(dirtyRef.current ? '布局待保存' : '布局已保存');
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else if (failure.status === 409) { conflictRef.current = true; setNotice('布局已在其他页面更新。请刷新后再调整，避免覆盖。'); setSaveState('保存冲突'); }
      else { setNotice('布局保存失败，当前坐标已保留。可点击重试保存。'); setSaveState('保存失败'); }
    } finally {
      savingRef.current = false;
      if (dirtyRef.current && !conflictRef.current && version !== versionRef.current) timerRef.current = setTimeout(save, 3000);
    }
    })();
    savingTaskRef.current = task;
    try { await task; } finally { savingTaskRef.current = null; }
  }, [endpoint, session.csrfToken, onExpired]);

  /** 标记布局修改并延迟三秒保存；输入新节点，输出更新后的画布状态。 */
  const changed = useCallback((next) => {
    nodesRef.current = next; setNodes(next); dirtyRef.current = true; versionRef.current += 1; setSaveState('布局待保存');
    clearTimeout(timerRef.current); timerRef.current = setTimeout(save, 3000);
  }, [save]);

  /** 拉取项目关系；输入是否主动刷新，输出图数据且保留未保存坐标。 */
  const refresh = useCallback(async (manual = false, focusId = null, suppliedGraph = null) => {
    if (loadingRef.current || savingRef.current) return;
    if (dirtyRef.current && !conflictRef.current) {
      if (manual) setNotice('布局尚未保存，保存完成后可刷新。');
      return;
    }
    clearTimeout(timerRef.current);
    loadingRef.current = true; setBusy(true);
    try {
      // 先呈现短期内存快照；本次仍读取最新数据，不启动定时轮询。
      async function* updates() {
        if (suppliedGraph) { yield suppliedGraph; return; } // 创建响应已确认编号，直接绘制真实记录。
        if (!graphRef.current) {
          const preview = readSnapshot(slug) || await request(`${endpoint}/preview`);
          if (preview) yield { ...preview, preview: true };
        }
        layoutWarningRef.current = true; // 编号协调完成前禁写，失败保留当前图。
        try {
          const reconciled = await request(`${endpoint}/reconcile`, { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken }, body: '{}' });
          if (!reconciled.graph?.project || !Array.isArray(reconciled.graph.nodes) || !Array.isArray(reconciled.graph.edges)) throw new Error('编号协调未返回完整关系图');
          yield reconciled.graph;
        } catch (failure) {
          failure.reconcile = true;
          if ([401, 403].includes(failure.status) || graphRef.current) throw failure;
          const original = await request(`${endpoint}/graph?fresh=1`); // 编号不可协调时仍允许首次只读查看，不能据此改写原图。
          yield { ...original, readOnlyError: failure.message };
        }
      }
      for await (const graph of updates()) {
      setStatusOptions(Array.isArray(graph.statusOptions) ? graph.statusOptions.filter(option => typeof option === 'string') : []);
      const restoredColor = /^#[0-9a-f]{6}$/i.test(graph.layout?.cardColor || '') ? graph.layout.cardColor : '#808080';
      colorRef.current = restoredColor; setCardColor(restoredColor);
      const oldPositions = Object.fromEntries(nodesRef.current.map(node => [node.id, node.position]));
      const saved = graph.layout?.nodes || {};
      const originalPositions = dirtyRef.current && !conflictRef.current ? oldPositions : saved;
      const positions = orderSavedPositions(graph, originalPositions);
      const missing = graph.nodes.filter(node => !positions[node.id]);
      let generated = {};
      if (missing.length) {
        generated = await arrange(graph);

      }
      const next = graph.nodes.map(node => ({ id: node.id, type: 'experiment', position: missing.length ? generated[node.id] : positions[node.id], data: { ...node, projectTitle: graph.project.title, incoming: graph.edges.filter(e => e.target === node.id).length, outgoing: graph.edges.filter(e => e.source === node.id).length }, selected: new URLSearchParams(location.search).get('node') === node.id }));
      const ids = new Set(graph.nodes.map(node => node.id));
      const nextEdges = graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).map(edge => ({ ...edge, type: 'helix' }));
      graphRef.current = graph;
      if (!graph.preview && !graph.readOnlyError) writeSnapshot(slug, { ...graph, layout: { ...graph.layout, nodes: Object.fromEntries(next.map(node => [node.id, node.position])) } }); // 保存显示坐标，避免下次预览重新排布。
      if (!dirtyRef.current || conflictRef.current) revisionRef.current = graph.revision; // 拉取期间若发生拖动，保留旧版本以检测并发修改。
      conflictRef.current = false;
      layoutWarningRef.current = Boolean(graph.layoutWarning || graph.preview || graph.readOnlyError);
      nodesRef.current = next; setNodes(next); setEdges(nextEdges); setProject(graph.project); setPhase('ready');
      setNotice(graph.readOnlyError ? `编号协调未完成：${graph.readOnlyError} 当前关系图仅供查看，编辑已停用。可点击刷新重试。` : graph.preview ? '正在显示缓存，正在获取最新数据…' : graph.layoutWarning ? `${graph.layoutWarning} 已暂停布局保存，避免覆盖。` : graph.missingRelations ? `有 ${graph.missingRelations} 条关系的目标不可访问，暂未显示。` : '');
      // 打开或刷新只更新显示，自动生成的坐标由手动排列或后续编辑保存。
      if (manual) { dirtyRef.current = false; setSaveState(''); }
      const needsViewport = viewportProjectRef.current !== graph.project.id;
      if (needsViewport || focusId) {
        viewportProjectRef.current = graph.project.id;
        const restoredViewport = readViewport(graph.project.id);
        viewportReadyRef.current = false;
        requestAnimationFrame(() => requestAnimationFrame(async () => {
          if (viewportTouchedRef.current && !focusId) { viewportReadyRef.current = true; return; } // 迟到数据不抢走用户已移动的视口。
          const focus = next.find(node => node.id === (focusId || new URLSearchParams(location.search).get('node')));
          if (focus) await flow.fitView({ nodes: [focus], padding: 0.24, duration: 0, maxZoom: maxZoomRef.current });
          else if (restoredViewport && restoredViewport.zoom <= maxZoomRef.current) await flow.setViewport(restoredViewport);
          else await flow.fitBounds(canvasBounds(next, nextEdges), { padding: 0.12, duration: 0 });
          viewportReadyRef.current = true;
        }));
      }
      }
      return true;
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else if ([403, 404].includes(failure.status)) { clearSnapshots(slug); setNodes([]); setEdges([]); graphRef.current = null; setPhase('notfound'); }
      else { if (!graphRef.current) setPhase('error'); setNotice(failure.reconcile ? `编号协调未完成：${failure.message} 当前关系图仅供查看，编辑已停用。可点击刷新重试。` : failure.status === 503 ? 'FlowUs 暂时不可用，当前关系图可能不是最新，请重试刷新。' : '暂时无法加载关系图，请稍后重试。'); }
      return false;
    } finally { loadingRef.current = false; setBusy(false); }
  }, [endpoint, flow, changed, onExpired, session.csrfToken, slug]);

  useEffect(() => {
    refresh();
    return () => { clearTimeout(timerRef.current); }; // 仅首次加载；后续数据更新由刷新按钮触发。
  }, [refresh]);

  /** 提醒关闭页面前仍有布局未保存；输入浏览器事件，输出退出确认。 */
  useEffect(() => {
    const beforeUnload = event => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    const hidden = () => { if (document.hidden && dirtyRef.current) { clearTimeout(timerRef.current); void save(); } }; // 尽早尝试保存，宿主强制销毁仍无法保证完成。
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('visibilitychange', hidden); };
  }, [save]);

  /** 重新计算并保存全部节点坐标；输入无，输出排布状态。 */
  async function relayout() {
    if (!graphRef.current || busy || conflictRef.current || layoutWarningRef.current) return;
    setBusy(true);
    try { const positions = await arrange(graphRef.current); const next = nodesRef.current.map(node => ({ ...node, position: positions[node.id] })); changed(next); requestAnimationFrame(() => flow.fitBounds(canvasBounds(next, graphRef.current.edges), { padding: 0.12, duration: 250 })); }
    catch { setNotice('自动排列失败，请稍后重试。'); }
    finally { setBusy(false); }
  }
  /** 清除服务器会话；输入无，输出登录页面或失败提示。 */
  async function logout() {
    if (exitingRef.current) return;
    exitingRef.current = true; setBusy(true); clearTimeout(timerRef.current);
    try {
      await save();
      if (dirtyRef.current) { setNotice('修改尚未保存，已取消退出。请先重试保存或解决保存冲突。'); return; }
      await request('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken } });
      clearSnapshots(); onExpired();
    } catch { setNotice('退出失败，请重试。'); }
    finally { exitingRef.current = false; setBusy(false); }
  }

  /** 保存待处理布局后写回实验；输入操作及字段，输出确认后的刷新结果。 */
  async function commitExperiment(type, payload) {
    if (mutationRef.current) return;
    mutationRef.current = true;
    let submitted = false;
    try {
      clearTimeout(timerRef.current); await save();
      if (dirtyRef.current || conflictRef.current || layoutWarningRef.current) throw new Error('当前布局尚未安全保存，请先重试保存或刷新后再编辑。');
      const node = nodesRef.current.find(item => item.id === payload.nodeId);
      let result;
      submitted = true;
      if (type === 'create') result = await request(`${endpoint}/experiments`, { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ title: payload.title, sourceIds: payload.sourceIds, requestId: payload.requestId }) });
      else {
        const patch = type === 'status' ? { status: payload.status } : { sourceIds: payload.sourceIds };
        result = await request(`${endpoint}/experiments/${encodeURIComponent(payload.nodeId)}`, { method: 'PATCH', headers: { 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ ...patch, revision: node?.data.revision }) });
      }
      setEditor(null); // 已确认写入后立即结束表单；刷新失败不能诱发重复创建。
      const patch = type === 'create' ? result.graphPatch : null;
      const current = graphRef.current;
      const confirmed = patch && patch.projectId === current?.project.id && patch.databaseId === current?.databaseId
        ? { ...current, nodes: patch.nodes, edges: patch.edges, missingRelations: patch.missingRelations } : null;
      const refreshed = await refresh(true, type === 'create' ? result.nodeId || result.node?.id : null, confirmed);
      if (!refreshed) setNotice('实验已保存，但关系图刷新失败。请点击刷新确认，勿重复新增。');
    } catch (failure) {
      if (failure.status === 401) { onExpired(); return; }
      if (failure.status === 409) throw new Error(`${failure.message} 请关闭此窗口并刷新后重试；本次输入未提交。`);
      if (submitted && type === 'create' && (!failure.status || failure.status >= 500)) throw Object.assign(new Error('新增结果尚未确认。请保留此窗口并重试同一请求，避免重复新增。'), { retrySameRequest: failure.retrySameRequest !== false });
      throw failure;
    } finally { mutationRef.current = false; }
  }

  /** 离开画布前保存布局；输入跳转事件，输出允许跳转或保留当前页面。 */
  function prepareLeave(event) {
    if (!dirtyRef.current && !savingRef.current) return;
    event.preventDefault();
    void save().then(() => setNotice(dirtyRef.current ? '布局尚未保存，已取消跳转。请先解决保存问题。' : '布局已保存，请再次点击前往 FlowUs。'));
  }

  const focus = useMemo(() => hovered && !editor && !connectionPreview ? lineageFocus(hovered, edges) : null, [hovered, edges, editor, connectionPreview]);
  const readOnly = busy || Boolean(conflictRef.current || layoutWarningRef.current);
  const displayNodes = useMemo(() => nodes.map(node => ({ ...node, data: { ...node.data, dimmed: Boolean(focus && !focus.nodes.has(node.id)), onAction: openEditor, onConnectionPreview: previewConnection, readOnly } })), [nodes, focus, readOnly, openEditor, previewConnection]);
  const displayEdges = useMemo(() => edges.map((edge, lane) => ({ ...edge, data: { nodes, lane, dimmed: Boolean(focus && !focus.links.has(edge.id)) } })), [edges, focus, nodes]);
  return <main className="canvas-shell" style={{ '--project-color': cardColor }}>
    <ReactFlow onNodeMouseEnter={(_, node) => setHovered(node.id)} onNodeMouseLeave={() => setHovered(null)} onPaneClick={() => setHovered(null)} nodes={displayNodes} edges={displayEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} colorMode={colorScheme} onNodesChange={changes => { const next = applyNodeChanges(changes, nodesRef.current); nodesRef.current = next; setNodes(next); }} onMoveStart={event => { if (event) { viewportTouchedRef.current = true; viewportReadyRef.current = true; } }} onMoveEnd={(_event, viewport) => { if (viewportReadyRef.current) writeViewport(graphRef.current?.project.id, viewport); }} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} minZoom={0.1} maxZoom={maxZoom} proOptions={{ hideAttribution: true }}>
      {connectionPreview && <ViewportPortal><svg className="connection-preview"><path d={(() => { const source = nodes.find(item => item.id === connectionPreview.sourceId), point = flow.screenToFlowPosition(connectionPreview.point); return source ? `M ${source.position.x + WIDTH} ${source.position.y + HEIGHT / 2} C ${source.position.x + WIDTH + 54} ${source.position.y + HEIGHT / 2}, ${point.x - 54} ${point.y}, ${point.x} ${point.y}` : ''; })()}/></svg></ViewportPortal>}
      <Background gap={28} size={1} color="var(--grid)" bgColor="var(--canvas)"/>
    </ReactFlow>
    {editor && <ExperimentEditor editor={editor} nodes={nodes} edges={edges} statusOptions={statusOptions} onClose={() => setEditor(null)} onCommit={commitExperiment} onPrepareLeave={prepareLeave} statusAppearance={statusAppearance}/>}
    {pickerOpen && <ColorPicker color={cardColor} onClose={closePicker} onChange={next => {
      if (exitingRef.current || loadingRef.current || next === colorRef.current || conflictRef.current || layoutWarningRef.current) return;
      colorRef.current = next; setCardColor(next); changed(nodesRef.current); // 立即预览，沿用三秒合并写回。
    }}/>}
    <div className="toolbar" role="toolbar" aria-label="关系图工具">
      <Tool label="放大" onClick={() => flow.zoomIn({ duration: 150 })}><ZoomIn size={18}/></Tool>
      <Tool label="缩小" onClick={() => flow.zoomOut({ duration: 150 })}><ZoomOut size={18}/></Tool>
      <Tool label="适应画布" onClick={() => flow.fitBounds(canvasBounds(nodesRef.current, edges), { padding: 0.12, duration: 250 })}><Scan size={18}/></Tool>
      <span className="divider"/>
      <Tool label="新增实验" disabled={busy || phase !== 'ready' || conflictRef.current || layoutWarningRef.current} onClick={() => openEditor({ type: 'create' })}><Plus size={18}/></Tool>
      <Tool label="卡片颜色" aria-expanded={pickerOpen} disabled={phase !== 'ready' || busy || conflictRef.current || layoutWarningRef.current} onClick={() => setPickerOpen(open => !open)}><Palette size={17}/></Tool>
      <Tool label="自动排列并保存布局" disabled={busy || phase !== 'ready' || conflictRef.current || layoutWarningRef.current} onClick={relayout}><Network size={18}/></Tool>
      <Tool label={conflictRef.current ? '重新加载最新布局' : '刷新关系图'} disabled={busy} onClick={() => refresh(true)}><RefreshCw size={18} className={busy ? 'spin' : ''}/></Tool>
      <Hint label="在 FlowUs 中打开项目"><a className="tool" aria-label="在 FlowUs 中打开项目" href={project ? `https://flowus.cn/${project.id}` : undefined} target="_top"><ExternalLink size={17}/></a></Hint>
      <Tool label="退出登录" disabled={busy} onClick={logout}><LogOut size={17}/></Tool>
    </div>
    {phase === 'loading' && <div className="canvas-empty"><LoaderCircle className="spin" size={23}/><p>正在读取项目关系…</p></div>}
    {phase === 'notfound' && <div className="canvas-empty"><Network size={30}/><h2>未找到项目</h2><p>请检查项目地址，或确认项目仍可访问。</p></div>}
    {phase === 'error' && <div className="canvas-empty"><Network size={30}/><h2>关系图暂时无法加载</h2><button className="text-button" onClick={() => refresh(true)}>重新加载</button></div>}
    {phase === 'ready' && !nodes.length && <div className="canvas-empty"><Network size={30}/><h2>这里还没有实验</h2><p>点击右上角“新增实验”创建第一个实验。</p></div>}
    {notice && <div className="notice" role="alert"><span>{notice}</span>{saveState === '保存失败' && <button className="retry" title="重试保存布局" aria-label="重试保存布局" onClick={save}><RotateCcw size={16}/></button>}</div>}
    {project && <div className="canvas-caption"><span className="project-name" title={project.title}>{project.title}</span><span className="caption-detail">{nodes.length} 个实验 · {edges.length} 条关系</span>{saveState && <span className="save-state" role="status">{saveState}</span>}</div>}
  </main>;
}

/** 初始化会话并解析项目路由；输入浏览器地址，输出登录或项目画布。 */
function App() {
  const colorScheme = useColorScheme();
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const expired = useCallback(() => setSession({ authenticated: false }), []);
  const match = location.pathname.match(/^\/Helix\/([^/]+)\/?$/i);
  let slug = '';
  try { slug = match ? decodeURIComponent(match[1]) : ''; } catch {}
  const loadSession = useCallback(() => { setError(''); request('/api/session').then(setSession).catch(failure => { if (failure.status === 401) expired(); else setError('暂时无法连接服务。'); }); }, [expired]);
  useEffect(loadSession, [loadSession]);
  if (!slug) return <div className="center-screen"><div className="route-empty"><Network size={30}/><h1>未找到页面</h1><p>请使用项目的 Helix 链接打开关系图。</p></div></div>;
  if (error) return <div className="center-screen"><div className="route-empty"><p role="alert">{error}</p><button className="text-button" onClick={loadSession}>重新连接</button></div></div>;
  if (!session) return <div className="center-screen"><LoaderCircle className="spin" size={24}/><span>正在连接…</span></div>;
  if (!session.authenticated) return <Login onLogin={setSession}/>;
  return <ReactFlowProvider><Canvas session={session} slug={slug} onExpired={expired} colorScheme={colorScheme}/></ReactFlowProvider>;
}

createRoot(document.getElementById('root')).render(<App/>);
