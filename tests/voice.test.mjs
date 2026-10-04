import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {connect} from 'node:net';
import {statSync,existsSync} from 'node:fs';
import path from 'node:path';
import {launchVoiceBridge} from '../src/server/voice.mjs';

test('bundle launch uses private memory-only transport and cancellation closes the helper connection',async()=>{
 let socketPath,peer,launchArgs;const launcher=new EventEmitter();launcher.kill=()=>{};
 const child=launchVoiceBridge('/synthetic app',{launch:(command,args)=>{assert.equal(command,'/usr/bin/open');launchArgs=args;socketPath=args[args.indexOf('--socket')+1];assert.equal(statSync(path.dirname(socketPath)).mode&0o777,0o700);assert.equal(statSync(socketPath).mode&0o777,0o600);peer=connect(socketPath,()=>peer.write('{"type":"ready"}\n'));return launcher}});
 const data=await once(child.stdout,'data');assert.match(data[0].toString(),/ready/);assert.deepEqual(launchArgs.slice(0,4),['-n','-g','-W','/synthetic app/bin/VoiceBridge.app']);
 const closed=once(peer,'close');child.kill();await closed;assert.equal(existsSync(path.dirname(socketPath)),false);
});
test('unexpected helper disconnect is reported without exposing native diagnostics',async()=>{
 const launcher=new EventEmitter();launcher.kill=()=>{};let socketPath;
 const child=launchVoiceBridge('/synthetic',{launch:(_command,args)=>{socketPath=args[args.indexOf('--socket')+1];const peer=connect(socketPath,()=>peer.end());return launcher}});
 const chunks=[];child.stdout.on('data',d=>chunks.push(d));await once(child,'exit');assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()),{type:'error',code:'voice_terminated'});assert.equal(existsSync(path.dirname(socketPath)),false);
});
test('failed launch and connection timeout terminate with actionable error codes',async()=>{
 for(const scenario of ['failed','timeout']){
  let socketPath;const launcher=new EventEmitter();launcher.kill=()=>{};
  const child=launchVoiceBridge('/synthetic',{connectTimeoutMs:20,launch:(_command,args)=>{socketPath=args[args.indexOf('--socket')+1];if(scenario==='failed')queueMicrotask(()=>launcher.emit('error',Error('private native detail')));return launcher}});
  const chunks=[];child.stdout.on('data',d=>chunks.push(d));await once(child,'exit');assert.equal(JSON.parse(Buffer.concat(chunks).toString()).code,scenario==='failed'?'voice_unavailable':'voice_start_timeout');assert.equal(existsSync(path.dirname(socketPath)),false);
 }
});
test('cancelling before the launch callback does not launch a microphone helper',async()=>{
 let launched=false;const child=launchVoiceBridge('/synthetic',{launch:()=>{launched=true;throw Error('must not launch')}});child.kill();await new Promise(resolve=>setImmediate(resolve));assert.equal(launched,false);
});
