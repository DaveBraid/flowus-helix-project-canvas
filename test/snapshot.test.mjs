import test from 'node:test';
import assert from 'node:assert/strict';
import { readSnapshot, writeSnapshot, clearSnapshots } from '../client/snapshot.mjs';
function storage() {
 const s = {};
 Object.defineProperties(s, { getItem: { value: k => s[k] ?? null }, setItem: { value: (k,v) => { s[k] = v; } }, removeItem: { value: k => { delete s[k]; } } });
 return s;
}
const graph = { project: { id: 'p' }, nodes: [{ id:'n', title:'1. 实验' }], edges: [], layout: { nodes: { n:{x:1,y:2} } } };
test('浏览器预览保留实际坐标；七天过期、异常、只读副本不保存', () => {
 const s=storage(); writeSnapshot('test',graph,s); assert.deepEqual(readSnapshot('test',s),graph);
 writeSnapshot('test',{...graph,preview:true,nodes:[]},s); assert.equal(readSnapshot('test',s).nodes.length,1);
 const raw=JSON.parse(s['helix:snapshot:test']); raw.at-=8*86400000; s.setItem('helix:snapshot:test',JSON.stringify(raw)); assert.equal(readSnapshot('test',s),null);
 s.setItem('helix:snapshot:test','bad'); assert.equal(readSnapshot('test',s),null);
 const blocked={getItem(){throw Error('blocked')},setItem(){throw Error('blocked')}};
 assert.equal(readSnapshot('test',blocked),null); assert.doesNotThrow(()=>writeSnapshot('test',graph,blocked));
});
test('缓存最多十个项目，单项过大清除；退出仅清理图缓存', () => {
 const s=storage(); s.setItem('helix:viewport:p','keep');
 for(let i=0;i<11;i++)writeSnapshot(String(i),graph,s);
 assert.equal(readSnapshot('0',s),null);assert.equal(Object.keys(s).length,11);
 writeSnapshot('10',{...graph,extra:'x'.repeat(2000000)},s);assert.equal(readSnapshot('10',s),null);
 clearSnapshots(null,s);assert.deepEqual(Object.keys(s),['helix:viewport:p']);
});
