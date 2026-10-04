import {mkdtemp,cp,mkdir,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const revision='f723814abdccec135b519c451fb6e1992ee5e933';
if(!process.argv.includes('--accept-noncommercial')){
 console.error('The optional Sign in with ChatGPT DevKit has separate NONCOMMERCIAL terms. Read https://github.com/openai/sign-in-with-chatgpt-devkit/blob/'+revision+'/LICENSE then rerun with --accept-noncommercial only if your use qualifies.');process.exit(2);
}
const target=path.join(root,'vendor/siwc');
try{await access(target);console.error('vendor/siwc already exists. Existing files were not changed.');process.exit(2)}catch(e){if(e.code!=='ENOENT')throw e}
const temporary=await mkdtemp(path.join(tmpdir(),'hitotsuzutsu-siwc-'));
try{
 execFileSync('git',['init','--quiet',temporary],{stdio:'inherit'});
 execFileSync('git',['-C',temporary,'remote','add','origin','https://github.com/openai/sign-in-with-chatgpt-devkit.git'],{stdio:'inherit'});
 execFileSync('git',['-C',temporary,'fetch','--depth=1','origin',revision],{stdio:'inherit'});
 execFileSync('git',['-C',temporary,'checkout','--detach','FETCH_HEAD'],{stdio:'inherit'});
 const actual=execFileSync('git',['-C',temporary,'rev-parse','HEAD'],{encoding:'utf8'}).trim();if(actual!==revision)throw Error('Unexpected source revision');
 await mkdir(target,{recursive:true});
 for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md','tsconfig.base.json','packages/local/src','packages/local/tsconfig.json'])await cp(path.join(temporary,name),path.join(target,name),{recursive:true});
 console.log('Installed optional DevKit source at pinned revision '+revision+'. No sign-in or inference was performed.');
}finally{await rm(temporary,{recursive:true,force:true})}
