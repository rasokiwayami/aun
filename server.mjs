import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from './src/server/app.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.HITOTSUZUTSU_PORT||43127);
if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid port');
const app=createApp({root,dataDir:process.env.HITOTSUZUTSU_DATA_DIR||path.join(root,'.local')});
console.log(await app.listen(port));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await app.close();process.exit(0)}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
