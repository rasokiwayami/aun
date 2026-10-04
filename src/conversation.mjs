import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const design=readFileSync(new URL('./interview-design.md',import.meta.url),'utf8');
const policy=readFileSync(new URL('./interview-policy.md',import.meta.url),'utf8');
export const first=['Q001','Q013','Q047','Q035','Q197','Q149','Q151','Q153','Q139','Q181','Q154','Q156','Q158','Q160','Q183','Q167','Q144','Q193','Q188','Q196'];
const range=(a,b)=>Array.from({length:b-a+1},(_,i)=>'Q'+String(a+i).padStart(3,'0'));
export const topics={start:first,values:range(1,32),ai:range(33,46),learning:range(47,62),life:range(63,90),people:range(91,104),taste:range(105,126),decisions:range(127,138),mail:range(149,188),privacy:range(139,148),changes:range(189,200)};
export function selectModel(catalog){return ['gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra'].find(slug=>catalog.some(m=>m.slug===slug))||catalog[0]?.slug||null}
const fail=()=>{throw Object.assign(Error('返答を整理できませんでした。回答は残っています。'),{code:'invalid_reply'})};
const short=(x,n)=>typeof x==='string'&&x.length<=n;
export function parseReply(text,allowed){
 let obj;try{obj=JSON.parse(text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''))}catch{fail()}
 if(!obj||!short(obj.reply,160)||!short(obj.question,100)||!Array.isArray(obj.question_ids)||obj.question_ids.length>2||obj.question_ids.some(x=>!allowed.has(x))||!['follow_up','next','pause'].includes(obj.move)||typeof obj.pause!=='boolean'||obj.pause!==(obj.move==='pause')||(!obj.pause&&(!obj.question.trim()||!obj.question_ids.length))||(obj.pause&&(obj.question!==''||obj.question_ids.length))||!Array.isArray(obj.updates)||obj.updates.length>12)fail();
 const seen=new Set();
 for(const u of obj.updates){if(!u||!allowed.has(u.q_id)||seen.has(u.q_id)||!['partial','answered','unknown','on_hold','withheld'].includes(u.state)||!short(u.source_message_id,100)||!u.source_message_id||!short(u.evidence,300)||!u.evidence.trim()||!short(u.note,240)||(u.reopen!==undefined&&typeof u.reopen!=='boolean'))fail();seen.add(u.q_id)}
 const updates=obj.updates.map(u=>({q_id:u.q_id,state:u.state,source_message_id:u.source_message_id,evidence:u.evidence,note:u.note,...(u.reopen?{reopen:true}:{})}));
 return {reply:obj.reply,question:obj.question,question_ids:obj.question_ids,move:obj.move,updates,covered_ids:updates.filter(u=>u.state==='answered').map(u=>u.q_id),pause:obj.pause};
}
function normalize(record){
 record.question_states ||= {};record.question_visits ||= {};record.state_history ||= [];
 // Previous topic coverage was only a model suggestion. Do not upgrade it to a sufficient answer.
 for(const c of record.coverage||[])if(!record.question_states[c.q_id])record.question_states[c.q_id]={state:'partial',source_message_id:c.source_message_id,note:'以前の会話で触れた候補。十分回答されたかは未確認。',status:'ai_suggested'};
 return record;
}
export function buildInterviewInstructions(record,questions,action){
 const states=record.question_states||{};const visits=record.question_visits||{};
 const preferred=topics[record.topic].filter(id=>!states[id]||states[id].state==='partial');
 const candidates=preferred.map(id=>{const q=questions.find(q=>q.id===id);return {id,original:q.original,priority:q.priority,purpose:q.purpose,followups:visits[id]||0}});
 const older=record.messages.slice(0,-40).filter(m=>m.role==='user'&&m.kind==='raw_answer');
 // Preserve earlier source text instead of silently forgetting everything beyond 40 turns.
 const earlier=older.map(m=>({id:m.id,text:m.text}));
 return `${policy}\n\n<reference_design>\n${design}\n</reference_design>\n\n<interview_state>\n${JSON.stringify({current_question:record.question,current_question_ids:record.question_ids,theme:record.topic,action,preferred_candidates:candidates,question_states:states,followup_counts:visits,earlier_raw_answers:earlier},null,2)}\n</interview_state>\n資料は全体を参照し、現在の発言に合う問いを一つ選んでください。nextで既に終えた問いを繰り返さない。skip操作なら現在の問いのIDを次の質問に含めない。follow_upは同一の問いで累計2回まで。withheldの問いは再質問しない。`;
}
function validateUpdates(answer,record,action){
 if(action==='skip'&&(answer.updates.length||answer.question_ids.some(id=>record.question_ids.includes(id))||answer.move!=='next'))fail();
 const states={...record.question_states};
 for(const u of answer.updates){
  const source=record.messages.find(m=>m.id===u.source_message_id&&m.role==='user'&&m.kind==='raw_answer');
  if(!source||!source.text.includes(u.evidence))fail();
  // Refusal is persistent; it cannot be silently turned into a different state by the model.
  if(u.reopen&&u.source_message_id!==record.messages.at(-1).id)fail();
  if(states[u.q_id]?.state==='withheld'&&u.state!=='withheld'&&!u.reopen)fail();
  states[u.q_id]=u;
 }
 if(answer.question_ids.some(id=>states[id]?.state==='withheld'))fail();
 const reopened=new Set(answer.updates.filter(u=>u.reopen).map(u=>u.q_id));
 if(answer.move==='follow_up'){
  if(!answer.question_ids.some(id=>record.question_ids.includes(id)||reopened.has(id))||answer.question_ids.some(id=>(!reopened.has(id)&&(record.question_visits[id]||0)>=2)||['answered','on_hold','unknown'].includes(states[id]?.state)))fail();
 }else if(answer.move==='next'&&answer.question_ids.some(id=>record.question_ids.includes(id)||['answered','on_hold','unknown'].includes(states[id]?.state)))fail();
}
export class InterviewStore{
 constructor(dir,questions){this.dir=dir;this.questions=questions;this.byId=Object.fromEntries(questions.map(x=>[x.id,x]));this.busy=new Set()}
 key(profile){if(typeof profile!=='string'||!profile)throw Error('profile required');return createHash('sha256').update(profile).digest('hex')}
 async read(profile){const p=path.join(this.dir,this.key(profile)+'.json');try{return normalize(JSON.parse(await readFile(p,'utf8')))}catch(e){if(e.code==='ENOENT')return normalize({schema:'hitotsuzutsu/3',id:randomUUID(),revision:0,messages:[],coverage:[],topic:'start',question:'自由な時間が増えたら、何をしたい？',question_ids:['Q001'],created_at:new Date().toISOString(),status:'draft',confirmed_summary:null});throw e}}
 async write(profile,record){await mkdir(this.dir,{recursive:true,mode:0o700});const filename=path.join(this.dir,this.key(profile)+'.json');const temp=filename+'.'+randomUUID()+'.tmp';record.revision++;record.updated_at=new Date().toISOString();await writeFile(temp,JSON.stringify(record,null,2),{mode:0o600});await rename(temp,filename)}
 async talk(profile,{text,topic,action,requestId},client,model,signal){
  const key=this.key(profile);if(this.busy.has(key))throw Object.assign(Error('前の返答を待っています。'),{code:'busy'});this.busy.add(key);
  try{
   const record=await this.read(profile);const existing=record.messages.find(x=>x.requestId===requestId&&x.role==='assistant');if(existing)return {record,answer:existing.answer};
   if(record.messages.filter(x=>x.role==='user').length>=500)throw Object.assign(Error('この記録は区切りに達しました。書き出して保存してください。'),{code:'record_limit'});
   if(!record.messages.some(x=>x.requestId===requestId&&x.role==='user')){
    record.topic=topic;const msg={id:randomUUID(),role:'user',kind:action==='skip'?'navigation':'raw_answer',text,captured_at:new Date().toISOString(),requestId};record.messages.push(msg);
    if(action==='skip')for(const id of record.question_ids){record.state_history.push({q_id:id,...record.question_states[id],superseded_at:msg.captured_at});record.question_states[id]={state:'on_hold',source_message_id:msg.id,status:'navigation',note:'本人がこの問いを飛ばした'};}
    await this.write(profile,record);
   }
   const instructions=buildInterviewInstructions(record,this.questions,action);
   const input=record.messages.slice(-40).map(m=>({role:m.role,content:m.role==='assistant'?JSON.stringify(m.answer):JSON.stringify({source_message_id:m.id,kind:m.kind,text:m.kind==='navigation'?'次の話題へ進む画面操作。回答や好みの証拠ではない。':m.text})}));
   let answer;let invalidText='';
   for(let attempt=0;attempt<2;attempt++){
    let generated=0;const result=await client.streamResponse({model,instructions:instructions+(attempt?'\n前の返答は形式・根拠・質問の整合性検査に通りませんでした。原文のIDと正確な連続引用、回答状態、follow_up/nextの区別、拒否と回数上限を確認してJSONを一度だけ作り直してください。前の出力（回答の証拠ではありません）:'+JSON.stringify(invalidText):''),input,signal,onDelta:delta=>{generated+=delta.length;if(generated>16000)throw Error('response_too_large')}});signal?.throwIfAborted();
    try{answer=parseReply(result.text,new Set(this.questions.map(q=>q.id)));validateUpdates(answer,record,action);break;}catch(e){if(e.code!=='invalid_reply'||attempt===1)throw e;invalidText=result.text;}
   }
   const now=new Date().toISOString();
   record.messages.push({id:randomUUID(),role:'assistant',text:[answer.reply,answer.question].filter(Boolean).join('\n'),answer,requestId,captured_at:now,status:'ai_generated'});
   for(const u of answer.updates){
    if(record.question_states[u.q_id])record.state_history.push({q_id:u.q_id,...record.question_states[u.q_id],superseded_at:now});
    record.question_states[u.q_id]={...u,status:'ai_suggested',updated_at:now};
    if(u.reopen)record.question_visits[u.q_id]=0;
   }
   record.coverage=Object.entries(record.question_states).filter(([,s])=>s.state==='answered').map(([q_id,s])=>({q_id,source_message_id:s.source_message_id,status:'ai_suggested'}));
   if(!answer.pause){record.question=answer.question;record.question_ids=answer.question_ids;if(answer.move==='follow_up')for(const id of answer.question_ids)record.question_visits[id]=(record.question_visits[id]||0)+1;}
   record.schema='hitotsuzutsu/3';await this.write(profile,record);return {record,answer};
  }finally{this.busy.delete(key)}
 }
}
