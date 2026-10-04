import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {Vault} from '../core/vault.mjs';
import {LIMITS} from '../core/schema.mjs';
import {requireThat,AppError} from '../core/errors.mjs';
import {topicChoices} from '../interview/questions.mjs';
import {InterviewService} from './interview.mjs';
import {ChatGPTProvider} from './provider.mjs';
import {LegacyImporter} from './legacy.mjs';
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
const cookieName='hitotsuzutsu_session';
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)};
const errorMessages={conflict_requires_resolution:'両立を確認したいメモがあります。内容を直すか、一方の利用をやめてから再度お試しください。',vault_locked:'保管庫を開いてください。',unlock_failed:'合言葉を確認してください。',recovery_failed:'復旧コードと新しい合言葉を確認してください。',model_consent_required:'ChatGPTに送る内容の許可を確認してください。',model_reconsent_required:'接続先が変わりました。送信の許可を確認してください。',sign_in_required:'ChatGPTへの接続を確認してください。回答は保存されています。',cancelled:'返答を止めました。保存済みの回答は残っています。',busy:'前の処理が終わるまでお待ちください。',revision_conflict:'内容が更新されています。開き直して確認してください。',pack_stale:'情報が変わりました。出力内容を作り直してください。',restore_history_unknown:'別の保管庫のバックアップです。過去の削除を照合できないため、確認が必要です。',rate_limit:'しばらく待ってから、もう一度お試しください。',invalid_reply:'返答を整理できませんでした。回答は保存されています。',provider_unavailable:'この環境ではChatGPT接続を使えません。保存と編集は利用できます。'};
function reply(res,status,data){if(res.destroyed||res.writableEnded)return;res.writeHead(status,{...headers,'Content-Type':'application/json;charset=utf-8'});res.end(JSON.stringify(data))}
async function body(req,max=256*1024){requireThat(req.headers['content-type']?.split(';')[0]==='application/json','invalid_content_type',415);const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;requireThat(size<=max,'body_limit',413);chunks.push(chunk)}let b;try{b=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')}catch{throw new AppError('invalid_json',400)}requireThat(b&&typeof b==='object'&&!Array.isArray(b),'invalid_input',422);return b;}
export function createApp({root,dataDir,provider=new ChatGPTProvider(root,dataDir),sessionTtlMs=30*60*1000}={}){
 const vault=new Vault(path.join(dataDir,'vault')),interview=new InterviewService(vault,provider),legacy=new LegacyImporter(path.join(dataDir,'conversations'),vault),sessions=new Map();
 let origin,voiceChild=null,speechChild=null,voiceOwner=null,speechOwner=null,cryptoBusy=false,lockEpoch=0;const attempts=[];
 const voicePath=path.join(root,'bin/VoiceBridge.app/Contents/MacOS/VoiceBridge');const voiceAvailable=process.platform==='darwin'&&existsSync(voicePath);
 const stopAudio=owner=>{if(!owner||voiceOwner===owner){voiceChild?.kill();voiceChild=null;voiceOwner=null}if(!owner||speechOwner===owner){speechChild?.kill();speechChild=null;speechOwner=null}};
 const cancel=owner=>{interview.cancelAll();stopAudio(owner)};
 const invalidateLease=s=>{s.unlocked=false;s.generation++;for(const controller of s.controllers)controller.abort();s.controllers.clear();stopAudio(s)};
 const lock=()=>{lockEpoch++;cancel();vault.lock();for(const s of sessions.values())invalidateLease(s)};
 const renewAfterRestore=browser=>{lockEpoch++;cancel();for(const s of sessions.values())invalidateLease(s);browser.unlocked=true;browser.seen=Date.now()};
 function sweep(){const now=Date.now();for(const [k,s] of sessions)if(now-s.seen>sessionTtlMs){invalidateLease(s);sessions.delete(k)}if(vault.unlocked&&![...sessions.values()].some(s=>s.unlocked))lock();}
 const timer=setInterval(()=>{sweep();if(vault.unlocked){try{const s=vault.read();if(s.draft&&Date.parse(s.draft.expiresAt)<=Date.now()||Object.values(s.sources).some(x=>x.retentionAt&&Date.parse(x.retentionAt)<=Date.now())){cancel();vault.expire()}}catch{lock()}}},10000);timer.unref();
 function session(req){const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);return token?sessions.get(token):null}
 function issue(res){requireThat(sessions.size<100,'session_limit',429);const token=randomBytes(32).toString('hex'),s={csrf:randomBytes(32).toString('hex'),unlocked:false,seen:Date.now(),generation:0,controllers:new Set()};sessions.set(token,s);res.setHeader('Set-Cookie',`${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);return s}
 function needSession(s,generation){requireThat(s&&s.generation===generation&&Date.now()-s.seen<=sessionTtlMs&&[...sessions.values()].includes(s),'browser_session_required',401)}
 function ensureVault(s,generation){needSession(s,generation);requireThat(s.unlocked&&vault.unlocked,'vault_locked',401)}
 function needVault(s,generation){ensureVault(s,generation);s.seen=Date.now()}
 async function exclusive(fn){requireThat(!cryptoBusy,'busy',409);cryptoBusy=true;try{return await fn()}finally{cryptoBusy=false}}
 function rate(){const now=Date.now();while(attempts.length&&attempts[0]<now-60000)attempts.shift();requireThat(attempts.length<8,'rate_limit',429);attempts.push(now)}
 function record(result={}){interview.ensureOpening();return {...result,record:vault.view()}}
 const server=http.createServer(async(req,res)=>{
  try{
   requireThat(req.headers.host===new URL(origin).host,'invalid_host',403);sweep();const url=new URL(req.url,origin);let browser=session(req);
   if(req.method==='GET'&&url.pathname==='/'){browser||=issue(res);res.writeHead(200,{...headers,'Content-Type':'text/html;charset=utf-8'});res.end(await readFile(path.join(root,'src/ui.html')));return}
   if(req.method==='GET'&&url.pathname==='/client.js'){res.writeHead(200,{...headers,'Content-Type':'text/javascript;charset=utf-8'});res.end(await readFile(path.join(root,'src/client.js')));return}
   requireThat(url.pathname.startsWith('/api/'),'not_found',404);requireThat(browser,'browser_session_required',401);
   const generation=browser.generation;
   requireThat(!req.headers.origin||req.headers.origin===origin,'origin_rejected',403);
   if(req.method==='POST')requireThat(req.headers.origin===origin&&equal(req.headers['x-csrf-token'],browser.csrf),'origin_rejected',403);
   else requireThat(req.method==='GET','method_not_allowed',405);
   if(req.method==='GET'&&url.pathname==='/api/status'){
    const {connectionId,...status}=await provider.status();
    needSession(browser,generation);
    if(browser.unlocked&&vault.unlocked){const state=vault.read();if(state.consent.model&&state.consent.connectionId!==connectionId){cancel();vault.setConsent(false)}}
    reply(res,200,{csrf:browser.csrf,vault:{exists:vault.exists,unlocked:browser.unlocked&&vault.unlocked},provider:status,capabilities:{voice:voiceAvailable},topicChoices,limits:LIMITS});return;
   }
   const b=req.method==='POST'?await body(req,url.pathname==='/api/backup/import'?64*1024*1024:256*1024):null;
   needSession(browser,generation);
   if(['/api/vault/create','/api/vault/unlock','/api/vault/recover'].includes(url.pathname)&&b){rate();const epoch=lockEpoch;await exclusive(async()=>{if(url.pathname.endsWith('/create')){const result=await vault.create(b.passphrase,{recovery:b.recovery===true});if(epoch!==lockEpoch){vault.lock();throw new AppError('cancelled',409)}needSession(browser,generation);browser.unlocked=true;browser.seen=Date.now();reply(res,200,record(result))}else{if(url.pathname.endsWith('/recover'))await vault.recover(b.recoveryCode,b.newPassphrase);else await vault.unlock(b.passphrase);if(epoch!==lockEpoch){vault.lock();throw new AppError('cancelled',409)}needSession(browser,generation);browser.unlocked=true;browser.seen=Date.now();vault.expire();if(url.pathname.endsWith('/recover'))renewAfterRestore(browser);reply(res,200,record())}});return}
   if(url.pathname==='/api/vault/lock'&&b){lock();reply(res,200,{locked:true});return}
   // Provider setup is independent of the vault, but disconnect also revokes local access.
   if(url.pathname==='/api/auth/pending'&&!b){reply(res,200,await provider.pending());return}
   if(url.pathname==='/api/auth/start'&&b){reply(res,202,await provider.start());return}
   if(url.pathname==='/api/auth/cancel'&&b){reply(res,200,await provider.cancel());return}
   if(url.pathname==='/api/auth/disconnect'&&b){cancel();if(vault.unlocked)vault.setConsent(false);lock();reply(res,200,await provider.disconnect());return}
   needVault(browser,generation);
   if(url.pathname==='/api/record'&&!b){reply(res,200,record().record);return}
   if(url.pathname==='/api/models'&&!b){const models=await provider.models();ensureVault(browser,generation);reply(res,200,models);return}
   if(url.pathname==='/api/legacy'&&!b){const files=await legacy.list();ensureVault(browser,generation);reply(res,200,{files});return}
   if(url.pathname==='/api/draft'&&!b){const d=vault.read().draft;reply(res,200,{text:d&&Date.parse(d.expiresAt)>Date.now()?d.text:''});return}
   requireThat(b,'not_found',404);
   if(url.pathname==='/api/capture'){cancel(browser);reply(res,200,record(vault.capture(b)));return}
   if(url.pathname==='/api/interview'){const ctrl=new AbortController();browser.controllers.add(ctrl);const timeout=setTimeout(()=>ctrl.abort(),120000);res.on('close',()=>{if(!res.writableEnded)ctrl.abort()});try{const result=await interview.talk(b,{signal:ctrl.signal,authorize:()=>ensureVault(browser,generation)});ensureVault(browser,generation);reply(res,200,result)}finally{clearTimeout(timeout);browser.controllers.delete(ctrl)}return}
   if(url.pathname==='/api/navigate'){cancel(browser);reply(res,200,record(interview.navigate(b)));return}
   const mutations={'/api/source/edit':'editSource','/api/source/delete':'deleteSource','/api/source/permission':'sourcePermission','/api/knowledge/save':'saveKnowledge','/api/knowledge/delete':'deleteKnowledge','/api/knowledge/withdraw':'withdraw','/api/review':'review','/api/settings':'updateSettings'};
   if(Object.hasOwn(mutations,url.pathname)){cancel(browser);reply(res,200,record(vault[mutations[url.pathname]](b)));return}
   if(url.pathname==='/api/consent'){cancel();const status=b.enabled?await provider.status():null;ensureVault(browser,generation);if(b.enabled)requireThat(status.connected&&status.sharing&&status.connectionId,'sign_in_required',401);vault.setConsent(b.enabled,status?.connectionId);reply(res,200,record());return}
   if(url.pathname==='/api/pack/preview'){reply(res,200,record({pack:vault.previewPack(b)}));return}
   if(url.pathname==='/api/pack/export'){reply(res,200,record(vault.exportPack(b)));return}
   if(url.pathname==='/api/draft'){vault.saveDraft(b.text,b.clear===true);reply(res,200,{saved:b.clear!==true});return}
   if(url.pathname==='/api/backup/export'){await exclusive(async()=>{const epoch=lockEpoch,content=await vault.backup(b.passphrase);ensureVault(browser,generation);requireThat(lockEpoch===epoch,'cancelled',409);reply(res,200,{filename:'hitotsuzutsu-backup.json',content,mime:'application/json'})});return}
   if(url.pathname==='/api/backup/import'){cancel();const epoch=lockEpoch;await exclusive(async()=>{const report=await vault.restore(b.content,b.passphrase,{acknowledgeUnknownHistory:b.acknowledgeUnknownHistory===true,beforeCommit:()=>{ensureVault(browser,generation);requireThat(lockEpoch===epoch,'cancelled',409)}});renewAfterRestore(browser);reply(res,200,record({report}))});return}
   if(url.pathname==='/api/legacy/import'){cancel();const report=await legacy.import(b.id,{beforeCommit:()=>ensureVault(browser,generation)});ensureVault(browser,generation);reply(res,200,record({report}));return}
   if(url.pathname==='/api/stop-audio'){requireThat((!voiceChild||voiceOwner===browser)&&(!speechChild||speechOwner===browser),'audio_owner_required',403);stopAudio(browser);reply(res,200,{stopped:true});return}
   if(url.pathname==='/api/voice'){
    requireThat(voiceAvailable,'voice_unavailable',503);requireThat(!voiceChild,'microphone_in_use',409);
    const child=spawn(voicePath,[],{stdio:['ignore','pipe','pipe']});voiceChild=child;voiceOwner=browser;res.writeHead(200,{...headers,'Content-Type':'application/x-ndjson'});child.stdout.on('data',d=>{try{ensureVault(browser,generation);if(!res.destroyed)res.write(d)}catch{child.kill();if(!res.destroyed)res.end()}});child.stderr.resume();child.on('error',()=>{if(!res.destroyed){res.write(JSON.stringify({type:'error',code:'voice_unavailable'})+'\n');res.end()}});child.on('exit',()=>{if(voiceChild===child){voiceChild=null;voiceOwner=null}if(!res.destroyed)res.end()});res.on('close',()=>{child.kill();if(voiceChild===child){voiceChild=null;voiceOwner=null}});return;
   }
   if(url.pathname==='/api/speak'){
    requireThat(process.platform==='darwin','speech_unavailable',503);requireThat(!speechChild||speechOwner===browser,'audio_owner_required',403);const entry=vault.view().messages.find(m=>m.id===b.messageId&&m.role==='assistant');requireThat(entry,'unknown_message');speechChild?.kill();const child=spawn('/usr/bin/say',['-v','Kyoko','-r','175'],{stdio:['pipe','ignore','pipe']});speechChild=child;speechOwner=browser;child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(entry.text);child.on('error',()=>reply(res,502,{error:'speech_unavailable'}));child.on('exit',code=>{if(speechChild===child){speechChild=null;speechOwner=null}reply(res,200,{spoken:code===0})});res.on('close',()=>{if(!res.writableEnded)child.kill()});return;
   }
   throw new AppError('not_found',404);
  }catch(e){if(!res.headersSent){const code=typeof e.code==='string'&&/^[a-z_]{1,64}$/.test(e.code)?e.code:'request_failed';reply(res,e instanceof AppError?e.status:502,{error:code,message:errorMessages[code]||'処理を完了できませんでした。入力や保存済みの記録を確認してください。'})}else if(!res.destroyed)res.end()}
 });
 return {server,vault,interview,get origin(){return origin},async listen(port=43127){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});origin=`http://127.0.0.1:${server.address().port}`;return origin},async close(){clearInterval(timer);lock();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));vault.close()}};
}
