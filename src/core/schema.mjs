import {requireThat,fail} from './errors.mjs';
export const PURPOSES = ['self_reflection','conversation','draft_reply','compare','learn','create','plan'];
export const CONDITION_FIELDS = ['recipient','relationship','activity','timeOfDay','channel','project','location'];
export const LIMITS = {sourceChars:20000,sources:2500,manualSources:5000,totalSources:7500,assertions:5000,packs:100,receipts:500,operations:20000,bytes:32*1024*1024,modelChars:48000,replyChars:600};
export const copy = x => structuredClone(x);
export function text(value,max=2000,empty=false) {requireThat(typeof value==='string'&&value.length<=max&&(empty||value.trim().length));return value;}
export function list(value,max=30) {requireThat(Array.isArray(value)&&value.length<=max);return value;}
export function identifier(value) {requireThat(typeof value==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(value)&&!['__proto__','prototype','constructor'].includes(value));return value;}
export function date(value) {if(value==null||value==='')return null;requireThat(typeof value==='string'&&value.length<=40&&/^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/.test(value)&&Number.isFinite(Date.parse(value)),'invalid_time');if(value.length===10)requireThat(new Date(value).toISOString().slice(0,10)===value,'invalid_time');return value;}
export function scope(input={}) {
  requireThat(input&&typeof input==='object'&&!Array.isArray(input));
  const purposes=list(input.purposes||[],PURPOSES.length).map(x=>{requireThat(PURPOSES.includes(x),'invalid_purpose');return x});
  const conditions=list(input.conditions||[],12).map(c=>{
    requireThat(c&&CONDITION_FIELDS.includes(c.field)&&['eq','neq','in','not_in'].includes(c.op),'invalid_condition');
    const value=['in','not_in'].includes(c.op)?list(c.value,20).map(v=>text(v,120)):text(c.value,120);
    return {field:c.field,op:c.op,value};
  });
  return {purposes:[...new Set(purposes)],conditions,exceptions:list(input.exceptions||[],8).map(v=>text(v,200))};
}
export function policy(input={}) {requireThat(input&&typeof input==='object');return {model:input.model===true,disclosure:input.disclosure===true};}
export function validTime(input={}) {requireThat(input&&typeof input==='object');const start=date(input.start),end=date(input.end);requireThat(!start||!end||Date.parse(start)<Date.parse(end),'invalid_time');const precision=input.precision||((start||end)?'range':'unknown');requireThat(['exact','day','month','season','year','range','unknown'].includes(precision),'invalid_time');const label=input.label==null?'':text(input.label,120,true);return {start,end,precision,label};}
export function knowledgeInput(input) {
  requireThat(input&&typeof input==='object');
  requireThat(['fact','preference','value','policy','state','hypothesis'].includes(input.kind),'invalid_kind');
  return {text:text(input.text,2000),kind:input.kind,scope:scope(input.scope),validTime:validTime(input.validTime),sensitivity:input.sensitivity==='sensitive'?'sensitive':'private',hardConstraint:input.hardConstraint===true,policy:policy(input.policy),conflictsWith:[...new Set(list(input.conflictsWith||[],30).map(identifier))]};
}
export function matches(a,{purpose,taskId,context={},now=Date.now()}) {
  if(a.status!=='active'&&!(a.status==='task_local'&&a.taskId===taskId&&Date.parse(a.taskExpiresAt)>now))return {ok:false,reason:'unconfirmed'};
  if(a.kind==='hypothesis')return {ok:false,reason:'hypothesis'};
  if(a.validTime.start&&Date.parse(a.validTime.start)>now||a.validTime.end&&Date.parse(a.validTime.end)<=now)return {ok:false,reason:'expired'};
  if(a.scope.purposes.length&&!a.scope.purposes.includes(purpose))return {ok:false,reason:'purpose'};
  if(a.scope.exceptions.length)return {ok:false,reason:'needs_clarification'};
  for(const c of a.scope.conditions){
    const v=context[c.field];if(typeof v!=='string')return {ok:false,reason:'missing_context'};
    const ok=c.op==='eq'?v===c.value:c.op==='neq'?v!==c.value:c.op==='in'?c.value.includes(v):!c.value.includes(v);
    if(!ok)return {ok:false,reason:'condition'};
  }
  return {ok:true};
}
export function checkState(s) {
  requireThat(s?.schema==='hitotsuzutsu/vault/1'&&typeof s.id==='string'&&Number.isSafeInteger(s.revision)&&s.revision>=0,'backup_invalid');
  for(const k of ['sources','assertions','packs','operations','jobs']){requireThat(s[k]&&typeof s[k]==='object'&&!Array.isArray(s[k]),'backup_invalid');for(const id of Object.keys(s[k]))identifier(id);}
  for(const k of ['reviews','receipts','tombstones'])requireThat(Array.isArray(s[k]),'backup_invalid');
  requireThat(s.consent&&typeof s.consent.model==='boolean'&&s.settings&&Number.isSafeInteger(s.dataEpoch)&&Number.isSafeInteger(s.policyEpoch),'backup_invalid');
  requireThat(Object.keys(s.sources).length<=LIMITS.totalSources&&Object.keys(s.assertions).length<=LIMITS.assertions&&Buffer.byteLength(JSON.stringify(s))<=LIMITS.bytes,'backup_limit',413);
  for(const [id,source] of Object.entries(s.sources)){identifier(id);requireThat(source.id===id&&Number.isSafeInteger(source.revision)&&source.revision>0,'backup_invalid');text(source.text,LIMITS.sourceChars);for(const field of ['createdAt','receivedAt','utteredAt'])requireThat(typeof source[field]==='string'&&date(source[field]),'backup_invalid');requireThat(['self','unknown','other'].includes(source.speaker)&&source.policy&&typeof source.policy.model==='boolean'&&typeof source.policy.disclosure==='boolean','backup_invalid');date(source.retentionAt);list(source.revisions,1000);for(const r of source.revisions){text(r.text,LIMITS.sourceChars);requireThat(Number.isSafeInteger(r.revision),'backup_invalid')}}
  requireThat(Object.values(s.sources).filter(x=>x.revisions[0]?.producer!=='user_knowledge_edit').length<=LIMITS.sources&&Object.values(s.sources).filter(x=>x.revisions[0]?.producer==='user_knowledge_edit').length<=LIMITS.manualSources,'backup_limit',413);
  for(const [id,a] of Object.entries(s.assertions)){identifier(id);requireThat(a.id===id&&Number.isSafeInteger(a.revision)&&a.revision>0,'backup_invalid');Object.assign(a,knowledgeInput(a));requireThat(['proposed','held','active','task_local','invalidated','withdrawn','rejected'].includes(a.status),'backup_invalid');list(a.evidence,20);for(const e of a.evidence){identifier(e.sourceId);requireThat(Number.isSafeInteger(e.revision)&&e.revision>0&&Number.isSafeInteger(e.start)&&Number.isSafeInteger(e.end)&&e.start>=0&&e.end>e.start&&typeof e.quote==='string'&&e.quote.length<=LIMITS.sourceChars,'backup_invalid');const source=s.sources[e.sourceId];if(a.status==='active'||a.status==='task_local')requireThat(source&&source.revision===e.revision&&source.text.slice(e.start,e.end)===e.quote,'backup_invalid');}}
  requireThat(s.conversation&&typeof s.conversation.question==='string'&&Array.isArray(s.conversation.messages)&&s.inquiry&&typeof s.inquiry==='object','backup_invalid');
  for(const m of s.conversation.messages){identifier(m.id);text(m.text,20000,true);requireThat(typeof m.capturedAt==='string'&&date(m.capturedAt),'backup_invalid');}
  for(const t of s.tombstones){identifier(t.id);requireThat(['source','assertion','pack'].includes(t.type),'backup_invalid');}
  return s;
}

/** Explicit user-marked conflicts are checked before ranking or size truncation. */
export function checkConflicts(assertions) {
  const eligible=new Set(assertions.map(a=>a.id));
  requireThat(!assertions.some(a=>(a.conflictsWith||[]).some(id=>id!==a.id&&eligible.has(id))),'conflict_requires_resolution',409);
}
