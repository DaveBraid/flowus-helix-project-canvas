import test from 'node:test';
import assert from 'node:assert/strict';
import { stageNumbers, numberedTitle, reconcileNumbers } from '../server/numbering.mjs';
const graph = (ids, pairs) => ({ nodes: ids.map(([id, number]) => ({id,number,createdTime:number.padStart(12,'0')})), edges:pairs.map(([source,target])=>({source,target})) });
test('Ob 分支共享大号，合并继续推进；删除一个分支后紧凑重编',()=>{
 const g=graph([['a','1'],['b','2'],['c','3'],['d','4']],[['a','b'],['a','c'],['b','d'],['c','d']]);
 assert.deepEqual([...stageNumbers(g)], [['a','1'],['b','2.1'],['c','2.2'],['d','3']]);
 g.nodes=g.nodes.filter(n=>n.id!=='c');g.edges=g.edges.filter(e=>e.source!=='c'&&e.target!=='c');
 assert.deepEqual([...stageNumbers(g)], [['a','1'],['b','2'],['d','3']]);
});
test('固定创建顺序重编，再次计算不变化，循环拒绝',()=>{
 const g=graph([['a','1'],['b','2.2'],['c','2.1'],['d','6']],[['a','b'],['a','c'],['b','d'],['c','d']]);
 const n=stageNumbers(g);assert.equal(n.get('c'),'2.1');assert.equal(n.get('b'),'2.2');
 g.nodes.forEach(x=>x.number=n.get(x.id));assert.deepEqual(stageNumbers(g),n);
 g.edges.push({source:'d',target:'a'});assert.throws(()=>stageNumbers(g),/循环/);
});
test('标题前缀分片、1a和无编号标题；正文格式保留',()=>{
 const title=[{type:'text',text:{content:'1'},plain_text:'1'},{type:'text',text:{content:'a. 实验'},plain_text:'a. 实验',annotations:{bold:true}}];
 const result=numberedTitle(title,'2.1');assert.equal(result.map(x=>x.text.content).join(''),'2.1. 实验');assert.equal(result[1].annotations.bold,true);assert.equal(title[1].text.content,'a. 实验');
 assert.equal(numberedTitle([{text:{content:'实验'}}],'1').map(x=>x.text.content).join(''),'1. 实验');
});
test('重编遇并发标题变化不写；只用当前页面ETag写标题',async()=>{
 let storedTitle='9. 实验';const writes=[];const p={load:async()=>({databaseId:'db',...graph([['a','9']],[]),nodes:[{id:'a',number:'9',title:storedTitle}]}),cache:new Map(),invalidate:()=>{},api:{request:async(method,path,body,rev)=>{
 if(method==='GET')return {data:{parent:{database_id:'db'},properties:{Name:{id:'title',type:'title',title:[{text:{content:'9. 实验'}}]}}},etag:'v1'};
 writes.push({body,rev});storedTitle=body.properties.Name.title.map(x=>x.text.content).join('');return {};
 }}};
 assert.equal((await reconcileNumbers(p,'test')).changed,1);assert.equal(writes[0].rev,'v1');assert.deepEqual(Object.keys(writes[0].body.properties),['Name']);
 storedTitle='9. 实验';p.api.request=async()=>({data:{parent:{database_id:'db'},properties:{Name:{type:'title',title:[{text:{content:'用户改名'}}]}}},etag:'v2'});
 await assert.rejects(reconcileNumbers(p,'test'),/已变化/);
});

test('部分写入失败不改变后续顺序；多组并行分支编号不重复',()=>{
 const g=graph([['a','9'],['b','2'],['c','5']],[]);const before=stageNumbers(g);
 g.nodes[0].number=before.get('a');assert.deepEqual(stageNumbers(g),before);
 const nested=graph([['a','1'],['b','2'],['c','3'],['d','4'],['e','5'],['f','6'],['g','7']],[['a','b'],['a','c'],['b','d'],['b','e'],['c','f'],['c','g']]);
 const codes=[...stageNumbers(nested).values()];assert.equal(new Set(codes).size,codes.length);
});
test('缺失来源仅在确认同表回收站后忽略，404与表外引用拒绝重编',async()=>{
 let source={in_trash:true,parent:{database_id:'db'}};const p={cache:new Map(),ttl:30000,load:async()=>({databaseId:'db',nodes:[{id:'a',title:'1. 实验',number:'1',sourceIds:['deleted']}],edges:[],missingRelations:1}),invalidate:()=>{},api:{request:async()=>({data:source})}};
 assert.equal((await reconcileNumbers(p,'test')).changed,0);
 source={parent:{database_id:'other'}};await assert.rejects(reconcileNumbers(p,'test'),/表外/);
 p.api.request=async()=>{throw Object.assign(new Error('无权限'),{status:404});};await assert.rejects(reconcileNumbers(p,'test'),/无权限/);
});
