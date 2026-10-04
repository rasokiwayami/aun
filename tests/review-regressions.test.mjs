import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Vault} from '../src/core/vault.mjs';
import {LIMITS} from '../src/core/schema.mjs';
import {encryptBackup} from '../src/core/crypto.mjs';
import {InterviewService} from '../src/server/interview.mjs';
import {createApp} from '../src/server/app.mjs';

const password='synthetic-review-password';
const root=path.resolve(import.meta.dirname,'..');
async function vaultFixture(t){const dir=await mkdtemp(path.join(tmpdir(),'hz-review-vault-'));const v=new Vault(dir);await v.create(password);t.after(async()=>{v.close();await rm(dir,{recursive:true,force:true})});return v}
const capture=(v,operationId,text)=>v.capture({operationId,text,kind:'text',speaker:'self',purpose:'self_reflection',topic:'free'});
const answer=reply=>({text:JSON.stringify({reply,question:'',questionId:null,pause:true,move:'pause',coverage:[],proposals:[]})});
const fakeProvider=(reply='Synthetic reply')=>({status:async()=>({connected:true,sharing:true,connectionId:'A'}),respond:async()=>answer(reply)});
const talk=(service,source,operationId='talk')=>service.talk({operationId,sourceId:source.sourceId,sourceRevision:1,purpose:'self_reflection',topic:'free'});

async function appFixture(t,options={}){
 const dir=await mkdtemp(path.join(tmpdir(),'hz-review-http-'));
 const app=createApp({root,dataDir:dir,provider:{status:async()=>({available:false,connected:false,sharing:false})},...options});
 await app.listen(0);t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true})});
 const get=(b,url)=>fetch(app.origin+url,{headers:{cookie:b.cookie}});
 const post=(b,url,data)=>fetch(app.origin+url,{method:'POST',headers:{cookie:b.cookie,origin:app.origin,'x-csrf-token':b.csrf,'content-type':'application/json'},body:JSON.stringify(data)});
 const browser=async()=>{const r=await fetch(app.origin+'/');const b={cookie:r.headers.get('set-cookie').split(';')[0]};const status=await(await get(b,'/api/status')).json();return {...b,csrf:status.csrf}};
 return {app,get,post,browser};
}

