import {existsSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {fail,requireThat} from '../core/errors.mjs';
export class ChatGPTProvider {
  constructor(root,dataDir){this.root=root;this.dataDir=dataDir;this.authPromise=null;this.catalog=[];this.profileId=null}
  get available(){return process.platform==='darwin'&&existsSync(path.join(this.root,'vendor/siwc/dist/index.js'))&&existsSync(path.join(this.root,'bin/KeychainBridge'))}
  async auth(){requireThat(this.available,'provider_unavailable',503);if(!this.authPromise)this.authPromise=import(pathToFileURL(path.join(this.root,'src/auth.mjs'))).then(m=>m.createAuth(this.root,this.dataDir)).catch(()=>{this.authPromise=null;fail('provider_unavailable',503)});return this.authPromise}
  async status(){if(!this.available)return {available:false,connected:false,sharing:false};const a=await this.auth();try{const s=await a.client.getSession();if(this.profileId!==s.profileId){this.catalog=[];this.profileId=s.profileId}return {available:true,connected:s.status==='connected',sharing:!!s.sharing,name:s.identity?.name||'ChatGPT',connectionId:s.profileId||null,signingIn:a.getPending().signingIn}}catch{return {available:true,connected:false,sharing:false}}}
  async models(){requireThat(this.available,'provider_unavailable',503);const s=await this.status();requireThat(s.connected&&s.sharing&&s.connectionId,'sign_in_required',401);if(!this.catalog.length)this.catalog=await (await this.auth()).client.listModels();const preferred=['gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra'];return {models:this.catalog,selected:preferred.find(x=>this.catalog.some(m=>m.slug===x))||this.catalog[0]?.slug}}
  async start(){return (await this.auth()).start()}
  async pending(){return (await this.auth()).getPending()}
  async cancel(){const a=await this.auth();a.client.cancelSignIn();a.clearUrl();return {cancelled:true}}
  async disconnect(){if(this.available){const a=await this.auth();a.client.cancelSignIn();await a.client.disconnect();a.clearUrl()}this.catalog=[];this.profileId=null;return {disconnected:true}}
  async respond({instructions,input,model,signal,connectionId,beforeSend}){
    const catalog=await this.models(),chosen=model||catalog.selected;requireThat(catalog.models.some(m=>m.slug===chosen),'model_unavailable');let chars=0;
    const a=await this.auth(),status=await this.status();requireThat(status.connectionId===connectionId&&status.connected&&status.sharing,'model_reconsent_required',403);beforeSend?.();signal?.throwIfAborted();
    return a.client.streamResponse({model:chosen,instructions,input,signal,onDelta:delta=>{chars+=delta.length;if(chars>32000)fail('model_output_limit',413)}});
  }
}
