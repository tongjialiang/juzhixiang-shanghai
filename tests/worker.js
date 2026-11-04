import 'dotenv/config';
import http from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const environment=JSON.parse(fs.readFileSync('.local/qa-environment.json','utf8'));
if(!environment.database.startsWith('jzx_quality_'))throw new Error('通知和模型测试只能在独立测试库运行');
process.env.DB_NAME=environment.database;
const {pool}=await import('../server/db.js');
const origin=environment.origin,workerOrigin='http://127.0.0.1:3091';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
let worker,notifyFailure=true,modelMode='failure',heldResponse,notifyRequests=[],modelRequests=[];const results=[];
const provider=http.createServer(async(request,response)=>{
 let body='';for await(const chunk of request)body+=chunk;const data=JSON.parse(body);
 response.setHeader('Content-Type','application/json');
 if(request.url==='/notification'){
  notifyRequests.push({data,authorization:request.headers.authorization});response.statusCode=notifyFailure?503:200;response.end(JSON.stringify({ok:!notifyFailure}));
 }else{
  modelRequests.push(data);
  if(modelMode==='hold'){heldResponse=response;return;}
  response.statusCode=modelMode==='failure'?503:200;response.end(JSON.stringify({choices:[{message:{content:'根据当前主题准备讨论建议。'}}]}));
 }
});
await new Promise(resolve=>provider.listen(3092,'127.0.0.1',resolve));
const cookies=new Map();
async function call(route,body,method='POST'){
 const response=await fetch(origin+route,{method,headers:{'Content-Type':'application/json',Cookie:[...cookies].map(([name,value])=>`${name}=${value}`).join('; ')},body:body===undefined?undefined:JSON.stringify(body)});
 for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],position=pair.indexOf('=');cookies.set(pair.slice(0,position),pair.slice(position+1));}
 const data=await response.json();assert(response.ok,data.error);return data;
}
async function waitFor(work){const start=Date.now();while(Date.now()-start<15000){const result=await work();if(result)return result;await new Promise(resolve=>setTimeout(resolve,80));}throw new Error('后台任务没有在测试时限内完成');}
async function job(applicationId,kind){const [rows]=await pool.execute('SELECT * FROM jobs WHERE application_id=? AND kind=?',[applicationId,kind]);return rows[0];}
async function check(name,work){try{await work();results.push({name,passed:true});console.log('通过：'+name);}catch(error){results.push({name,passed:false,error:error.message});throw error;}}
async function create({manual=false,model=false}={}){
 const mobile='137'+String(crypto.randomInt(10000000,99999999));
 const body={type:'family',name:'通知模型隔离测试',mobile,idempotencyKey:crypto.randomUUID(),profile:{relationship:'父母',asdAge:manual?'<25':'35–44',parentAge:'50–59',count:1,members:['成年ASD本人'],fourthMeal:false},topics:['N01'],question:'私人个性问题原文不能传到外部模型',channel:'独立后台任务测试',consent:{privacy:true,sensitive:true,payment:true,model}};
 return call('/api/applications',body);
}
try{
 // 只暂停独立测试库内之前的任务，所有外部请求都指向本文件的本地模拟服务。
 await pool.query("UPDATE jobs SET status='DONE' WHERE status IN ('PENDING','PROCESSING')");
 await call('/api/admin/login',{username:process.env.ADMIN_USER,password:process.env.ADMIN_PASSWORD});
 const manual=await create({manual:true}),model=await create({model:true}),obsolete=await create({manual:true});
 await call(`/api/admin/applications/${obsolete.id}/decision`,{status:'APPROVED',note:'在提醒发送前已经人工处理'});
 const log=fs.openSync('work/qa-worker.log','w');
 worker=spawn(process.execPath,['server/index.js'],{env:{...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:'3091',APP_ORIGIN:workerOrigin,DB_NAME:environment.database,BACKGROUND_JOBS:'true',JOB_POLL_MS:'150',MANUAL_WEBHOOK_URL:'http://127.0.0.1:3092/notification',MANUAL_WEBHOOK_TOKEN:'test-only-token',QWEN_BASE_URL:'http://127.0.0.1:3092/v1',QWEN_API_KEY:'test-only-key',QWEN_ENABLED:'true'},stdio:['ignore',log,log]});
 await check('人工提醒失败持久化为可重试状态',async()=>{await waitFor(async()=>{const record=await job(manual.id,'webhook');return record.attempts===1&&record.status==='PENDING';});});
 await check('提醒请求仅含编码和处理信息，不含家庭隐私',async()=>{const request=notifyRequests.find(record=>record.data.applicationCode===manual.code);assert(request);assert.equal(request.authorization,'Bearer test-only-token');const text=JSON.stringify(request.data);assert(!text.includes(manual.mobile));assert(!text.includes(manual.name));assert(!text.includes('私人个性问题'));assert.equal(request.data.reviewUrl,workerOrigin+'/admin');});
 await check('提醒成功重试后完成，不重复创建通知任务',async()=>{notifyFailure=false;await pool.execute("UPDATE jobs SET next_at=NOW() WHERE application_id=? AND kind='webhook'",[manual.id]);await waitFor(async()=> (await job(manual.id,'webhook')).status==='DONE');assert.equal((await job(manual.id,'webhook')).attempts,2);});
 await check('已人工处理的申请不再发送过时提醒',async()=>{await waitFor(async()=> (await job(obsolete.id,'webhook')).status==='DONE');assert(!notifyRequests.some(record=>record.data.applicationCode===obsolete.code));});
 await check('模型失败时保留规则分析且不阻止申请付款',async()=>{
  await waitFor(async()=>{const record=await job(model.id,'analysis');return record.status==='PENDING'&&record.attempts===1;});
  const application=await call(`/api/applications/${model.id}`,undefined,'GET');assert.equal(application.status,'APPROVED');const [rows]=await pool.execute('SELECT analysis FROM applications WHERE id=?',[model.id]);assert.equal(rows[0].analysis.source,'rules');await call(`/api/applications/${model.id}/orders`,{});
 });
 await check('模型输入仅包含结构化主题，不发送问题原文与联系方式',async()=>{assert(modelRequests.length);const data=JSON.stringify(modelRequests[0]);assert(data.includes('未来居住'));assert(!data.includes(model.mobile));assert(!data.includes('私人个性问题'));assert(!data.includes(model.name));});
 await check('模型恢复后可重试完成需求分析',async()=>{modelMode='success';await pool.execute("UPDATE jobs SET next_at=NOW() WHERE application_id=? AND kind='analysis'",[model.id]);await waitFor(async()=> (await job(model.id,'analysis')).status==='DONE');const [rows]=await pool.execute('SELECT analysis FROM applications WHERE id=?',[model.id]);assert.equal(rows[0].analysis.source,'qwen-max');});
 await check('修改需求时旧模型响应不会覆盖新主题',async()=>{
  modelMode='hold';await call(`/api/applications/${model.id}/needs`,{topics:['N02'],question:''},'PUT');await waitFor(()=>heldResponse);
  await call(`/api/applications/${model.id}/needs`,{topics:['N05'],question:'更新后的问题'},'PUT');
  const response=heldResponse;heldResponse=null;modelMode='success';response.end(JSON.stringify({choices:[{message:{content:'这是一条过期的旧主题建议'}}]}));
  await waitFor(async()=> (await job(model.id,'analysis')).status==='DONE');const [rows]=await pool.execute('SELECT analysis FROM applications WHERE id=?',[model.id]);assert.deepEqual(rows[0].analysis.themes,['家庭之外的长期支持']);assert(!rows[0].analysis.suggestion.includes('过期的旧主题'));
 });
 await check('达到重试上限后允许工作人员手动重试',async()=>{
  notifyFailure=true;await pool.execute("UPDATE jobs SET status='PENDING',attempts=3,next_at=NOW() WHERE application_id=? AND kind='webhook'",[manual.id]);await waitFor(async()=> (await job(manual.id,'webhook')).status==='FAILED');
  notifyFailure=false;const notificationJob=await job(manual.id,'webhook');await call(`/api/admin/jobs/${notificationJob.id}/retry`,{});await waitFor(async()=> (await job(manual.id,'webhook')).status==='DONE');
 });
 console.log(`后台任务测试通过 ${results.length} 项。`);
}finally{
 heldResponse?.end(JSON.stringify({choices:[]}));if(worker){worker.kill();await new Promise(resolve=>worker.once('exit',resolve));}await new Promise(resolve=>provider.close(resolve));
 fs.writeFileSync(`work/后台任务测试结果_v4_${Date.now()}.json`,JSON.stringify({at:new Date().toISOString(),database:environment.database,results},null,2));await pool.end();
}
