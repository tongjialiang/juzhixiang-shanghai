import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {pool} from '../server/db.js';
const base=process.env.APP_ORIGIN;const results=[];const created=[];
if(process.env.NODE_ENV!=='test'||!process.env.DB_NAME.startsWith('jzx_quality_'))throw new Error('请运行 npm run test:full，集成测试不能直接操作报名数据库');
class Client{
 cookies=new Map();
 async call(route,{method='GET',body,status=200}={}){
  const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',Cookie:[...this.cookies].map(([key,value])=>`${key}=${value}`).join('; ')},body:body===undefined?undefined:JSON.stringify(body)});
  for(const cookie of response.headers.getSetCookie()){const [pair]=cookie.split(';');const separator=pair.indexOf('=');this.cookies.set(pair.slice(0,separator),pair.slice(separator+1));}
  const data=await response.json();assert.equal(response.status,status,`${route}: ${data.error||JSON.stringify(data)}`);return data;
 }
}
const admin=new Client(),client=new Client();
const record=(name)=>{results.push({name,passed:true});console.log('通过：'+name);};
async function submit(options={}){
 const mobile='139'+String(crypto.randomInt(10000000,99999999));
 const payload={type:'family',name:'自动验收测试',mobile,idempotencyKey:crypto.randomUUID(),profile:{relationship:'父母',asdAge:'25–34',parentAge:'50–59',count:4,members:['成年ASD本人','父亲','母亲','亲属'],fourthMeal:true},topics:['N03'],question:'希望了解沟通支持',channel:'自动验收测试',consent:{privacy:true,sensitive:true,payment:true,pilot:false,model:false},...options};
 const application=await client.call('/api/applications',{method:'POST',body:payload});created.push(application.id);return {application,payload};
}
try{
 const health=await admin.call('/api/health');assert.equal(health.testDatabase,process.env.DB_NAME,'测试接口和数据库必须一致');
 await admin.call('/api/admin/login',{method:'POST',body:{username:process.env.ADMIN_USER,password:process.env.ADMIN_PASSWORD}});record('后台登录与会话');
 const {application:automatic,payload}=await submit();assert.equal(automatic.status,'APPROVED');assert.equal(automatic.fee_cents,252500);record('家庭申请自动通过与第四人午餐计费');
 const repeated=await client.call('/api/applications',{method:'POST',body:payload});assert.equal(repeated.id,automatic.id);record('报名重复提交幂等');
 const stranger=new Client();await stranger.call(`/api/applications/${automatic.id}`,{status:403});record('未授权不能读取他人申请');
 await client.call(`/api/applications/${automatic.id}/needs`,{method:'PUT',body:{topics:['N01','N02','N03','N04'],question:''},status:400});record('服务端阻止超过三个研修主题');
 const [first,second]=await Promise.all([client.call(`/api/applications/${automatic.id}/orders`,{method:'POST',body:{}}),client.call(`/api/applications/${automatic.id}/orders`,{method:'POST',body:{}})]);assert.equal(first.id,second.id);record('并发创建订单幂等');
 await client.call(`/api/applications/${automatic.id}/mock-payment`,{method:'POST',body:{orderId:first.id,result:'failure'}});const failed=await client.call(`/api/applications/${automatic.id}`);assert.equal(failed.ticket,undefined);record('支付失败不出票且保留重试入口');
 const success=await client.call(`/api/applications/${automatic.id}/mock-payment`,{method:'POST',body:{orderId:first.id,result:'success'}});assert.equal(success.application.ticket.members.length,4);
 const paymentAgain=await client.call(`/api/applications/${automatic.id}/mock-payment`,{method:'POST',body:{orderId:first.id,result:'success'}});assert.equal(paymentAgain.application.ticket.id,success.application.ticket.id);record('支付成功生成四成员票，重复确认只出票一次');
 const issued=success.application.ticket;const half=issued.members.slice(0,2).map(member=>member.id);
 const arrived=await admin.call('/api/admin/checkins',{method:'POST',body:{ticketId:issued.id,memberIds:half}});assert.equal(arrived.count,2);const partial=await admin.call(`/api/admin/tickets/resolve?token=${issued.token}`);assert.equal(partial.status,'PARTIALLY_USED');record('家庭分批入场，首次两人核销');
 const duplicate=await admin.call('/api/admin/checkins',{method:'POST',body:{ticketId:issued.id,memberIds:half}});assert.equal(duplicate.count,0);record('重复核销不重复计数');
 await admin.call('/api/admin/checkins',{method:'POST',body:{ticketId:issued.id,memberIds:issued.members.slice(2).map(member=>member.id)}});const full=await admin.call(`/api/admin/tickets/resolve?token=${issued.token}`);assert.equal(full.status,'FULLY_USED');record('第二批入场后整票完成核销');
 await admin.call(`/api/admin/orders/${first.id}/refund`,{method:'POST',body:{reason:'自动验收'},status:400});record('已入场订单不能直接退款');
 const {application:manual}=await submit({profile:{...payload.profile,asdAge:'<25',count:2,members:['父亲','母亲'],fourthMeal:false}});assert.equal(manual.status,'MANUAL_REVIEW');await client.call(`/api/applications/${manual.id}/orders`,{method:'POST',body:{},status:400});record('年龄与成员例外转人工，未通过不能付款');
 await admin.call(`/api/admin/applications/${manual.id}/decision`,{method:'POST',body:{status:'APPROVED',note:'自动验收：已确认参加安排'}});const manualOrder=await client.call(`/api/applications/${manual.id}/orders`,{method:'POST',body:{}});assert.equal(manualOrder.amount_cents,250000);record('人工批准回归相同订单接口');
 const manualPaid=await client.call(`/api/applications/${manual.id}/mock-payment`,{method:'POST',body:{orderId:manualOrder.id,result:'success'}});await admin.call(`/api/admin/orders/${manualOrder.id}/refund`,{method:'POST',body:{reason:'自动验收退款'}});await admin.call('/api/admin/checkins',{method:'POST',body:{ticketId:manualPaid.application.ticket.id,memberIds:[manualPaid.application.ticket.members[0].id]},status:400});record('退款后作废票据，禁止入场');
 const {application:organization}=await submit({type:'organization',profile:{count:1,members:['专业人士'],orgCategory:'医疗',orgName:'自动验收机构',orgRole:'工作人员',orgFocus:'照护研究'},topics:[]});assert.equal(organization.fee_cents,null);await client.call(`/api/applications/${organization.id}/orders`,{method:'POST',body:{},status:400});record('机构费用未核准时禁止付款');
 await admin.call(`/api/admin/applications/${organization.id}/decision`,{method:'POST',body:{status:'APPROVED',note:'自动验收：负责人核准免收费',feeCents:0}});const freeOrder=await client.call(`/api/applications/${organization.id}/orders`,{method:'POST',body:{}});assert.equal(freeOrder.amount_cents,0);record('机构独立审批零金额结算');
 const recovering=new Client();const recovered=await recovering.call('/api/lookup',{method:'POST',body:{code:automatic.code,recoveryKey:automatic.recoveryKey}});assert.equal(recovered[0].id,automatic.id);record('仅凭报名号可在另一设备找到报名记录');
 const needs=await admin.call('/api/admin/needs');assert(!JSON.stringify(needs).includes('自动验收测试'));record('需求汇总不暴露联系人信息');
 const jobs=await admin.call('/api/admin/jobs');assert(jobs.some(job=>job.kind==='webhook'&&created.includes(job.application_id)));record('人工审核提醒已持久化入队');
 const before=await admin.call('/api/admin/settings');
 await admin.call('/api/admin/settings',{method:'PUT',body:{...before,capacity:1},status:400});record('席位容量不能降至已售席位以下');
 const {application:exception,payload:exceptionPayload}=await submit({profile:{...payload.profile,asdAge:'<25'}});
 const supplemented=await client.call(`/api/applications/${exception.id}/supplement`,{method:'PUT',body:{...exceptionPayload,profile:{...exceptionPayload.profile,asdAge:'25–34'}}});assert.equal(supplemented.status,'APPROVED');record('待人工确认申请补充资料后重新运行规则');
 const [used]=await pool.query("SELECT COALESCE(SUM(seat_count),0) count FROM applications WHERE type='family' AND reserved_until>NOW()");
 await admin.call('/api/admin/settings',{method:'PUT',body:{...before,capacity:Number(used[0].count)+1}});
 try{
  const {application:waitlisted}=await submit({profile:{...payload.profile,count:2,members:['成年ASD本人','父亲']}});assert.equal(waitlisted.status,'WAITLIST');await client.call(`/api/applications/${waitlisted.id}/orders`,{method:'POST',body:{},status:400});record('席位不足自动候补并禁止创建付款订单');
 }finally{await admin.call('/api/admin/settings',{method:'PUT',body:before});}
 const loginName='checkin_test_'+crypto.randomBytes(4).toString('hex');const password='Test1'+crypto.randomBytes(12).toString('hex');
 await admin.call('/api/admin/users',{method:'POST',body:{username:loginName,password,role:'checkin'}});const checker=new Client();await checker.call('/api/admin/login',{method:'POST',body:{username:loginName,password}});await checker.call('/api/admin/applications',{status:403});await checker.call('/api/admin/orders',{status:403});record('现场核销账号不能访问完整报名或财务数据');
 await pool.execute('DELETE s FROM sessions s JOIN admin_users u ON u.id=s.user_id WHERE u.username=?',[loginName]);await pool.execute('DELETE FROM admin_users WHERE username=?',[loginName]);
 console.log(`共 ${results.length} 项集成验收通过。`);
}finally{
 // 只清理本次脚本创建且带专用标记的测试记录，保留审计轨迹。
 for(const id of created){
  const [records]=await pool.execute("SELECT id FROM applications WHERE id=? AND channel='自动验收测试'",[id]);
  if(!records.length)continue;
  await pool.execute('DELETE tm FROM ticket_members tm JOIN tickets ti ON ti.id=tm.ticket_id WHERE ti.application_id=?',[id]);
  await pool.execute('DELETE FROM tickets WHERE application_id=?',[id]);
  await pool.execute('DELETE FROM orders WHERE application_id=?',[id]);
  await pool.execute('DELETE FROM jobs WHERE application_id=?',[id]);
  await pool.execute('DELETE FROM applications WHERE id=?',[id]);
 }
 fs.writeFileSync(`work/集成验收结果_v4_${Date.now()}.json`,JSON.stringify({at:new Date().toISOString(),database:process.env.DB_NAME,results},null,2));await pool.end();
}
