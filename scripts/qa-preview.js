import 'dotenv/config';
import fs from 'node:fs';
const environment=JSON.parse(fs.readFileSync('.local/qa-environment.json','utf8'));
if(!environment.database.startsWith('jzx_quality_'))throw new Error('只能预览独立测试库');
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',DB_NAME:environment.database,PORT:String(environment.port),APP_ORIGIN:environment.origin,BACKGROUND_JOBS:'false'});
await import('../server/index.js');
