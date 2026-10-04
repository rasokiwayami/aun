import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createServer} from 'node:net';
import {mkdtempSync,chmodSync,rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';

// Launch the bundle through LaunchServices so macOS attributes permission
// requests to VoiceBridge, rather than to the terminal/editor hosting Node.
// Speech travels over a private local socket, never a temporary text file.
export function launchVoiceBridge(root,{launch=spawn,inspect=false,connectTimeoutMs=10000}={}) {
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  const directory=mkdtempSync('/tmp/hz-voice-');chmodSync(directory,0o700);
  const socketPath=path.join(directory,'stream');
  let socket,launcher,closed=false,timer;
  const server=createServer(connection=>{
    if(closed||socket){connection.destroy();return}
    socket=connection;clearTimeout(timer);
    socket.on('data',data=>{if(!closed)child.stdout.write(data)});
    socket.on('error',()=>finish('voice_terminated'));
    socket.on('end',()=>finish('voice_terminated'));
  });
  function finish(code) {
    if(closed)return;closed=true;clearTimeout(timer);
    if(code)child.stdout.write(JSON.stringify({type:'error',code})+'\n');
    socket?.destroy();server.close();launcher?.kill();
    rmSync(directory,{recursive:true,force:true});child.stdout.end();child.stderr.end();
    child.emit('exit',code?1:0);
  }
  child.kill=()=>finish();
  server.on('error',()=>finish('voice_unavailable'));
  server.listen(socketPath,()=>{
    if(closed)return;chmodSync(socketPath,0o600);
    const args=['-n','-g','-W',path.join(root,'bin/VoiceBridge.app'),'--args','--socket',socketPath,...(inspect?['inspect']:[])];
    try{launcher=launch('/usr/bin/open',args,{stdio:['ignore','ignore','ignore']})}
    catch{finish('voice_unavailable');return}
    launcher.on('error',()=>finish('voice_unavailable'));
    launcher.on('exit',()=>{if(!socket)finish('voice_terminated')});
    timer=setTimeout(()=>finish('voice_start_timeout'),connectTimeoutMs);timer.unref?.();
  });
  return child;
}
