let elkPromise;
export const WIDTH = 248;
export const HEIGHT = 128;

const numberCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** 比较实验编号；输入节点，输出自然顺序，空编号末置、重复编号用稳定 ID 排序。 */
export function compareExperiments(a, b) {
  const left = String(a.number ?? '').trim(), right = String(b.number ?? '').trim();
  if (!left !== !right) return left ? -1 : 1;
  return numberCollator.compare(left, right) || String(a.id).localeCompare(String(b.id));
}

/** 校正已保存的同层顺序；复用原坐标槽位，不移动横坐标、不重置颜色或手动间距。 */
export function orderSavedPositions(graph, positions) {
  const layers = new Map(), ordered = { ...positions };
  for (const node of graph.nodes) {
    const point = positions[node.id];
    if (point) layers.set(point.x, [...layers.get(point.x) || [], node]);
  }
  for (const nodes of layers.values()) {
    const slots = nodes.map(node => positions[node.id].y).sort((a, b) => a - b);
    nodes.sort(compareExperiments).forEach((node, i) => { ordered[node.id] = { ...positions[node.id], y: slots[i] }; });
  }
  return ordered;
}

/** 按 Helix 上游追溯规则聚焦；输入节点与边，输出保留的节点和边 ID，兼容循环。 */
export function lineageFocus(id, edges) {
  const nodes = new Set([id]), links = new Set(), queue = [id];
  const incoming = new Map();
  for (const edge of edges) incoming.set(edge.target, [...incoming.get(edge.target) || [], edge]);
  for (let i = 0; i < queue.length; i++) for (const edge of incoming.get(queue[i]) || []) {
    links.add(edge.id);
    if (!nodes.has(edge.source)) { nodes.add(edge.source); queue.push(edge.source); }
  }
  return { nodes, links };
}

