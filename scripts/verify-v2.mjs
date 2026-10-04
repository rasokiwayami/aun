// Adapter for the shared artifact verification helper. Synthetic tests only.
import {spawnSync} from 'node:child_process';import {readdir,mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';import {checkPublic} from './check-public.mjs';
const evidence=process.argv[2];if(!evidence)throw Error('evidence directory required');await mkdir(evidence,{recursive:true});
const tests=(await readdir('tests')).filter(x=>x.endsWith('.test.mjs')).map(x=>'tests/'+x);
const run=spawnSync(process.execPath,['--test','--test-reporter=tap',...tests],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
await writeFile(path.join(evidence,'tests.tap'),run.stdout+'\n'+run.stderr);const scan=checkPublic(process.cwd());await writeFile(path.join(evidence,'public-check.json'),JSON.stringify(scan,null,2));
const count=Number(run.stdout.match(/^# tests (\d+)/m)?.[1]||0),failures=Number(run.stdout.match(/^# fail (\d+)/m)?.[1]||0);
console.log(JSON.stringify({observations:[{requirement_id:'behavior',status:run.status===0&&count>0&&failures===0?'pass':'fail',observed:{tests:count,failures,exitCode:run.status},evidence_files:['tests.tap']},{requirement_id:'packaging',status:scan.findings.length?'fail':'pass',observed:{files:scan.files,findings:scan.findings.length},evidence_files:['public-check.json']}]}));
