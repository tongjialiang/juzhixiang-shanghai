import 'dotenv/config';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
const suffix=crypto.randomBytes(4).toString('hex').replace(/\d/g,digit=>String.fromCharCode(103+Number(digit)));
const testEnvironment={...process.env,DB_NAME:`jzx_quality_${suffix}`,HOST:'127.0.0.1',PORT:'3089',APP_ORIGIN:'http://127.0.0.1:3089',NODE_ENV:'test',BACKGROUND_JOBS:'false'};
let occupied=false;
try{await fetch(testEnvironment.APP_ORIGIN+'/api/health',{signal:AbortSignal.timeout(1000)});occupied=true;}catch{}
if(occupied)throw new Error('测试端口 3089 已被占用，请先关闭独立测试预览；不会停止现有报名服务。');
fs.writeFileSync('.local/qa-environment.json',JSON.stringify({database:testEnvironment.DB_NAME,port:3089,origin:testEnvironment.APP_ORIGIN}));
function run(filename){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[filename],{env:testEnvironment,stdio:'inherit'});child.on('exit',code=>code===0?resolve():reject(new Error(`${filename} 检查未通过`)));});}
await run('scripts/init-db.js');
const log=fs.openSync('work/qa-server.log','w');
const server=spawn(process.execPath,['server/index.js'],{env:testEnvironment,stdio:['ignore',log,log]});
let ready=false;
try{
 for(let attempt=0;attempt<40;attempt++){try{const response=await fetch(testEnvironment.APP_ORIGIN+'/api/health');if(response.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,150));}
 if(!ready)throw new Error('独立测试服务没有正常启动');
 await run('tests/e2e.js');
 // 重启独立测试进程，清空本轮限流计数，保持生产限流配置不变。
 server.kill();await new Promise(resolve=>server.once('exit',resolve));
 const secondLog=fs.openSync('work/qa-regression-server.log','w');
 const regressionServer=spawn(process.execPath,['server/index.js'],{env:testEnvironment,stdio:['ignore',secondLog,secondLog]});
 try{
  ready=false;for(let attempt=0;attempt<40;attempt++){try{if((await fetch(testEnvironment.APP_ORIGIN+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,150));}
  if(!ready)throw new Error('扩展测试服务没有正常启动');
  await run('tests/changes-v4.js');
  await run('tests/worker.js');
 }finally{regressionServer.kill();await new Promise(resolve=>regressionServer.once('exit',resolve));}
 const operationsLog=fs.openSync('work/qa-admin-operations.log','w');
 const operationsServer=spawn(process.execPath,['server/index.js'],{env:testEnvironment,stdio:['ignore',operationsLog,operationsLog]});
 try{
  ready=false;for(let attempt=0;attempt<40;attempt++){try{if((await fetch(testEnvironment.APP_ORIGIN+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,150));}
  if(!ready)throw new Error('后台操作测试服务没有正常启动');
  await run('tests/admin-operations-v7.js');
 }finally{operationsServer.kill();}
}finally{server.kill();}
