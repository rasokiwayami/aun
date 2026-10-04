import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const source=await readFile(new URL('../src/client.js',import.meta.url),'utf8');
const html=await readFile(new URL('../src/ui.html',import.meta.url),'utf8');
const htmlIds=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
function fixture({connected=false,consent=false,locked=false,voice=false,handle,fakeTime=false}={}){
 const elements=new Map();
 const element=(tag='div')=>({tagName:tag.toUpperCase(),hidden:false,disabled:false,value:'',checked:false,textContent:'',children:[],dataset:{},files:[],open:false,classList:{toggle(){}},style:{setProperty(){}},append(...v){this.children.push(...v)},replaceChildren(...v){this.children=v;this.textContent=''},setAttribute(){},removeAttribute(){},focus(){},close(){this.open=false},showModal(){this.open=true},click(){},selectedOptions:[{textContent:'今のこと'}]});
 const get=id=>{if(!htmlIds.has(id))return null;if(!elements.has(id))elements.set(id,element());return elements.get(id)};
 const base={revision:1,question:'テストの質問',questionId:'q1',topic:'start',messages:[],proposals:[],knowledge:[],inquiry:{refusedTopics:[]},consent:{model:consent},settings:{}};
 let record=base;const calls=[],pending=[],tools=new Map(),timers=new Map();let timerId=0;
 const response=data=>({ok:true,json:async()=>data});
 const ctx=vm.createContext({document:{getElementById:get,createElement:element,querySelectorAll:()=>[],modelContext:{registerTool(tool){tools.set(tool.name,tool)}}},window:{addEventListener(){},open(){return {opener:null,location:{},close(){}}}},navigator:{clipboard:{writeText:async()=>{}}},fetch:async(path,opts={})=>{
  const body=opts.body?JSON.parse(opts.body):undefined;calls.push({path,body,opts});
  if(handle){const custom=await handle(path,body,opts);if(custom!==undefined)return custom;}
  if(path==='/api/status')return response({vault:{exists:true,unlocked:!locked},provider:{available:true,connected,sharing:connected},capabilities:{voice},csrf:'test'});
  if(path==='/api/record')return response(record);
  if(path==='/api/capture'){record={...record,revision:record.revision+1,messages:[...record.messages,{id:'source1',revision:1,role:'user',kind:body.kind,text:body.text}]};return response({record,sourceId:'source1',sourceRevision:1})}
  if(path==='/api/navigate'){record={...record,inquiry:{...record.inquiry,paused:body.action==='pause'?true:body.action==='resume'?false:record.inquiry.paused}};return response({record})}
  if(path==='/api/settings'){record={...record,settings:{...record.settings,...body}};return response({record})}
  if(path==='/api/interview')return new Promise((resolve,reject)=>pending.push({resolve:answer=>resolve(response(answer)),reject,opts}));
  if(path==='/api/vault/lock'){locked=true;return response({locked:true})}
  if(path==='/api/vault/unlock')return response({record});
  if(path==='/api/pack/preview')return response({pack:{id:'p',revision:1,markdown:'private pack',items:[],omitted:[]},record});
  if(path==='/api/pack/export')return response({filename:'context.md',content:'validated content',mime:'text/markdown',record});
  return response({record});
 },crypto:{randomUUID},AbortController,TextDecoder,Map,Set,Date,JSON,Blob,URL,setTimeout:fakeTime?(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id}:setTimeout,clearTimeout:fakeTime?(id)=>timers.delete(id):clearTimeout,setInterval,clearInterval});
 vm.runInContext(source,ctx);
 return {ctx,get,calls,pending,tools,base,timers,run:s=>vm.runInContext(s,ctx)};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('offline text is durably captured before any optional interview and remains visible',async()=>{
 const f=fixture();await tick();f.get('message').value='架空の答え';await f.run("submit('架空の答え')");
 assert.equal(f.calls.filter(c=>c.path==='/api/capture').length,1);
 assert.equal(f.calls.filter(c=>c.path==='/api/interview').length,0);
 assert.equal(f.get('message').value,'');assert.equal(f.get('send').disabled,false);
 assert.equal(f.get('storageState').textContent,'このMacに保存済み');
});
test('consented cloud interview starts only after local capture acknowledgment',async()=>{
 const f=fixture({connected:true,consent:true});await tick();const task=f.run("submit('架空の答え')");await tick();
 assert.equal(f.pending.length,1);
 assert.match(f.get('modelPreviewText').textContent,/架空の答え/);
 assert.ok(f.calls.findIndex(c=>c.path==='/api/capture') < f.calls.findIndex(c=>c.path==='/api/interview'));
 assert.equal(f.get('message').value,'');
 f.pending[0].resolve({record:{...f.base,question:'次の質問'},answer:{reply:'受けとめました',pause:false}});await task;
 assert.equal(f.get('question').textContent,'次の質問');
});
test('finishing cancels inference and stale completion cannot replace the question',async()=>{
 const f=fixture({connected:true,consent:true});await tick();const task=f.run("submit('架空の答え')");await tick();await f.run('finish()');
 assert.equal(f.pending[0].opts.signal.aborted,true);
 f.pending[0].resolve({record:{...f.base,question:'遅れて届いた質問'},answer:{pause:false}});await task;
 assert.equal(f.get('question').textContent,'テストの質問');assert.match(f.get('status').textContent,/今日はここまで/);
});
test('lock clears private display, drafts, open editors and default tool does not expose question',async()=>{
 const f=fixture();await tick();await f.run("submit('非公開の発言')");f.get('message').value='未送信';f.get('caption').textContent='字幕';f.get('editText').value='編集内容';f.get('editor').showModal();
 await f.run('lockVault()');
 assert.equal(f.get('message').value,'');assert.equal(f.get('caption').textContent,'');assert.equal(f.get('editText').value,'');assert.equal(f.get('editor').open,false);
 assert.equal(f.get('transcriptBody').children.length,0);assert.equal(f.get('historyBody').children.length,0);
 const result=await f.tools.get('read_current_interview').execute();assert.equal('question' in result,false);
 assert.equal(f.run('record'),null);
});
test('partial speech remains a browser draft and manual submission marks it non-final',async()=>{
 const f=fixture({voice:true});await tick();f.run('active=true');f.run("receiveTranscript({turn:1,text:'途中の文字',final:false},revision)");
 assert.equal(f.get('message').value,'途中の文字');assert.equal(f.calls.filter(c=>c.path==='/api/capture').length,0);
 await f.run("submit(document.getElementById('message').value)");
 const capture=f.calls.find(c=>c.path==='/api/capture');assert.equal(capture.body.kind,'speech');assert.equal(capture.body.speechFinal,false);assert.equal(capture.body.speechAccepted,true);
});
test('proposal review submits only the version currently visible on the selected card',async()=>{
 const f=fixture();await tick();f.run("record.proposals=[{id:'a1',revision:4,text:'提案一',evidence:[]},{id:'a2',revision:8,text:'提案二',evidence:[]}];drawRecord()");
 await f.run("reviewAssertion({id:'a2',revision:8},'hold')");
 const call=f.calls.find(c=>c.path==='/api/review');assert.equal(call.body.id,'a2');assert.equal(call.body.expectedRevision,8);assert.equal(call.body.decision,'hold');
});
test('clipboard export revalidates preview rather than copying cached private text',async()=>{
 const f=fixture();await tick();f.run("currentPack={id:'p',revision:1,markdown:'cached'}");await f.run("exportPack('clipboard')");
 const call=f.calls.find(c=>c.path==='/api/pack/export');assert.equal(call.body.id,'p');assert.equal(call.body.expectedRevision,1);
});
test('locked initial status does not fetch private record or models',async()=>{
 const f=fixture({locked:true});await tick();assert.equal(f.calls.some(c=>c.path==='/api/record'),false);assert.equal(f.calls.some(c=>c.path==='/api/models'),false);
 assert.equal(f.get('vaultDialog').open,true);
});
test('failed optional inference leaves the captured source available and never captures it again for retry',async()=>{
 const f=fixture({connected:true,consent:true});await tick();const task=f.run("submit('保存済みの発言')");await tick();f.pending[0].reject(Error('provider unavailable'));await task;
 assert.equal(f.get('message').value,'');assert.match(f.get('error').textContent,/保存済み/);
 assert.equal(f.run('record.messages[0].text'),'保存済みの発言');
 const retry=f.run('runInterview()');await tick();assert.equal(f.calls.filter(c=>c.path==='/api/capture').length,1);
 f.pending[1].resolve({record:f.base,answer:{reply:'',pause:false}});await retry;
});
test('capture transport failure retains exact retry identity and content',async()=>{
 let attempts=0;const f=fixture({handle(path){if(path==='/api/capture'&&attempts++===0)throw Error('connection lost')}});await tick();
 await f.run("submit('同じ原文')");assert.equal(f.get('message').value,'同じ原文');
 await f.run("submit('同じ原文')");const captures=f.calls.filter(c=>c.path==='/api/capture');assert.deepEqual(captures[0].body,captures[1].body);
});
test('an old aborted interview cannot clear a newer capture or interview busy state',async()=>{
 const f=fixture({connected:true,consent:true});await tick();const first=f.run("submit('一つ目')");await tick();await f.run('finish()');
 await f.run('resumeSession()');const next=f.run("submit('二つ目')");await tick();f.pending[0].reject(Error('aborted'));await first;
 assert.equal(f.run('busy'),true);assert.equal(f.get('send').disabled,true);
 f.pending[1].resolve({record:f.base,answer:{reply:'',pause:false}});await next;assert.equal(f.run('busy'),false);
});
test('revoking consent aborts an active interview and rejects its late completion',async()=>{
 const f=fixture({connected:true,consent:true});await tick();const task=f.run("submit('撤回前の発言')");await tick();await f.run('setConsent(false)');
 assert.equal(f.pending[0].opts.signal.aborted,true);assert.equal(f.calls.find(c=>c.path==='/api/consent').body.enabled,false);
 f.pending[0].resolve({record:{...f.base,question:'撤回後の遅い返事'},answer:{reply:'',pause:false}});await task;
 assert.notEqual(f.get('question').textContent,'撤回後の遅い返事');
});
test('opted-in speech autosend waits until every segment is final',async()=>{
 const f=fixture({voice:true,fakeTime:true});await tick();f.get('autoSend').checked=true;f.run('active=true');
 f.run("receiveTranscript({turn:1,text:'未確定',final:false},revision);receiveTranscript({turn:2,text:'確定',final:true},revision)");
 assert.equal([...f.timers.values()].filter(t=>t.ms===4000).length,0);
 f.run("receiveTranscript({turn:1,text:'確定した一文',final:true},revision)");
 const silence=[...f.timers.values()].find(t=>t.ms===4000);assert.ok(silence);await silence.fn();await tick();
 const capture=f.calls.find(c=>c.path==='/api/capture');assert.ok(capture);assert.equal(capture.body.speechFinal,true);assert.equal(capture.body.speechAccepted,true);
});
test('manual speech correction cancels pending autosend and never persists a partial draft',async()=>{
 const f=fixture({voice:true,fakeTime:true});await tick();f.get('autoSend').checked=true;f.run('active=true');
 f.run("receiveTranscript({turn:1,text:'認識した文',final:true},revision)");const silence=[...f.timers.values()].find(t=>t.ms===4000);assert.ok(silence);
 f.get('message').value='自分で直した文';f.run('saveDraftLater()');await silence.fn();await tick();
 assert.equal(f.calls.some(c=>c.path==='/api/capture'||c.path==='/api/draft'),false);
});
test('source edit binds the original displayed revision and removes obsolete preview text',async()=>{
 const f=fixture();await tick();f.run("openEditor('source',{id:'source1',revision:7,text:'元の文'});document.getElementById('modelPreviewText').textContent='元の文'");
 f.get('editText').value='訂正した文';await f.run('saveEditor({preventDefault(){}})');
 const edit=f.calls.find(c=>c.path==='/api/source/edit');assert.equal(edit.body.expectedRevision,7);assert.equal(edit.body.text,'訂正した文');assert.equal(f.get('modelPreviewText').textContent,'');
});
test('proposal screen limits each review batch to three and task-only review expires',async()=>{
 const f=fixture();await tick();f.run("record.proposals=Array.from({length:5},(_,i)=>({id:'a'+i,revision:1,text:'案'+i,evidence:[]}));drawProposals()");
 assert.equal(f.get('proposalBody').children.length,3);assert.equal(f.get('moreProposals').hidden,false);
 await f.run("reviewAssertion({id:'a1',revision:1},'task_only')");const body=f.calls.find(c=>c.path==='/api/review').body;assert.ok(body.taskId);assert.ok(new Date(body.expiresAt).getTime()>Date.now());
});
test('unlock clears the entered secret and does not start provider or microphone',async()=>{
 const f=fixture({locked:true});await tick();f.get('passphrase').value='synthetic-passphrase';await f.run('openWithPassphrase({preventDefault(){}})');
 assert.equal(f.get('passphrase').value,'');assert.equal(f.get('vaultDialog').open,false);
 assert.equal(f.calls.some(c=>['/api/auth/start','/api/voice','/api/interview'].includes(c.path)),false);
});
test('tool-visible question requires an explicit setting even while unlocked',async()=>{
 const f=fixture();await tick();let result=await f.tools.get('read_current_interview').execute();assert.equal('question' in result,false);
 f.run('record.settings.showPrivateQuestionToTools=true');result=await f.tools.get('read_current_interview').execute();assert.equal(result.question,'テストの質問');
});
test('manual knowledge saves scope, exceptions, validity and permissions as explicit user choices',async()=>{
 const f=fixture();await tick();f.run("openEditor('knowledge',{id:'k1',revision:3,text:'毎朝学ぶ',kind:'policy',hardConstraint:true,scope:{purposes:['learn'],conditions:[{field:'timeOfDay',op:'eq',value:'morning'}],exceptions:['休日は除く']},validTime:{start:null,end:null},policy:{model:false,disclosure:false}})");
 f.get('policyModel').checked=true;await f.run('saveEditor({preventDefault(){}})');
 const body=f.calls.find(c=>c.path==='/api/knowledge/save').body;
 assert.equal(body.expectedRevision,3);assert.deepEqual(body.scope.purposes,['learn']);assert.deepEqual(body.scope.conditions,[{field:'timeOfDay',op:'eq',value:'morning'}]);assert.deepEqual(body.scope.exceptions,['休日は除く']);assert.equal(body.hardConstraint,true);assert.deepEqual(body.policy,{model:true,disclosure:false});
});
test('lock during preview prevents a late private pack from reappearing',async()=>{
 let resolvePreview;const f=fixture({handle(path){if(path==='/api/pack/preview')return new Promise(resolve=>{resolvePreview=resolve})}});await tick();f.get('packPurpose').value='learn';f.get('packAudience').value='self';f.get('packDestination').value='file';
 const task=f.run('previewPack({preventDefault(){}})');await tick();await f.run('lockVault()');
 resolvePreview({ok:true,json:async()=>({pack:{id:'late',revision:1,text:'非公開の遅い出力',items:[]},record:f.base})});await task;
 assert.equal(f.get('packResult').hidden,true);assert.equal(f.get('packText').textContent,'');assert.equal(f.run('record'),null);
});
test('finish saves a durable paused state without deleting saved answers or the current question',async()=>{
 const f=fixture();await tick();await f.run("submit('残す回答')");await f.run('finish()');
 const pause=f.calls.find(c=>c.path==='/api/navigate'&&c.body.action==='pause');assert.ok(pause);
 assert.equal(f.run('record.inquiry.paused'),true);assert.equal(f.run('record.messages[0].text'),'残す回答');assert.equal(f.get('question').textContent,'テストの質問');assert.equal(f.get('resumeSession').hidden,false);
 await f.run('resumeSession()');const resume=f.calls.find(c=>c.path==='/api/navigate'&&c.body.action==='resume');assert.ok(resume);assert.equal('questionId' in resume.body,false);assert.equal(f.run('record.inquiry.paused'),false);assert.equal(f.calls.some(c=>c.path==='/api/voice'||c.path==='/api/interview'),false);
});
test('paused state from reload offers resume and does not ask another question',async()=>{
 const pausedRecord={revision:1,question:'保存した問い',questionId:'saved-q',topic:'start',messages:[],proposals:[],knowledge:[],inquiry:{paused:true,refusedTopics:['people']},consent:{model:false},settings:{}};
 const f=fixture({handle(path){if(path==='/api/record')return {ok:true,json:async()=>pausedRecord}}});await tick();
 assert.equal(f.get('question').textContent,'保存した問い');assert.equal(f.get('resumeSession').hidden,false);assert.equal(f.get('send').disabled,true);assert.match(f.get('status').textContent,/保存/);assert.equal(f.calls.some(c=>c.path==='/api/navigate'),false);
});
test('finish persists opted-in text draft before pausing and preserves unopted-in text on screen',async()=>{
 const f=fixture();await tick();f.get('message').value='まだ送っていない';await f.run('finish()');
 assert.equal(f.calls.some(c=>c.path==='/api/draft'),false);assert.equal(f.get('message').value,'まだ送っていない');assert.equal(f.get('pauseDraftOffer').hidden,false);
 await f.run('resumeSession()');f.run('record.settings.draftPersistence=true');await f.run('finish()');
 const saveIndex=f.calls.findIndex(c=>c.path==='/api/draft');const pauseIndex=f.calls.findLastIndex(c=>c.path==='/api/navigate'&&c.body.action==='pause');assert.ok(saveIndex>=0&&saveIndex<pauseIndex);assert.equal(f.calls[saveIndex].body.text,'まだ送っていない');
});
test('only an explicit resend permits a previously local-only source to reach the provider',async()=>{
 const f=fixture({connected:true,consent:false});await tick();await f.run("submit('同意前の発言')");assert.equal(f.calls.some(c=>c.path==='/api/source/permission'),false);
 f.run('record.consent.model=true');f.run("prepareSourceInterview({id:'source1',revision:1,text:'同意前の発言',policy:{model:false}})");assert.equal(f.calls.some(c=>c.path==='/api/source/permission'),false);
 const task=f.run('sendSelectedSource()');await tick();const permission=f.calls.find(c=>c.path==='/api/source/permission');assert.ok(permission);assert.equal(permission.body.model,true);assert.equal(permission.body.expectedRevision,1);assert.equal(f.pending.length,1);f.pending[0].resolve({record:f.base,answer:{pause:false}});await task;
});
test('document import is previewed and explicitly saved with unknown speaker by default',async()=>{
 const f=fixture();await tick();f.get('documentFile').files=[{name:'synthetic.md',size:12,text:async()=>'他者の文書'}];await f.run('loadDocument()');assert.equal(f.get('documentText').value,'他者の文書');assert.equal(f.calls.some(c=>c.path==='/api/capture'),false);
 await f.run('captureDocument({preventDefault(){}})');const capture=f.calls.find(c=>c.path==='/api/capture');assert.equal(capture.body.kind,'document');assert.equal(capture.body.speaker,'unknown');assert.equal(capture.body.text,'他者の文書');
});
test('partially recognized speech is not automatically persisted on pause even with draft persistence enabled',async()=>{
 const f=fixture({voice:true});await tick();f.run("record.settings.draftPersistence=true;active=true;receiveTranscript({turn:1,text:'認識途中',final:false},revision)");await f.run('finish()');
 assert.equal(f.calls.some(c=>c.path==='/api/draft'),false);assert.equal(f.get('message').value,'認識途中');assert.equal(f.get('pauseDraftOffer').hidden,false);
 await f.run('savePausedDraft()');assert.equal(f.calls.find(c=>c.path==='/api/draft').body.text,'認識途中');assert.equal(f.run('record.inquiry.paused'),true);
});
test('explicitly saving a paused draft enables encrypted draft persistence before writing',async()=>{
 const f=fixture();await tick();f.get('message').value='保存を選ぶ文';await f.run('finish()');await f.run('savePausedDraft()');
 const settings=f.calls.findIndex(c=>c.path==='/api/settings'),draft=f.calls.findIndex(c=>c.path==='/api/draft');assert.ok(settings>=0&&settings<draft);assert.equal(f.calls[settings].body.draftPersistence,true);assert.equal(f.get('pauseDraftOffer').hidden,true);assert.equal(f.get('message').value,'保存を選ぶ文');
});
test('an unlocked reload restores an opted-in encrypted draft without submitting it',async()=>{
 const loaded={revision:1,question:'保存した問い',topic:'start',messages:[],proposals:[],knowledge:[],inquiry:{paused:true,refusedTopics:[]},consent:{model:false},settings:{draftPersistence:true}};
 const f=fixture({handle(path){if(path==='/api/record')return {ok:true,json:async()=>loaded};if(path==='/api/draft')return {ok:true,json:async()=>({text:'保存した下書き'})}}});await tick();
 assert.equal(f.get('message').value,'保存した下書き');assert.equal(f.get('pauseDraftOffer').hidden,true);assert.equal(f.calls.some(c=>c.path==='/api/capture'),false);
});
test('form labels explicitly target their controls and select names exclude their option lists',()=>{
 const labels=[...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)];
 for(const [,attrs,inner] of labels){const id=inner.match(/<(?:input|textarea|select)\b[^>]*\bid="([^"]+)"/)?.[1];if(id)assert.match(attrs,new RegExp(`\\bfor="${id}"`),`label for ${id}`)}
 for(const [id,name] of [['packPurpose','何に使う？'],['packAudience','誰のために？'],['packDestination','どこで使う？'],['editKind','種類'],['topic','いま話したいこと']]){
  const select=html.match(new RegExp(`<select\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];assert.ok(select);
  const target=select.match(/aria-labelledby="([^"]+)"/)?.[1];assert.ok(target);assert.ok(html.includes(`<span id="${target}">${name}</span>`));
 }
});
test('knowledge deletion confirmation clearly distinguishes the retained original statement',async()=>{
 const f=fixture();await tick();f.run("record.knowledge=[{id:'k1',revision:1,text:'整理したメモ',evidence:[],policy:{},status:'active'}];drawKnowledge()");
 const card=f.get('knowledgeBody').children[0],row=card.children.at(-1),button=row.children.find(child=>child.textContent==='削除');button.onclick();
 assert.match(f.get('confirmText').textContent,/元の発言は残る/);assert.match(f.get('confirmText').textContent,/「話したこと」から削除/);
});
test('editing ambiguous time preserves its original label and precision without inventing dates',async()=>{
 const f=fixture();await tick();f.run("openEditor('knowledge',{id:'k1',revision:3,text:'夏に始めたこと',kind:'fact',validTime:{start:null,end:null,precision:'season',label:'2025年の夏'}})");await f.run('saveEditor({preventDefault(){}})');
 assert.deepEqual(f.calls.find(c=>c.path==='/api/knowledge/save').body.validTime,{start:null,end:null,precision:'season',label:'2025年の夏'});
});
test('editing unrelated knowledge text preserves exact original time seconds',async()=>{
 const f=fixture();await tick();f.run("openEditor('knowledge',{id:'k1',revision:3,text:'期間のあるメモ',kind:'fact',validTime:{start:'2025-06-01T12:34:56.123Z',end:null,precision:'exact',label:'記録した時刻'}})");f.get('editText').value='本文だけ直す';await f.run('saveEditor({preventDefault(){}})');
 assert.equal(f.calls.find(c=>c.path==='/api/knowledge/save').body.validTime.start,'2025-06-01T12:34:56.123Z');
});
test('interrupted speech offers editing and clearing without sending its partial words',async()=>{
 const f=fixture({voice:true});await tick();f.run("active=true;receiveTranscript({turn:1,text:'未確定の文',final:false},revision)");await f.run('pauseConversation()');
 assert.match(f.get('draftHintText').textContent,/途中の文字起こし/);assert.match(f.get('draftHintText').textContent,/改行/);
 await f.run('clearDraft()');assert.equal(f.get('message').value,'');assert.equal(f.get('caption').textContent,'');assert.equal(f.get('draftHint').hidden,true);assert.equal(f.calls.some(c=>c.path==='/api/capture'||c.path==='/api/interview'),false);
});
test('manual conflict choices are preserved and can be extended without selecting the edited note itself',async()=>{
 const f=fixture();await tick();f.run("record.knowledge=[{id:'k1',revision:2,text:'編集中',kind:'fact',status:'active',conflictsWith:['k2']},{id:'k2',revision:1,text:'既存の確認相手',status:'active'},{id:'k3',revision:1,text:'新しい確認相手',status:'task_local'},{id:'k4',revision:1,text:'利用停止済み',status:'withdrawn'}];openEditor('knowledge',record.knowledge[0])");
 const inputs=f.get('conflictChoices').children.map(row=>row.children[0]);assert.deepEqual(inputs.map(input=>input.value),['k2','k3']);assert.equal(inputs[0].checked,true);inputs[1].checked=true;await f.run('saveEditor({preventDefault(){}})');
 assert.deepEqual(f.calls.find(c=>c.path==='/api/knowledge/save').body.conflictsWith,['k2','k3']);
});
test('backup import accepts valid export sizes above 25 MiB and rejects files over 64 MiB before reading',async()=>{
 const f=fixture();await tick();f.get('backupFile').files=[{size:43*1024*1024,text:async()=>'synthetic encrypted backup'}];f.get('backupPassphrase').value='synthetic-passphrase';await f.run('backupImport()');assert.equal(f.calls.filter(c=>c.path==='/api/backup/import').length,1);
 let read=false;f.get('backupFile').files=[{size:64*1024*1024+1,text:async()=>{read=true;return 'oversize'}}];await f.run('backupImport()');assert.equal(read,false);assert.equal(f.calls.filter(c=>c.path==='/api/backup/import').length,1);assert.match(f.get('backupError').textContent,/64/);
});
test('main screen explains local mode and offers dialogue consent without silently enabling it',async()=>{const f=fixture({connected:true});await tick();assert.equal(f.get('consentHint').hidden,false);assert.match(f.get('consentHint').children[0].textContent,/自動の質問はオフ/);const button=f.get('consentHint').children.find(x=>x.tagName==='BUTTON');assert.equal(button.textContent,'対話をオンにする');button.onclick();assert.equal(f.get('consentDialog').open,true);assert.equal(f.calls.some(c=>c.path==='/api/consent'||c.path==='/api/interview'),false);});
test('unavailable provider explains manual question navigation instead of offering unusable connection',async()=>{const f=fixture({handle:async path=>path==='/api/status'?{ok:true,json:async()=>({vault:{exists:true,unlocked:true},provider:{available:false,connected:false},capabilities:{voice:false},csrf:'test'})}:undefined});await tick();assert.match(f.get('consentHint').children[0].textContent,/別の問いへ/);assert.equal(f.get('consentHint').children.some(x=>x.tagName==='BUTTON'),false);});
