import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID,createHash,createHmac} from 'node:crypto';
import {mkdirSync,chmodSync,existsSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {createProposals} from './proposals.mjs';
import {seal,unseal,wrapKey,unwrapKey,encryptBackup,decryptBackup} from './crypto.mjs';
import {fail,requireThat} from './errors.mjs';
import {LIMITS,PURPOSES,copy,text,identifier,knowledgeInput,checkState,matches,date,checkConflicts} from './schema.mjs';
const now = () => new Date().toISOString();
const id = () => randomUUID();
const canonical = value => JSON.stringify(value, (_k,v) => v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const hash = x => createHash('sha256').update(x).digest('hex');
const aad = vaultId => `hitotsuzutsu-vault/1:${vaultId}`;
// A full acknowledgement ledger must not block correction, revocation or use of
// already-saved records. These operations have revision/job checks or bounded
// replaceable results; old capture acknowledgements are never evicted.
const capacitySafeOperations=new Set(['source_delete','knowledge_delete','knowledge_withdraw','knowledge_edit','source_edit','source_permission','consent','settings','expire','restore','review','pack_preview','pack_export','navigation','draft','interview_start','interview_sources','interview','interview_failure','model_egress']);
const purposeLabels={self_reflection:'自分のことを考える',conversation:'会話',draft_reply:'返信の下書き',compare:'比較する',learn:'学ぶ',create:'作る',plan:'計画する'};
const kindLabels={fact:'本人が述べた事実',preference:'好み',value:'大切にしていること',policy:'方針',state:'現在・特定時期の状態',hypothesis:'未確認の仮説'};
const fieldLabels={recipient:'相手',relationship:'関係',activity:'活動',timeOfDay:'時間帯',channel:'連絡手段',project:'対象プロジェクト',location:'場所'};
const operatorLabels={eq:'一致',neq:'一致しない',in:'いずれかに一致',not_in:'いずれにも一致しない'};
const precisionLabels={exact:'正確な時刻',day:'日',month:'月',season:'季節',year:'年',range:'期間',unknown:'不明'};
const isManualSource=source=>source.revisions?.[0]?.producer==='user_knowledge_edit';
function currentEvidence(s,e){const source=s.sources[e.sourceId];return !!source&&source.revision===e.revision&&(!source.retentionAt||Date.parse(source.retentionAt)>Date.now())}
function markdownItem(a,index){
  const conditions=a.scope.conditions.map(c=>`${fieldLabels[c.field]}: ${operatorLabels[c.op]} ${JSON.stringify(c.value)}`).join('、')||'追加条件なし';
  return `## ${index+1}\n\n> ${a.text.replace(/\n/g,'\n> ')}\n\n- 種類: ${kindLabels[a.kind]}\n- 適用する用途: ${a.scope.purposes.length?a.scope.purposes.map(p=>purposeLabels[p]).join('、'):'指定なし（この出力では今回の用途に限る）'}\n- 条件（すべて満たす場合）: ${conditions}\n- 例外: ${a.scope.exceptions.length?a.scope.exceptions.map(x=>JSON.stringify(x)).join('、'):'なし'}\n- 有効期間: ${a.validTime.start||'開始未指定'} から ${a.validTime.end||'終了未指定'}（終了日時は含まない）\n- 時期の表現: ${a.validTime.label?JSON.stringify(a.validTime.label):'記載なし'}／精度: ${precisionLabels[a.validTime.precision]}\n- 適用範囲: ${a.useScope==='current_task'?`今回のタスクのみ（期限: ${a.taskExpiresAt}）`:'上記の用途・条件・期間に一致する場合'}\n- 扱い: ${a.hardConstraint?'必ず守る条件':'参考情報'}\n`;
}
function initialState(vaultId) {return {
  schema:'hitotsuzutsu/vault/1',id:vaultId,revision:0,dataEpoch:0,policyEpoch:0,createdAt:now(),updatedAt:now(),
  sources:{},assertions:{},reviews:[],packs:{},receipts:[],operations:{},jobs:{},tombstones:[],
  consent:{model:false,provider:'chatgpt'},settings:{draftPersistence:false,retentionDays:null,showPrivateQuestionToTools:false},
  inquiry:{},conversation:{question:'今、どんなことを話したい？',questionId:null,topic:'start',messages:[]},draft:null,
};}
function currentRevision(item,revision){requireThat(item,'not_found',404);requireThat(item.revision===revision,'revision_conflict',409)}
function dependsOn(item,sources,assertions){return sources.has(item.sourceId)||item.sourceIds?.some(id=>sources.has(id))||item.assertionRefs?.some(ref=>assertions.has(ref.id))}
function invalidate(s, sourceIds=[], assertionIds=[]) {
  const sources=new Set(sourceIds), assertions=new Set(assertionIds);
  for(const a of Object.values(s.assertions))if(a.evidence.some(e=>sources.has(e.sourceId)))assertions.add(a.id);
  for(const key of assertions){const a=s.assertions[key];if(a&&a.status!=='withdrawn'){a.status='invalidated';a.revision++;a.updatedAt=now()}}
  for(const p of Object.values(s.packs))if(p.items.some(x=>assertions.has(x.id))||p.sourceIds?.some(x=>sources.has(x)))p.status='invalidated';
  for(const job of Object.values(s.jobs))if(dependsOn(job,sources,assertions)){job.status='cancelled';delete job.answer;delete job.assistantMessageId}
  for(const goal of Object.values(s.inquiry.goals||{}))if(sources.has(goal.evidence?.sourceId)){delete goal.evidence;if(['sufficient_for_scope','covered_by_existing','unknown','partial'].includes(goal.status))goal.status=goal.visits>=goal.limit?'exhausted':'partial';}
  s.conversation.question='今、どんなことを話したい？';s.conversation.questionId=null;
  // Responses depend on the exact source and adopted-knowledge revisions used.
  s.conversation.messages=s.conversation.messages.filter(m=>!dependsOn(m,sources,assertions));
  for(const op of Object.values(s.operations))if(['pack_preview','pack_export','propose','interview'].includes(op.type)&&op.refs?.some(x=>sources.has(x)||assertions.has(x))){op.invalidated=true;delete op.result;}
  for(const a of Object.values(s.assertions))if(a.history)a.history=a.history.filter(h=>!h.evidence?.some(e=>sources.has(e.sourceId)));
  s.dataEpoch++;
  return assertions;
}
function purge(s, sourceIds=[], assertionIds=[]) {
  const sources=new Set(sourceIds),assertions=invalidate(s,sourceIds,assertionIds);
  for(const source of sources){delete s.sources[source];s.tombstones.push({type:'source',id:source,at:now()})}
  for(const assertion of assertions){delete s.assertions[assertion];s.tombstones.push({type:'assertion',id:assertion,at:now()})}
  for(const [key,p] of Object.entries(s.packs))if(p.items.some(x=>assertions.has(x.id))||p.sourceIds?.some(x=>sources.has(x))){delete s.packs[key];s.tombstones.push({type:'pack',id:key,at:now()})}
  s.reviews=s.reviews.filter(r=>!assertions.has(r.assertionId));
  for(const job of Object.values(s.jobs))if(dependsOn(job,sources,assertions)){job.status='cancelled';delete job.sourceId;delete job.sourceIds;delete job.assertionRefs;delete job.payloadHash;delete job.answer;delete job.assistantMessageId}
  for(const op of Object.values(s.operations))if(op.refs?.some(x=>sources.has(x)||assertions.has(x))){op.purged=true;delete op.result;delete op.hash;op.refs=[]}
  for(const receipt of s.receipts)if(receipt.assertionIds?.some(x=>assertions.has(x))||receipt.sourceIds?.some(x=>sources.has(x))){receipt.status='source_deleted_external_copy_may_remain';delete receipt.assertionIds;delete receipt.sourceIds;delete receipt.contentHash}
  if(s.legacyImports)s.legacyImports=s.legacyImports.filter(x=>!x.sourceIds?.some(id=>sources.has(id)));
  s.draft=null;
  s.conversation.question='今、どんなことを話したい？';s.conversation.questionId=null;
  return {externalCopiesRemain:s.receipts.some(x=>x.status==='source_deleted_external_copy_may_remain')};
}
function score(a,query){if(!query.trim())return 0;const words=query.toLowerCase().split(/[\s、。,]+/).filter(Boolean);return words.reduce((n,w)=>n+(a.text.toLowerCase().includes(w)?1:0),0)}
function packSelection(s,input) {
  requireThat(PURPOSES.includes(input.purpose),'invalid_purpose');
  requireThat(['self','external'].includes(input.audience)&&['clipboard','file','chatgpt'].includes(input.destination),'invalid_destination');
  const query=text(input.query??'',4000,true),context=input.context||{};
  requireThat(context&&typeof context==='object'&&!Array.isArray(context));
  const omitted={},eligible=[],applicable=[];
  for(const a of Object.values(s.assertions)){
    let result=matches(a,{...input,context});
    if(result.ok&&a.evidence.some(e=>!currentEvidence(s,e)))result={ok:false,reason:'source_changed_or_expired'};
    if(result.ok)applicable.push(a);
    if(result.ok&&input.audience==='external'&&!a.policy.disclosure)result={ok:false,reason:'disclosure_not_allowed'};
    if(result.ok&&input.destination==='chatgpt'&&(!s.consent.model||!a.policy.model))result={ok:false,reason:'model_not_allowed'};
    if(result.ok)eligible.push(a);else omitted[result.reason]=(omitted[result.reason]||0)+1;
  }
  checkConflicts(applicable);
  const limit=Math.min(30,Math.max(1,Number.isInteger(input.limit)?input.limit:12));
  const mandatory=eligible.filter(a=>a.hardConstraint),normal=eligible.filter(a=>!a.hardConstraint).sort((a,b)=>score(b,query)-score(a,query)||a.id.localeCompare(b.id));
  const selected=[...mandatory,...normal.slice(0,Math.max(0,limit-mandatory.length))];
  requireThat(selected.reduce((n,a)=>n+a.text.length,0)<=6000,'context_too_large',413);
  return {selected,omitted,query};
}
export class Vault {
  constructor(dir) {this.dir=path.resolve(dir);this.filename=path.join(this.dir,'vault.sqlite');this.db=null;this.key=null;this.header=null;this.closed=false}
  get exists(){return existsSync(this.filename)}
  get unlocked(){return !!this.key}
  connect(create=false){
    if(this.db)return this.db;
    if(!create)requireThat(this.exists,'vault_missing',404);
    mkdirSync(this.dir,{recursive:true,mode:0o700});requireThat(!lstatSync(this.dir).isSymbolicLink(),'unsafe_path');chmodSync(this.dir,0o700);
    if(this.exists)requireThat(lstatSync(this.filename).isFile()&&!lstatSync(this.filename).isSymbolicLink(),'unsafe_path');
    this.db=new DatabaseSync(this.filename,{timeout:2000,enableForeignKeyConstraints:true,allowExtension:false});chmodSync(this.filename,0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS vault (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, header TEXT NOT NULL, payload TEXT NOT NULL) STRICT;');
    return this.db;
  }
  async create(passphrase,{recovery=false}={}){
    requireThat(!this.exists,'vault_exists',409);
    const key=randomBytes(32),vaultId=id();let recoveryCode;
    try{
      const header={format:'hitotsuzutsu.vault-header/1',id:vaultId,key:await wrapKey(key,passphrase,aad(vaultId))};
      if(recovery){recoveryCode=randomBytes(24).toString('base64url');header.recovery=await wrapKey(key,recoveryCode,aad(vaultId)+':recovery')}
      const state=initialState(vaultId),db=this.connect(true);
      db.exec('BEGIN IMMEDIATE');
      try{requireThat(!db.prepare('SELECT id FROM vault WHERE id=1').get(),'vault_exists',409);db.prepare('INSERT INTO vault VALUES (1,?,?,?)').run(0,JSON.stringify(header),JSON.stringify(seal(key,Buffer.from(JSON.stringify(state)),aad(vaultId))));db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}
      this.key=key;this.header=header;return {recoveryCode};
    }catch(e){if(this.key!==key)key.fill(0);throw e}
  }
  async unlock(passphrase){
    const row=this.connect().prepare('SELECT header,payload FROM vault WHERE id=1').get();
    let key;
    try{const header=JSON.parse(row.header);requireThat(header.format==='hitotsuzutsu.vault-header/1');key=await unwrapKey(header.key,passphrase,aad(header.id));checkState(JSON.parse(unseal(key,JSON.parse(row.payload),aad(header.id)).toString('utf8')));this.lock();this.key=key;this.header=header;return true}catch{key?.fill(0);fail('unlock_failed',401)}
  }
  async recover(recoveryCode,newPassphrase){
    const db=this.connect(),row=db.prepare('SELECT header,payload,revision FROM vault WHERE id=1').get();let key;
    try{
      const header=JSON.parse(row.header);requireThat(header.recovery,'recovery_unavailable');key=await unwrapKey(header.recovery,recoveryCode,aad(header.id)+':recovery');checkState(JSON.parse(unseal(key,JSON.parse(row.payload),aad(header.id)).toString('utf8')));
      const replacement={...header,key:await wrapKey(key,newPassphrase,aad(header.id))};
      const change=db.prepare('UPDATE vault SET header=? WHERE id=1 AND revision=? AND header=?').run(JSON.stringify(replacement),row.revision,row.header);requireThat(change.changes===1,'revision_conflict',409);this.lock();this.key=key;this.header=replacement;return true;
    }catch(e){key?.fill(0);if(e.code==='revision_conflict')throw e;fail('recovery_failed',401)}
  }
  lock(){this.key?.fill(0);this.key=null;this.header=null}
  close(){this.lock();if(this.db){this.db.close();this.db=null}}
  read(){requireThat(this.key,'vault_locked',401);const row=this.connect().prepare('SELECT revision,payload FROM vault WHERE id=1').get();const s=JSON.parse(unseal(this.key,JSON.parse(row.payload),aad(this.header.id)).toString('utf8'));requireThat(s.revision===row.revision,'vault_corrupt',500);return s}
  mutate(operationId,payload,fn){
    requireThat(this.key,'vault_locked',401);identifier(operationId);
    const fingerprint=createHmac('sha256',this.key).update(canonical(payload)).digest('hex'),db=this.connect();db.exec('BEGIN IMMEDIATE');
    try{
      const state=this.read(),previous=state.operations[operationId];
      if(previous){requireThat(!previous.purged,'operation_gone',410);requireThat(!previous.invalidated,'operation_stale',409);requireThat(previous.hash===fingerprint,'operation_conflict',409);db.exec('COMMIT');return copy(previous.result)}
      const atCapacity=Object.keys(state.operations).length>=LIMITS.operations;
      requireThat(!atCapacity||capacitySafeOperations.has(payload.type),'operation_limit',413);
      const result=fn(state)||{};requireThat(!result?.then,'async_transaction',500);
      if(!atCapacity)state.operations[operationId]={type:payload.type,hash:fingerprint,result:copy(result),refs:[result.sourceId,result.id,...(result.refs||[])].filter(Boolean),at:now()};
      state.revision++;state.updatedAt=now();
      const bytes=Buffer.from(JSON.stringify(state));requireThat(bytes.length<=LIMITS.bytes,'vault_limit',413);
      const updated=db.prepare('UPDATE vault SET revision=?,payload=? WHERE id=1 AND revision=?').run(state.revision,JSON.stringify(seal(this.key,bytes,aad(state.id))),state.revision-1);requireThat(updated.changes===1,'revision_conflict',409);db.exec('COMMIT');return copy(result);
    }catch(e){try{db.exec('ROLLBACK')}catch{}throw e}
  }
  capture(input){
    const value=text(input.text,LIMITS.sourceChars);requireThat(['text','speech','document'].includes(input.kind),'invalid_kind');requireThat(['self','unknown','other'].includes(input.speaker||'self'),'invalid_speaker');if(input.kind==='speech')requireThat(input.speechAccepted===true,'speech_not_accepted');
    return this.mutate(input.operationId,{...input,type:'capture'},s=>{
      requireThat(Object.values(s.sources).filter(source=>!isManualSource(source)).length<LIMITS.sources&&Object.keys(s.sources).length<LIMITS.totalSources,'source_limit',413);
      const sourceId=id(),capturedAt=now();s.sources[sourceId]={id:sourceId,revision:1,text:value,revisions:[{revision:1,text:value,producer:input.kind==='speech'?'asr_accepted':'user',at:capturedAt}],kind:input.kind,engineFinal:input.kind==='speech'?input.speechFinal===true:null,acceptedByUser:true,purpose:PURPOSES.includes(input.purpose)?input.purpose:'self_reflection',topic:typeof input.topic==='string'?input.topic:'free',speaker:input.speaker||'self',utteredAt:date(input.utteredAt)||capturedAt,receivedAt:capturedAt,createdAt:capturedAt,policy:{model:s.consent.model,disclosure:false},retentionAt:s.settings.retentionDays?new Date(Date.now()+s.settings.retentionDays*86400000).toISOString():null};
      s.dataEpoch++;s.draft=null;return {sourceId,sourceRevision:1};
    });
  }
  addProposals(input){
    return this.mutate(input.operationId||id(),{...input,type:'propose'},s=>{const created=createProposals(s,input);return {created,refs:[input.sourceId,...created.map(a=>a.id)]}}).created;
  }
  review(input){return this.mutate(input.operationId,{...input,type:'review'},s=>{
    const a=s.assertions[input.id];currentRevision(a,input.expectedRevision);requireThat(['proposed','held'].includes(a.status),'review_unavailable');requireThat(['accept','hold','reject','task_only'].includes(input.decision));
    if(input.decision==='task_only')requireThat(typeof input.taskId==='string'&&input.taskId.length>0&&input.taskId.length<=120&&Date.parse(input.expiresAt)>Date.now()&&Date.parse(input.expiresAt)<=Date.now()+86400000,'task_required');
    for(const e of a.evidence)requireThat(s.sources[e.sourceId]?.revision===e.revision,'stale_evidence',409);
    a.status={accept:'active',hold:'held',reject:'rejected',task_only:'task_local'}[input.decision];a.reviewedAt=now();a.revision++;if(input.decision==='task_only'){a.taskId=input.taskId;a.taskExpiresAt=input.expiresAt}
    s.reviews.push({id:id(),assertionId:a.id,targetRevision:input.expectedRevision,decision:input.decision,at:now()});s.dataEpoch++;return {id:a.id,refs:a.evidence.map(e=>e.sourceId)};
  })}
  editSource(input){const value=text(input.text,LIMITS.sourceChars);return this.mutate(input.operationId,{...input,type:'source_edit'},s=>{
    const source=s.sources[input.id];currentRevision(source,input.expectedRevision);requireThat(source.revisions.length<1000,'revision_limit',413);invalidate(s,[source.id]);source.revision++;source.text=value;source.revisions.push({revision:source.revision,text:value,producer:'user_edit',at:now()});source.updatedAt=now();return {sourceId:source.id,sourceRevision:source.revision};
  })}
  deleteSource(input){const result=this.mutate(input.operationId,{...input,type:'source_delete'},s=>{currentRevision(s.sources[input.id],input.expectedRevision);return {...purge(s,[input.id]),deleted:true}});this.checkpoint();return result}
  saveKnowledge(input){
    const value=knowledgeInput(input);
    return this.mutate(input.operationId,{...input,type:input.id?'knowledge_edit':'knowledge_save'},s=>{
      let previous,historical,source;if(input.id){previous=s.assertions[input.id];currentRevision(previous,input.expectedRevision);historical=copy(previous);const prior=previous.evidence.length===1?s.sources[previous.evidence[0].sourceId]:null;if(prior&&isManualSource(prior)&&prior.revision===previous.evidence[0].revision)source=prior;invalidate(s,source?[source.id]:[],[input.id])}
      requireThat(previous||Object.keys(s.assertions).length<LIMITS.assertions,'assertion_limit',413);
      const at=now();
      if(source){requireThat(source.revisions.length<1000,'revision_limit',413);source.revision++;source.text=value.text;source.revisions.push({revision:source.revision,text:value.text,producer:'user_knowledge_edit',at});source.updatedAt=at;source.utteredAt=at;source.receivedAt=at;source.policy=copy(value.policy);source.retentionAt=null}
      else{requireThat(Object.values(s.sources).filter(isManualSource).length<LIMITS.manualSources&&Object.keys(s.sources).length<LIMITS.totalSources,'source_limit',413);const sourceId=id();source={id:sourceId,revision:1,text:value.text,revisions:[{revision:1,text:value.text,producer:'user_knowledge_edit',at}],kind:'text',speaker:'self',createdAt:at,receivedAt:at,utteredAt:at,policy:copy(value.policy),retentionAt:null};s.sources[sourceId]=source}
      const sourceId=source.id;
      const a={...value,id:previous?.id||id(),revision:historical?historical.revision+1:1,status:'active',evidence:[{sourceId,revision:source.revision,start:0,end:value.text.length,quote:value.text}],createdAt:previous?.createdAt||at,updatedAt:at,reviewedAt:at,history:historical?[...(historical.history||[]),{...historical,history:undefined}]:[]};
      s.assertions[a.id]=a;s.reviews.push({id:id(),assertionId:a.id,targetRevision:a.revision,decision:'user_authored',at});s.dataEpoch++;s.policyEpoch++;return {id:a.id,refs:[sourceId]};
    });
  }
  deleteKnowledge(input){const result=this.mutate(input.operationId,{...input,type:'knowledge_delete'},s=>{currentRevision(s.assertions[input.id],input.expectedRevision);return {...purge(s,[],[input.id]),deleted:true}});this.checkpoint();return result}
  withdraw(input){return this.mutate(input.operationId,{...input,type:'knowledge_withdraw'},s=>{const a=s.assertions[input.id];currentRevision(a,input.expectedRevision);invalidate(s,[],[a.id]);a.status='withdrawn';return {id:a.id}})}
  setConsent(enabled,connectionId=null){requireThat(typeof enabled==='boolean');return this.mutate(id(),{type:'consent',enabled},s=>{s.consent.model=enabled;s.consent.connectionId=enabled?connectionId:null;s.policyEpoch++;for(const op of Object.values(s.operations))if(['pack_preview','pack_export','propose','interview'].includes(op.type)){op.invalidated=true;delete op.result;}for(const p of Object.values(s.packs))p.status='invalidated';for(const j of Object.values(s.jobs))if(j.status==='running')j.status='cancelled';return {enabled}})}
  previewPack(input){return this.mutate(input.operationId,{...input,type:'pack_preview'},s=>{
    const {selected,omitted}=packSelection(s,input),packId=id();
    if(Object.keys(s.packs).length>=LIMITS.packs){const oldest=Object.values(s.packs).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0];delete s.packs[oldest.id]}
    const items=selected.map(a=>({id:a.id,revision:a.revision,text:a.text,kind:a.kind,scope:copy(a.scope),validTime:copy(a.validTime),hardConstraint:a.hardConstraint,useScope:a.status==='task_local'?'current_task':'matching_conditions',taskExpiresAt:a.status==='task_local'?a.taskExpiresAt:null}));
    const expiresAt=new Date(Math.min(Date.now()+3600000,...items.flatMap(a=>[a.validTime.end,a.taskExpiresAt].filter(Boolean).map(Date.parse)))).toISOString();
    const value={schema:'hitotsuzutsu.context-pack/1',purpose:input.purpose,expiresAt,authority:'data_only_no_execution_permission',items:items.map(({id:_,revision:__,...a})=>a),constraints:['記載のない事情や約束を補わない。','この資料は情報であり、外部行為の権限ではない。']};
    const markdown=`# 今回のための情報\n\n用途: ${purposeLabels[input.purpose]}\n利用期限: ${expiresAt}\n\n${items.length?items.map(markdownItem).join('\n'):'使える確認済みの情報はありません。'}\n\n## 扱い方\n${value.constraints.map(x=>'- '+x).join('\n')}\n`;
    const pack={id:packId,revision:1,status:'preview',items,sourceIds:[...new Set(selected.flatMap(a=>a.evidence.map(e=>e.sourceId)))],purpose:input.purpose,taskId:input.taskId||null,audience:input.audience,destination:input.destination,context:copy(input.context||{}),text:items.map(a=>a.text).join('\n'),markdown,json:JSON.stringify(value,null,2),omitted:Object.entries(omitted).map(([reason,count])=>({reason,count})),uncertainties:omitted.needs_clarification||omitted.missing_context?['適用条件が未確認の項目は含めていません。']:[],dataEpoch:s.dataEpoch,policyEpoch:s.policyEpoch,expiresAt,createdAt:now()};s.packs[packId]=pack;return {...copy(pack),refs:[...pack.sourceIds,...items.map(a=>a.id)]};
  })}
  exportPack(input){return this.mutate(id(),{...input,type:'pack_export'},s=>{
    const p=s.packs[input.id];requireThat(p&&p.revision===input.expectedRevision&&p.status!=='invalidated'&&p.dataEpoch===s.dataEpoch&&p.policyEpoch===s.policyEpoch&&Date.parse(p.expiresAt)>Date.now(),'pack_stale',409);
    const current=packSelection(s,{...p,query:''});requireThat(current.selected.filter(a=>a.hardConstraint).every(a=>p.items.some(item=>item.id===a.id&&item.revision===a.revision)),'pack_stale',409);
    for(const item of p.items){const a=s.assertions[item.id];requireThat(a&&a.revision===item.revision&&a.evidence.every(e=>currentEvidence(s,e))&&matches(a,{purpose:p.purpose,taskId:p.taskId,context:p.context}).ok&&(p.audience!=='external'||a.policy.disclosure)&&(p.destination!=='chatgpt'||s.consent.model&&a.policy.model),'pack_stale',409)}
    requireThat(['markdown','json'].includes(input.format));const content=input.format==='json'?p.json:p.markdown;
    s.receipts.push({id:id(),packId:p.id,assertionIds:p.items.map(a=>a.id),at:now(),destination:p.destination,status:'exported_external_copy_not_managed'});s.receipts=s.receipts.slice(-LIMITS.receipts);
    return {filename:`context-${p.id.slice(0,8)}.${input.format==='json'?'json':'md'}`,mime:input.format==='json'?'application/json':'text/markdown',content,refs:[...p.sourceIds,...p.items.map(a=>a.id)]};
  })}
  updateSettings(input){return this.mutate(id(),{...input,type:'settings'},s=>{
    if(input.draftPersistence!==undefined){requireThat(typeof input.draftPersistence==='boolean');s.settings.draftPersistence=input.draftPersistence;if(!input.draftPersistence)s.draft=null}
    if(input.showPrivateQuestionToTools!==undefined){requireThat(typeof input.showPrivateQuestionToTools==='boolean');s.settings.showPrivateQuestionToTools=input.showPrivateQuestionToTools}
    if(input.retentionDays!==undefined){requireThat(input.retentionDays===null||Number.isInteger(input.retentionDays)&&input.retentionDays>=1&&input.retentionDays<=3650);s.settings.retentionDays=input.retentionDays}
    return {settings:copy(s.settings)};
  })}
  sourcePermission(input){return this.mutate(input.operationId||id(),{...input,type:'source_permission'},s=>{const source=s.sources[input.id];currentRevision(source,input.expectedRevision);requireThat(typeof input.model==='boolean');source.policy.model=input.model;if(!input.model){for(const a of Object.values(s.assertions))if(a.evidence.some(e=>e.sourceId===source.id))a.policy.model=false;for(const p of Object.values(s.packs))if(p.sourceIds?.includes(source.id))p.status='invalidated';for(const j of Object.values(s.jobs))if(j.sourceIds?.includes(source.id))j.status='cancelled';}s.policyEpoch++;return {sourceId:source.id}})}
  saveDraft(value,clear=false){return this.mutate(id(),{type:'draft',clear,text:clear?'':value},s=>{requireThat(s.settings.draftPersistence||clear,'draft_not_enabled',403);s.draft=clear?null:{text:text(value,LIMITS.sourceChars,true),expiresAt:new Date(Date.now()+86400000).toISOString()};return {saved:!clear}})}
  expire(){return this.mutate(id(),{type:'expire'},s=>{const sourceIds=Object.values(s.sources).filter(x=>x.retentionAt&&Date.parse(x.retentionAt)<=Date.now()).map(x=>x.id);const result=sourceIds.length?purge(s,sourceIds):{};if(s.draft&&Date.parse(s.draft.expiresAt)<=Date.now())s.draft=null;return {expired:sourceIds.length,...result}})}
  async backup(passphrase){return encryptBackup(this.read(),passphrase)}
  async restore(content,passphrase,{acknowledgeUnknownHistory=false,beforeCommit}={}){
    const incoming=checkState(await decryptBackup(content,passphrase));
    beforeCommit?.();
    return this.mutate(id(),{type:'restore',backup:hash(content)},s=>{
      const same=incoming.id===s.id;requireThat(same||acknowledgeUnknownHistory,'restore_history_unknown',409);
      const tombstones=[...s.tombstones,...incoming.tombstones];
      const sourceTombs=new Set(tombstones.filter(t=>t.type==='source').map(t=>t.id)),assertionTombs=new Set(tombstones.filter(t=>t.type==='assertion').map(t=>t.id));
      // Merge rather than overwrite. Current revisions and confirmed corrections win.
      let added=0;
      for(const source of Object.values(incoming.sources))if(!sourceTombs.has(source.id)&&!s.sources[source.id]){s.sources[source.id]=copy(source);s.sources[source.id].policy.model=false;added++}
      for(const a of Object.values(incoming.assertions))if(!assertionTombs.has(a.id)&&!s.assertions[a.id]&&a.evidence.every(e=>!sourceTombs.has(e.sourceId)&&s.sources[e.sourceId]?.revision===e.revision)){
        const restored=copy(a);restored.status='proposed';restored.policy={model:false,disclosure:false};restored.history=[];delete restored.reviewedAt;delete restored.taskId;delete restored.taskExpiresAt;s.assertions[a.id]=restored;
      }
      s.tombstones=[...new Map(tombstones.map(t=>[t.type+':'+t.id,t])).values()];purge(s,[...sourceTombs],[...assertionTombs]);s.consent.model=false;s.policyEpoch++;s.packs={};s.jobs={};s.draft=null;
      return {importedSources:added,reconfirmationRequired:true,modelConsentReset:true,historyKnown:same,externalCopiesRemain:true};
    });
  }
  checkpoint(){try{this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);')}catch{/* Logical invalidation is committed; unavailable physical compaction is not a deletion failure. */}}
  view(){
    const s=this.read();const sources=Object.values(s.sources).sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt));
    const messages=[...sources.map(x=>({id:x.id,role:'user',kind:'raw_answer',inputKind:x.kind,text:x.text,revision:x.revision,capturedAt:x.receivedAt,speaker:x.speaker,policy:copy(x.policy)})),...s.conversation.messages].sort((a,b)=>a.capturedAt.localeCompare(b.capturedAt));
    return {revision:s.revision,vaultId:s.id,question:s.conversation.question,questionId:s.conversation.questionId,topic:s.conversation.topic,messages,proposals:Object.values(s.assertions).filter(a=>['proposed','held'].includes(a.status)),knowledge:Object.values(s.assertions).filter(a=>!['proposed','held','rejected'].includes(a.status)),inquiry:s.inquiry,consent:s.consent,settings:s.settings,packs:Object.values(s.packs).map(({markdown,json,text,sourceIds,...p})=>p),receipts:s.receipts};
  }
}
