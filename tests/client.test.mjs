import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const source=await readFile(new URL('../src/client.js',import.meta.url),'utf8');
function fixture(){
 const elements=new Map();
 const element=()=>({hidden:false,disabled:false,value:'',textContent:'',classList:{toggle(){}},style:{setProperty(){}},append(){},replaceChildren(){},focus(){},close(){},showModal(){}});
 const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id)};
 const record={question:'テストの質問',topic:'start',messages:[]};let pending=[];
 const response=data=>({ok:true,json:async()=>data});
 const ctx=vm.createContext({document:{getElementById:get,createElement:element,querySelectorAll:()=>[]},window:{addEventListener(){}},fetch:async(path,opts)=>{
  if(path==='/api/status')return response({status:'connected',sharing:true,csrf:'test'});
  if(path==='/api/record')return response(record);
  if(path==='/api/models')return response({selected:'test-model'});
  if(path==='/api/chat')return new Promise((resolve,reject)=>pending.push({resolve:answer=>resolve(response(answer)),reject,opts}));
  return response({stopped:true});
 },crypto:{randomUUID},AbortController,TextDecoder,Map,Date,JSON,setTimeout,clearTimeout,setInterval,clearInterval});
 vm.runInContext(source,ctx);
 return {ctx,get,pending,record,run:s=>vm.runInContext(s,ctx)};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('text answer displays the returned adaptive question and stored transcript',async()=>{
 const f=fixture();await tick();const task=f.run("submit('架空の答え')");await tick();
 assert.equal(f.get('send').disabled,true);
 const record={...f.record,question:'次に聞きたいこと',messages:[{role:'user',kind:'raw_answer',text:'架空の答え'}]};
 f.pending[0].resolve({record,answer:{reply:'',pause:false}});await task;
 assert.equal(f.get('question').textContent,'次に聞きたいこと');assert.equal(f.get('send').disabled,false);
 assert.equal(f.get('storageState').textContent,'このMacに保存済み');
});
test('finishing cancels inference and stale completion cannot replace the question',async()=>{
 const f=fixture();await tick();f.run('active=true');const task=f.run("submit('架空の答え')");await tick();await f.run('finish()');
 assert.equal(f.pending[0].opts.signal.aborted,true);
 f.pending[0].resolve({record:{...f.record,question:'遅れて届いた質問'},answer:{pause:false}});await task;
 assert.equal(f.get('question').textContent,'テストの質問');assert.match(f.get('status').textContent,/今日はここまで/);
});
test('an old aborted request cannot unlock a newer request',async()=>{
 const f=fixture();await tick();const first=f.run("submit('最初の答え')");await tick();await f.run('finish()');
 const next=f.run("submit('次の答え')");await tick();f.pending[0].reject(new Error('aborted'));await first;
 assert.equal(f.get('send').disabled,true);assert.equal(f.run('busy'),true);
 f.pending[1].resolve({record:f.record,answer:{reply:'',pause:false}});await next;assert.equal(f.run('busy'),false);
});
