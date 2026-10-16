import test from 'node:test';
import assert from 'node:assert/strict';
import { arrange, lineageFocus, HEIGHT, WIDTH, edgeRoute } from '../client/graph.mjs';
const graph = (ids, pairs) => ({ nodes: ids.map(id => ({ id })), edges: pairs.map(([source,target],i) => ({ id:String(i), source,target })) });
test('主线聚焦仅包含上游，合并追溯全部来源，循环终止', () => {
 const g=graph(['a','b','c','d'],[['a','b'],['a','c'],['b','d'],['c','d']]);
 assert.deepEqual([...lineageFocus('b',g.edges).nodes].sort(),['a','b']);
 assert.equal(lineageFocus('d',g.edges).links.size,4);
 assert.equal(lineageFocus('a',[...g.edges,{id:'cycle',source:'d',target:'a'}]).nodes.size,4);
});
test('五路分支与汇合沿共同水平中线对称，无卡片重叠', async () => {
 const ids=['start','end','next','last'], pairs=[];
 for(let i=0;i<5;i++){ids.push(`b${i}`,`c${i}`);pairs.push(['start',`b${i}`],[`b${i}`,`c${i}`],[`c${i}`,'end']);}
 pairs.push(['end','next'],['next','last']);
 const p=await arrange(graph(ids,pairs));
 assert.equal(p.start.y,p.end.y);assert.equal(p.end.y,p.last.y);
 assert.deepEqual([0,1,2,3,4].map(i=>p[`b${i}`].y).sort((a,b)=>a-b),[-352,-176,0,176,352]);
 for(const a of ids)for(const b of ids)if(a!==b&&p[a].x===p[b].x)assert.ok(Math.abs(p[a].y-p[b].y)>=HEIGHT+48);
});
test('空图与环图仍可排版',async()=>{assert.deepEqual(await arrange(graph([],[])),{});assert.equal(Object.keys(await arrange(graph(['a','b'],[['a','b'],['b','a']]))).length,2);});

test('自然排序：多级编号、补号、两位数、空值和重复编号', async () => {
 const {compareExperiments}=await import('../client/graph.mjs');
 const values=['10','2.1.10','3.2','2.1.2','1a','2.1.1','2','1','','2'];
 const rows=values.map((number,i)=>({id:String(i).padStart(2,'0'),number}));
 assert.deepEqual([...rows].sort(compareExperiments).map(n=>n.number),['1','1a','2','2','2.1.1','2.1.2','2.1.10','3.2','10','']);
});
test('复杂多级分支按编号上小下大，乱序读取不会改变布局', async () => {
 const ids=['1','2','3','2.1','2.2','2.10','3.1','3.2','2.1.1','2.1.2','2.1.10','3.2.1','4','10'];
 const pairs=[['1','2'],['1','3'],['2','2.1'],['2','2.2'],['2','2.10'],['3','3.1'],['3','3.2'],['2.1','2.1.1'],['2.1','2.1.2'],['2.1','2.1.10'],['3.2','3.2.1'],['2.1.1','4'],['2.1.2','4'],['2.1.10','4'],['3.2.1','4'],['4','10']];
 const g=graph(ids,pairs);g.nodes.forEach(n=>n.number=n.id);
 const p=await arrange(g),q=await arrange({nodes:[...g.nodes].reverse(),edges:[...g.edges].reverse()});
 assert.deepEqual(p,q);
 for(const [a,b] of [['2','3'],['2.1','2.2'],['2.2','2.10'],['3.1','3.2'],['2.1.1','2.1.2'],['2.1.2','2.1.10'],['2.1.10','3.2.1']]){assert.equal(p[a].x,p[b].x);assert.ok(p[a].y<p[b].y,`${a} 必须在 ${b} 上方`);}
 for(const edge of g.edges)assert.ok(p[edge.source].x<p[edge.target].x);
});
test('已有倒序布局自动交换纵坐标，间距与横坐标不变',async()=>{
 const {orderSavedPositions}=await import('../client/graph.mjs');
 const g={nodes:[{id:'a',number:'2.1.1'},{id:'b',number:'2.1.2'},{id:'c',number:'3.2'}]};
 const old={a:{x:300,y:88},b:{x:300,y:0},c:{x:300,y:-88}};
 const sorted=orderSavedPositions(g,old);
 assert.deepEqual(sorted,{a:{x:300,y:-88},b:{x:300,y:0},c:{x:300,y:88}});
 assert.equal(old.a.y,88);assert.deepEqual(orderSavedPositions(g,sorted),sorted);
});