test('an expired session cannot finish a previously started request while another session keeps the vault open',async t=>{
 const realNow=Date.now;let clock=realNow();Date.now=()=>clock;t.after(()=>{Date.now=realNow});
 const {app,get,post,browser}=await appFixture(t,{sessionTtlMs:1000});
 const a=await browser();assert.equal((await post(a,'/api/vault/create',{passphrase:password})).status,200);
 const b=await browser();assert.equal((await post(b,'/api/vault/unlock',{passphrase:password})).status,200);
 const data=JSON.stringify({operationId:'expired-session',text:'SYNTHETIC_EXPIRED_SESSION_WRITE',kind:'text',purpose:'self_reflection'});
 let req;const response=new Promise((resolve,reject)=>{req=http.request(app.origin+'/api/capture',{method:'POST',headers:{cookie:a.cookie,origin:app.origin,'x-csrf-token':a.csrf,'content-type':'application/json','content-length':Buffer.byteLength(data)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);req.write(data.slice(0,1))});
 await new Promise(resolve=>setTimeout(resolve,30));clock+=800;await get(b,'/api/record');clock+=400;await get(b,'/api/record');req.end(data.slice(1));
 assert.equal(await response,401);
 assert.equal(app.vault.view().messages.some(m=>m.text==='SYNTHETIC_EXPIRED_SESSION_WRITE'),false);
});

test('restoring a backup invalidates every earlier unlocked lease except the restoring browser',async t=>{
 const {get,post,browser}=await appFixture(t);const a=await browser();await post(a,'/api/vault/create',{passphrase:password});const b=await browser();await post(b,'/api/vault/unlock',{passphrase:password});
 const backup=await(await post(a,'/api/backup/export',{passphrase:password})).json();
 assert.equal((await post(a,'/api/backup/import',{content:backup.content,passphrase:password})).status,200);
 assert.equal((await get(b,'/api/record')).status,401);
 assert.equal((await get(a,'/api/record')).status,200);
});

test('a restore waiting on decryption cannot commit after its lease expires while another browser remains active',async t=>{
 const realNow=Date.now;let clock=realNow();Date.now=()=>clock;t.after(()=>{Date.now=realNow});
 const {app,get,post,browser}=await appFixture(t,{sessionTtlMs:1000});const a=await browser();await post(a,'/api/vault/create',{passphrase:password});const b=await browser();await post(b,'/api/vault/unlock',{passphrase:password});
 const backup=await(await post(a,'/api/backup/export',{passphrase:password})).json();const restore=app.vault.restore.bind(app.vault);
 let release,started;const ready=new Promise(resolve=>{started=resolve});const gate=new Promise(resolve=>{release=resolve});
 app.vault.restore=async(...args)=>{started();await gate;return restore(...args)};
 const pending=post(a,'/api/backup/import',{content:backup.content,passphrase:password});await ready;
 clock+=800;await get(b,'/api/record');clock+=400;const revision=(await(await get(b,'/api/record')).json()).revision;release();
 assert.equal((await pending).status,401);
 assert.equal(app.vault.read().revision,revision);
});

for(const change of ['delete','correct','withdraw'])test(`${change} of adopted knowledge invalidates dependent assistant messages and cached job answers`,async t=>{
 const v=await vaultFixture(t);v.setConsent(true,'A');const marker='SYNTHETIC_ASSERTION_DERIVATIVE';
 const k=v.saveKnowledge({operationId:'knowledge',text:marker,kind:'fact',policy:{model:true}});const source=capture(v,'selected','Current selected input.');
 await talk(new InterviewService(v,fakeProvider(marker)),source);
 if(change==='delete')v.deleteKnowledge({operationId:'delete',id:k.id,expectedRevision:1});
 if(change==='correct')v.saveKnowledge({operationId:'correct',id:k.id,expectedRevision:1,text:'Corrected independent statement.',kind:'fact',policy:{model:true}});
 if(change==='withdraw')v.withdraw({operationId:'withdraw',id:k.id,expectedRevision:1});
 const state=v.read();assert.equal(state.conversation.messages.some(m=>m.text.includes(marker)),false);
 assert.equal(JSON.stringify(state.jobs).includes(marker),false);
 assert.equal(JSON.stringify(state.operations).includes(marker),false);
 assert(state.sources[source.sourceId],'Unrelated committed raw input remains.');
});

test('revoking model use for a source also excludes its adopted interpretation on later sends',async t=>{
 const v=await vaultFixture(t);v.setConsent(true,'A');const marker='SYNTHETIC_REVOKED_SOURCE';const k=v.saveKnowledge({operationId:'knowledge',text:marker,kind:'fact',policy:{model:true}});const sid=v.read().assertions[k.id].evidence[0].sourceId;
 v.sourcePermission({operationId:'revoke',id:sid,expectedRevision:1,model:false});const source=capture(v,'selected','Selected current input.');let sent;
 const provider=fakeProvider();provider.respond=async input=>{sent=JSON.stringify(input.input);return answer('Synthetic reply')};await talk(new InterviewService(v,provider),source);
 assert.equal(sent.includes(marker),false);
});

test('malformed authenticated backup is rejected before a persistent record is changed',async t=>{
 const donor=await vaultFixture(t),target=await vaultFixture(t);capture(donor,'donor','Synthetic donor input.');capture(target,'target','Existing valid input.');const incoming=donor.read();Object.values(incoming.sources)[0].receivedAt=null;const before=target.read();
 await assert.rejects(target.restore(await encryptBackup(incoming,password),password,{acknowledgeUnknownHistory:true}),{code:'backup_invalid'});
 assert.deepEqual(target.read(),before);assert.doesNotThrow(()=>target.view());
});

test('operation capacity permits deletion without evicting acknowledged operations or allowing a forged operation type',async t=>{
 const v=await vaultFixture(t);const first=capture(v,'acknowledged-first','First synthetic source.');const second=capture(v,'delete-me','Second synthetic source.');
 v.mutate('fill-test-prerequisite',{type:'test_prerequisite'},s=>{for(let i=Object.keys(s.operations).length;i<LIMITS.operations-1;i++)s.operations['synthetic-'+i]={type:'synthetic',hash:'x',result:{},refs:[]}});
 const retry=capture(v,'acknowledged-first','First synthetic source.');assert.equal(retry.sourceId,first.sourceId);
 assert.throws(()=>v.capture({operationId:'forged-type',text:'Must not be saved.',kind:'text',type:'source_delete'}),{code:'operation_limit'});
 v.deleteSource({operationId:'allowed-delete',id:second.sourceId,expectedRevision:1});assert(!v.read().sources[second.sourceId]);assert(v.read().operations['acknowledged-first']);
 assert.equal(capture(v,'acknowledged-first','First synthetic source.').sourceId,first.sourceId);
 assert.equal(Object.keys(v.read().operations).length,LIMITS.operations);
});

test('operation capacity still allows a saved failed interview to retry and a context pack to export',async t=>{
 const v=await vaultFixture(t);v.setConsent(true,'A');const source=capture(v,'saved-source','Synthetic source retained after failure.');const provider=fakeProvider();provider.respond=async()=>{throw new Error('synthetic provider failure')};const service=new InterviewService(v,provider);
 await assert.rejects(talk(service,source,'retry-interview'),/synthetic provider failure/);
 v.mutate('fill-test-prerequisite',{type:'test_prerequisite'},s=>{for(let i=Object.keys(s.operations).length;i<LIMITS.operations-1;i++)s.operations['synthetic-'+i]={type:'synthetic',hash:'x',result:{},refs:[]}});
 provider.respond=async()=>answer('Recovered synthetic reply');await talk(service,source,'retry-interview');assert.equal(v.read().jobs['retry-interview'].status,'complete');
 const pack=v.previewPack({operationId:'capacity-preview',purpose:'self_reflection',query:'',audience:'self',destination:'file',context:{}});
 assert.equal(typeof v.exportPack({id:pack.id,expectedRevision:pack.revision,format:'markdown'}).content,'string');
 service.navigate({operationId:'capacity-pause',action:'pause'});assert.equal(v.read().inquiry.paused,true);
});

test('manual knowledge correction preserves the historical content under its actual old revision',async t=>{
 const v=await vaultFixture(t);const k=v.saveKnowledge({operationId:'original',text:'Original synthetic statement.',kind:'fact'});
 v.saveKnowledge({operationId:'corrected',id:k.id,expectedRevision:1,text:'Corrected synthetic statement.',kind:'fact'});
 const a=v.read().assertions[k.id];assert.equal(a.revision,2);assert.equal(a.history[0].revision,1);assert.equal(a.history[0].text,'Original synthetic statement.');assert.equal(a.history[0].status,'active');
});

test('an expired voice owner is stopped even when another browser stays unlocked', {skip:process.platform!=='darwin'},async t=>{
 const realNow=Date.now;let clock=realNow();Date.now=()=>clock;t.after(()=>{Date.now=realNow});
 const mockRoot=await mkdtemp(path.join(tmpdir(),'hz-fake-voice-'));t.after(()=>rm(mockRoot,{recursive:true,force:true}));
 await mkdir(path.join(mockRoot,'src'));await writeFile(path.join(mockRoot,'src/ui.html'),'<html></html>');
 const executable=path.join(mockRoot,'bin/VoiceBridge.app/Contents/MacOS/VoiceBridge');await mkdir(path.dirname(executable),{recursive:true});
 await writeFile(executable,`#!${process.execPath}\nprocess.stdout.write('{"type":"ready"}\\n');setInterval(()=>{},1000);process.on('SIGTERM',()=>process.exit());\n`,{mode:0o700});
 const {app,get,post,browser}=await appFixture(t,{root:mockRoot,sessionTtlMs:1000});const a=await browser();await post(a,'/api/vault/create',{passphrase:password});const b=await browser();await post(b,'/api/vault/unlock',{passphrase:password});
 const stream=await post(a,'/api/voice',{});assert.equal(stream.status,200);const reader=stream.body.getReader();assert((new TextDecoder()).decode((await reader.read()).value).includes('ready'));
 assert.equal((await post(b,'/api/stop-audio',{})).status,403);
 const finished=reader.read().then(x=>x.done);clock+=800;await get(b,'/api/record');clock+=400;await get(b,'/api/record');
 const closed=await Promise.race([finished,new Promise(resolve=>setTimeout(()=>resolve(false),500))]);assert.equal(closed,true);
 assert.equal((await get(b,'/api/record')).status,200);assert.equal(app.vault.unlocked,true);
});

test('pack preview excludes sources past retention even before the scheduled purge',async t=>{
 const v=await vaultFixture(t);const k=v.saveKnowledge({operationId:'knowledge',text:'Expired synthetic source.',kind:'fact'});const sid=v.read().assertions[k.id].evidence[0].sourceId;
 v.mutate('expire-test-prerequisite',{type:'test_prerequisite'},s=>{s.sources[sid].retentionAt='2000-01-01T00:00:00Z'});
 const pack=v.previewPack({operationId:'preview',purpose:'self_reflection',query:'',audience:'self',destination:'file',context:{}});
 assert.equal(pack.items.length,0);
});

test('pack export rechecks source retention after preview without relying on a timer or epoch change',async t=>{
 const v=await vaultFixture(t);const k=v.saveKnowledge({operationId:'knowledge',text:'Short-lived synthetic source.',kind:'fact'});const sid=v.read().assertions[k.id].evidence[0].sourceId;const now=Date.now();
 v.mutate('retention-test-prerequisite',{type:'test_prerequisite'},s=>{s.sources[sid].retentionAt=new Date(now+1000).toISOString()});
 const pack=v.previewPack({operationId:'preview',purpose:'self_reflection',query:'',audience:'self',destination:'file',context:{}});assert.equal(pack.items.length,1);
 const originalNow=Date.now;Date.now=()=>now+2000;try{assert.throws(()=>v.exportPack({id:pack.id,expectedRevision:pack.revision,format:'markdown'}),{code:'pack_stale'})}finally{Date.now=originalNow}
});

test('Markdown export preserves condition, time meaning and mandatory constraints from the selected knowledge',async t=>{
 const v=await vaultFixture(t);const start=new Date(Date.now()-86400000).toISOString(),end=new Date(Date.now()+86400000).toISOString();
 v.saveKnowledge({operationId:'knowledge',text:'丁寧に断る。',kind:'policy',scope:{purposes:['draft_reply'],conditions:[{field:'relationship',op:'eq',value:'研究仲間'}]},validTime:{start,end,precision:'day',label:'今週の対応'},hardConstraint:true});
 const pack=v.previewPack({operationId:'preview',purpose:'draft_reply',query:'',audience:'self',destination:'file',context:{relationship:'研究仲間'}});const content=v.exportPack({id:pack.id,expectedRevision:pack.revision,format:'markdown'}).content;
 for(const required of ['返信の下書き','研究仲間',start,end,'今週の対応','必ず守る条件','例外'])assert(content.includes(required),`Missing semantic information: ${required}`);
 assert(!content.includes(v.read().id));
});

test('a full raw-source collection still allows manual correction and conversion of an interpretation to user-authored knowledge',async t=>{
 const v=await vaultFixture(t);const manual=v.saveKnowledge({operationId:'manual',text:'Original manual knowledge.',kind:'fact'});const manualSource=v.read().assertions[manual.id].evidence[0].sourceId;
 const raw=capture(v,'raw','Synthetic original source.');const s=v.read();const [proposal]=v.addProposals({operationId:'propose',sourceId:raw.sourceId,sourceRevision:1,dataEpoch:s.dataEpoch,policyEpoch:s.policyEpoch,proposals:[{text:'Synthetic original source.',kind:'fact',evidence:[{sourceId:raw.sourceId,revision:1,start:0,end:26,quote:'Synthetic original source.'}]}]});
 v.review({operationId:'review',id:proposal.id,expectedRevision:1,decision:'accept'});
 v.mutate('fill-sources-test-prerequisite',{type:'test_prerequisite'},state=>{const template=structuredClone(state.sources[raw.sourceId]);for(let i=1;i<LIMITS.sources;i++){const id='synthetic_source_'+i;state.sources[id]={...structuredClone(template),id}}});
 assert.throws(()=>capture(v,'new-over-capacity','New synthetic source.'),{code:'source_limit'});
 v.saveKnowledge({operationId:'edit-manual',id:manual.id,expectedRevision:1,text:'Corrected manual knowledge.',kind:'fact'});
 const corrected=v.read().assertions[manual.id];assert.equal(corrected.evidence[0].sourceId,manualSource);assert.equal(corrected.evidence[0].revision,2);assert.equal(v.read().sources[manualSource].revisions[0].text,'Original manual knowledge.');
 v.saveKnowledge({operationId:'edit-interpretation',id:proposal.id,expectedRevision:2,text:'New user-authored statement.',kind:'fact'});
 const authored=v.read().assertions[proposal.id];assert.notEqual(authored.evidence[0].sourceId,raw.sourceId);assert.equal(v.read().sources[raw.sourceId].text,'Synthetic original source.');
});

test('an applicable private conflict blocks public export and model egress without exposing its contents',async t=>{
 const v=await vaultFixture(t);v.setConsent(true,'A');const publicItem=v.saveKnowledge({operationId:'public',text:'Public synthetic statement.',kind:'fact',policy:{model:true,disclosure:true}});
 v.saveKnowledge({operationId:'private',text:'SYNTHETIC_PRIVATE_CONFLICT',kind:'fact',policy:{model:false,disclosure:false},conflictsWith:[publicItem.id]});
 assert.throws(()=>v.previewPack({operationId:'preview',purpose:'self_reflection',query:'',audience:'external',destination:'file',context:{}}),e=>e.code==='conflict_requires_resolution'&&!e.message.includes('SYNTHETIC_PRIVATE_CONFLICT'));
 const source=capture(v,'selected','Current selected source.');let calls=0;const provider=fakeProvider();provider.respond=async()=>{calls++;return answer('Synthetic reply')};
 await assert.rejects(talk(new InterviewService(v,provider),source),{code:'conflict_requires_resolution'});assert.equal(calls,0);
});

test('refusing a generic opening question pauses without inventing a refused goal or asking another question',async t=>{
 const v=await vaultFixture(t),service=new InterviewService(v,fakeProvider());const before=v.view();service.navigate({operationId:'refuse-opening',action:'refuse'});const after=v.view();
 assert.equal(after.inquiry.paused,true);assert.equal(after.question,before.question);assert.equal(after.questionId,null);assert.deepEqual(after.inquiry.refusedTopics,[]);
});
