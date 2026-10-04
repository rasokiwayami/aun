import {readdir,open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {requireThat} from '../core/errors.mjs';
import {LIMITS,text} from '../core/schema.mjs';
export class LegacyImporter {
 constructor(dir,vault){this.dir=dir;this.vault=vault}
 async read(id){requireThat(typeof id==='string'&&/^[a-f0-9]{64}$/.test(id),'invalid_legacy_id');const stat=await lstat(this.dir);requireThat(stat.isDirectory()&&!stat.isSymbolicLink(),'unsafe_path');const file=await open(path.join(this.dir,id+'.json'),constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=await file.stat();requireThat(st.isFile()&&st.size<=4*1024*1024,'legacy_limit',413);const raw=await file.readFile('utf8'),record=JSON.parse(raw);requireThat(['hitotsuzutsu/3','hitotsuzutsu/2','hitotsuzutsu/1'].includes(record.schema)&&Array.isArray(record.messages)&&record.messages.length<=1500,'invalid_legacy');return {record,hash:createHash('sha256').update(raw).digest('hex')}}finally{await file.close()}}
 async list(){let files;try{files=await readdir(this.dir)}catch(e){if(e.code==='ENOENT')return [];throw e}const results=[];for(const filename of files.filter(f=>/^[a-f0-9]{64}\.json$/.test(f)).slice(0,100)){try{const id=filename.slice(0,-5),{record}=await this.read(id);results.push({id,label:`以前の記録 ${results.length+1}`,answers:record.messages.filter(m=>m.role==='user'&&m.kind==='raw_answer').length})}catch{}}return results}
 async import(id,{beforeCommit}={}){const {record,hash}=await this.read(id);beforeCommit?.();return this.vault.mutate('legacy-'+hash,{type:'legacy_import',hash},s=>{
  const at=new Date().toISOString(),importId=randomUUID(),sourceIds=[];let assistantTurns=0;
  for(const m of record.messages){if(m.role==='user'&&m.kind==='raw_answer'){
   requireThat(Object.keys(s.sources).length<LIMITS.sources,'source_limit',413);const value=text(m.text,LIMITS.sourceChars),sourceId=randomUUID();sourceIds.push(sourceId);const timestamp=typeof m.captured_at==='string'&&Number.isFinite(Date.parse(m.captured_at))?m.captured_at:at;
   s.sources[sourceId]={id:sourceId,revision:1,text:value,revisions:[{revision:1,text:value,producer:'legacy_import',at}],kind:'text',speaker:'self',receivedAt:timestamp,utteredAt:timestamp,createdAt:at,policy:{model:false,disclosure:false},retentionAt:null,legacyImportId:importId};
  }else if(m.role==='assistant'&&typeof m.text==='string'){s.conversation.messages.push({id:randomUUID(),role:'assistant',kind:'legacy_assistant',text:text(m.text,20000,true),capturedAt:at,sourceIds:[...sourceIds],legacyImportId:importId});assistantTurns++}}
  // Old question IDs have no reliable correspondence with the new bank. Preserve as
  // historical metadata, never translate them into confirmed knowledge or coverage.
  s.legacyImports||=[];s.legacyImports.push({id:importId,hash,at,sourceIds,questionStates:record.question_states||{},coverage:record.coverage||[],navigation:record.messages.filter(m=>m.kind==='navigation').map(m=>({text:typeof m.text==='string'?m.text.slice(0,20000):'',at:m.captured_at||at})),status:'historical_unconfirmed'});
  s.dataEpoch++;return {importedSources:sourceIds.length,assistantTurns,reconfirmationRequired:true,originalPreserved:true,refs:sourceIds};
 })}
}