/** 对 DAG 按最长来源深度分层；输入节点与边，输出对称布局，循环图退回 ELK。 */
export async function arrange(graph) {
  const sorted = [...graph.nodes].sort(compareExperiments);
  const ids = new Set(sorted.map(n => n.id));
  const edges = [...graph.edges].filter(e => ids.has(e.source) && ids.has(e.target)).sort((a,b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  const incoming = new Map(sorted.map(n => [n.id, 0])), depth = new Map(sorted.map(n => [n.id, 0]));
  const outgoing = new Map(sorted.map(n => [n.id, []]));
  for (const e of edges) { incoming.set(e.target, incoming.get(e.target) + 1); outgoing.get(e.source).push(e.target); }
  const queue = sorted.filter(n => incoming.get(n.id) === 0).map(n => n.id);
  for (let i = 0; i < queue.length; i++) for (const target of outgoing.get(queue[i])) {
    depth.set(target, Math.max(depth.get(target), depth.get(queue[i]) + 1));
    incoming.set(target, incoming.get(target) - 1);
    if (!incoming.get(target)) queue.push(target);
  }
  if (queue.length === sorted.length) {
    // 独立实验单独成行，不挤偏有来源关系的主图中线。
    const connected = new Set(edges.flatMap(e => [e.source, e.target]));
    const groups = new Map();
    for (const node of sorted.filter(n => connected.has(n.id))) {
      const rank = depth.get(node.id); groups.set(rank, [...groups.get(rank) || [], node]);
    }
    // 跨层连线需要穿过中间列的行间通道，按数量增加留白。
    const skips = edges.filter(e => depth.get(e.target) - depth.get(e.source) > 1).length;
    const rowGap = 48 + Math.min(64, skips * 6), columnGap = 96 + Math.min(144, skips * 12);
    const positions = {}; let bottom = -HEIGHT - rowGap;
    for (const [rank, nodes] of groups) {
      nodes.forEach((node,i) => { positions[node.id] = { x: 12 + rank * (WIDTH + columnGap), y: (i - (nodes.length - 1) / 2) * (HEIGHT + rowGap) }; bottom = Math.max(bottom, positions[node.id].y); });
    }
    for (const node of sorted.filter(n => !connected.has(n.id))) { bottom += HEIGHT + rowGap; positions[node.id] = { x: 12, y: bottom }; }
    return positions;
  }
  elkPromise ||= import('elkjs/lib/elk.bundled.js').then(module => new module.default());
  const result = await (await elkPromise).layout({id:'root',layoutOptions:{'elk.algorithm':'layered','elk.direction':'RIGHT','elk.spacing.nodeNode':'48','elk.layered.spacing.nodeNodeBetweenLayers':'96'},children:sorted.map(n=>({id:n.id,width:WIDTH,height:HEIGHT})),edges:edges.map(e=>({id:e.id,sources:[e.source],targets:[e.target]}))});
  const raw = Object.fromEntries((result.children || []).map(n => [n.id,{x:n.x,y:n.y}]));
  return orderSavedPositions(graph, raw); // 循环不强行伪造拓扑方向。
}

/** 用水平切线连接途经点；输入通道点，输出平滑三次曲线及真实曲线采样。 */
function smoothRoute(points) {
  let path = `M ${points[0].x} ${points[0].y}`; const samples=[];
  for(let i=1;i<points.length;i++) {
    const a=points[i-1],b=points[i],c=(b.x-a.x)*.45;
    path+=` C ${a.x+c} ${a.y}, ${b.x-c} ${b.y}, ${b.x} ${b.y}`;
    for(let k=0;k<=128;k++){const t=k/128,u=1-t;samples.push({x:u*u*u*a.x+3*u*u*t*(a.x+c)+3*u*t*t*(b.x-c)+t*t*t*b.x,y:u*u*u*a.y+3*u*u*t*a.y+3*u*t*t*b.y+t*t*t*b.y});}
  }
  return {path,samples};
}

/** 跨层线穿过各列最近的行间通道；输入端点和卡片，输出无直角的平滑路径。 */
export function edgeRoute({sourceX:sx,sourceY:sy,targetX:tx,targetY:ty,source,target}, nodes, lane=0) {
  const direct=smoothRoute([{x:sx,y:sy},{x:tx,y:ty}]);
  const obstacles=nodes.filter(n=>n.id!==source&&n.id!==target);
  const blocked=direct.samples.some(p=>obstacles.some(n=>p.x>n.position.x-6&&p.x<n.position.x+WIDTH+6&&p.y>n.position.y-6&&p.y<n.position.y+HEIGHT+6));
  if(!blocked&&tx>sx)return {...direct,detour:false};
  const columns=new Map();
  for(const n of obstacles)if(n.position.x>sx&&n.position.x+WIDTH<tx)columns.set(n.position.x,[...columns.get(n.position.x)||[],n]);
  const points=[{x:sx,y:sy}];
  for(const [x,rows] of [...columns].sort(([a],[b])=>a-b)) {
    rows.sort((a,b)=>a.position.y-b.position.y);
    const ideal=sy+(ty-sy)*(x+WIDTH/2-sx)/(tx-sx);
    const slots=[rows[0].position.y-32,rows.at(-1).position.y+HEIGHT+32];
    for(let i=1;i<rows.length;i++)if(rows[i].position.y-rows[i-1].position.y-HEIGHT>=24)slots.push((rows[i-1].position.y+HEIGHT+rows[i].position.y)/2);
    const y=slots.sort((a,b)=>Math.abs(a-ideal)-Math.abs(b-ideal)||a-b)[0];
    points.push({x:x-16,y},{x:x+WIDTH+16,y}); // 在整列宽度内保持通道高度，转弯只发生在列间。
  }
  if(!columns.size&&tx<=sx){
    const top=Math.min(...nodes.map(n=>n.position.y))-64;
    points.push({x:sx+64,y:top},{x:tx-64,y:top}); // 循环图仍保留回边，使用平滑外侧通道。
  }
  points.push({x:tx,y:ty});
  return {...smoothRoute(points),detour:true};
}

/** 将绕行线纳入视口；输入节点和边，输出完整画布包围框。 */
export function canvasBounds(nodes, edges) {
  if (!nodes.length) return {x:0,y:0,width:1,height:1};
  const points=nodes.flatMap(n=>[n.position,{x:n.position.x+WIDTH,y:n.position.y+HEIGHT}]);
  const byId=new Map(nodes.map(n=>[n.id,n]));
  edges.forEach((e,lane)=>{
    const s=byId.get(e.source),t=byId.get(e.target); if(!s||!t)return;
    points.push(...edgeRoute({sourceX:s.position.x+WIDTH,sourceY:s.position.y+HEIGHT/2,targetX:t.position.x,targetY:t.position.y+HEIGHT/2,source:e.source,target:e.target},nodes,lane).samples);
  });
  const x=Math.min(...points.map(p=>p.x)),y=Math.min(...points.map(p=>p.y));
  return {x,y,width:Math.max(...points.map(p=>p.x))-x,height:Math.max(...points.map(p=>p.y))-y};
}