test('合成20节点28关系：同源层级稳定、全图无卡片重叠、跨层线不穿卡片',async()=>{
 const {readFile}=await import('node:fs/promises');const {edgeRoute,WIDTH,compareExperiments}=await import('../client/graph.mjs');
 const g=JSON.parse(await readFile(new URL('./fixtures/expanded-graph.json',import.meta.url),'utf8'));
 const p=await arrange(g),nodes=g.nodes.map(n=>({...n,position:p[n.id]}));
 assert.equal(nodes.length,20);assert.equal(g.edges.length,28);
 const byNum=Object.fromEntries(nodes.map(n=>[n.number,n]));
 assert.equal(byNum['2a'].position.x,byNum['2.1'].position.x);
 for(const a of nodes)for(const b of nodes)if(a.id!==b.id){const x=Math.abs(a.position.x-b.position.x),y=Math.abs(a.position.y-b.position.y);assert.ok(x>=WIDTH||y>=HEIGHT,'卡片不得重叠');if(a.position.x===b.position.x&&compareExperiments(a,b)<0)assert.ok(a.position.y<b.position.y);}
 let detours=0;
 g.edges.forEach((e,lane)=>{const a=p[e.source],b=p[e.target],route=edgeRoute({source:e.source,target:e.target,sourceX:a.x+WIDTH,sourceY:a.y+HEIGHT/2,targetX:b.x,targetY:b.y+HEIGHT/2},nodes,lane);if(route.detour)detours++;
 assert.ok(!/[LQ]/.test(route.path),'连线只使用平滑三次曲线');
 const top=Math.min(...nodes.map(n=>n.position.y)),bottom=Math.max(...nodes.map(n=>n.position.y+HEIGHT));
 assert.ok(route.samples.every(q=>q.y>=top&&q.y<=bottom),'测试图连线不应绕到全图外侧');
 for(const n of nodes.filter(n=>n.id!==e.source&&n.id!==e.target))assert.ok(!route.samples.some(q=>q.x>n.position.x&&q.x<n.position.x+WIDTH&&q.y>n.position.y&&q.y<n.position.y+HEIGHT),`连线穿过阶段 ${n.number}`);
 });assert.ok(detours>0,'必须覆盖实际跨层绕行情形');
});

test('自适应边界包含全部卡片及绕行线', async () => {
  const { canvasBounds } = await import('../client/graph.mjs');
  const graph = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./fixtures/expanded-graph.json', import.meta.url), 'utf8'));
  const positions = await arrange(graph), nodes = graph.nodes.map(n => ({...n,position:positions[n.id]}));
  const bounds = canvasBounds(nodes,graph.edges);
  graph.edges.forEach((e,lane)=>{
    const s=nodes.find(n=>n.id===e.source), t=nodes.find(n=>n.id===e.target);
    for(const p of edgeRoute({sourceX:s.position.x+WIDTH,sourceY:s.position.y+HEIGHT/2,targetX:t.position.x,targetY:t.position.y+HEIGHT/2,source:e.source,target:e.target},nodes,lane).samples){
      assert.ok(p.x>=bounds.x && p.x<=bounds.x+bounds.width && p.y>=bounds.y && p.y<=bounds.y+bounds.height);
    }
  });
});
