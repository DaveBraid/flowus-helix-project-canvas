import test from 'node:test';
import assert from 'node:assert/strict';
import { Projects } from '../server/flowus.mjs';
import { syncUrls } from '../server/sync.mjs';

test('手动强制刷新绕过缓存，同时合并同项目并发读取', async () => {
  const projects = new Projects({}); let loads=0, release;
  projects.load = async () => { loads++; return {value:loads}; };
  assert.equal((await projects.graph('test')).value,1);
  assert.equal((await projects.graph('test')).value,1);
  assert.equal((await projects.graph('test',true)).value,2);
  projects.load = () => new Promise(r=>{release=r;loads++;});
  const first=projects.graph('test',true), second=projects.graph('test',true);
  release({value:3}); assert.deepEqual(await first,await second);assert.equal(loads,3);
});

test('URL 未改变时只查询项目表，不读取任何项目子块', async () => {
  const calls=[];
  const rich=s=>({rich_text:[{text:{content:s}}]});
  const rows=Array.from({length:20},(_,i)=>({id:`p${i}`,properties:{slug:rich(`test${i}`),canvas:rich(JSON.stringify({ownerProjectId:`p${i}`,schemaVersion:1,urlSlug:`test${i}`}))}}));
  const api={all:async(method,path)=>{calls.push(path);return rows;}};
  assert.equal(await syncUrls({api,database:'projects',allowed:[],slugField:'slug',layoutField:'canvas'}),0);
  assert.deepEqual(calls,['/databases/projects/query']);
});

test('简写改变只修改匹配本项目旧地址的嵌入，并更新版本', async () => {
  const rich=s=>({rich_text:[{text:{content:s}}]});
  const layout={ownerProjectId:'p',schemaVersion:1,urlSlug:'old',nodes:{}};
  const row={id:'p',properties:{slug:rich('new'),canvas:rich(JSON.stringify(layout))}};
  const calls=[];
  const api={all:async(method,path)=>path.includes('query')?[row]:[{id:'e',type:'embed',embed:{url:'https://test/Helix/old'}},{id:'other',type:'embed',embed:{url:'https://other/'}}],request:async(method,path,body)=>{calls.push({method,path,body});return {data:row,etag:'v1'};}};
  const projects={api,database:'projects',allowed:[],slugField:'slug',layoutField:'canvas',publicOrigin:'https://test',cache:new Map()};
  assert.equal(await syncUrls(projects),2);
  assert.equal(calls[0].body.embed.url,'https://test/Helix/new');
  assert.equal(calls.filter(c=>c.method==='PATCH').length,2);
});


test('预览只使用五分钟内存快照，不读 API、不回退为永久数据', () => {
 const p=new Projects({});
 assert.equal(p.preview('test'),null);
 p.cache.set('test',{value:{nodes:[]},until:Date.now()-60000});
 assert.deepEqual(p.preview('test'),{nodes:[]});
 p.cache.set('test',{value:{nodes:[]},until:Date.now()-300000});
 assert.equal(p.preview('test'),null);
});
