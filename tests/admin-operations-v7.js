import 'dotenv/config';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {pool} from '../server/db.js';
import jsQR from 'jsqr';
import {PNG} from 'pngjs';
if(process.env.NODE_ENV!=='test'||!process.env.DB_NAME.startsWith('jzx_quality_'))throw new Error('只能在独立测试库中验证后台操作');
const origin=process.env.APP_ORIGIN,results=[];
class Client{
 cookies=new Map();
 async call(route,{method='GET',body,status=200}={}){
  const response=await fetch(origin+route,{method,headers:{'Content-Type':'application/json',Cookie:[...this.cookies].map(([name,value])=>`${name}=${value}`).join('; ')},body:body===undefined?undefined:JSON.stringify(body)});
  for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],separator=pair.indexOf('=');this.cookies.set(pair.slice(0,separator),pair.slice(separator+1));}
  const data=await response.json();assert([status].flat().includes(response.status),`${route}: ${response.status} ${data.error||''}`);return {status:response.status,data};
 }
}
const admin=new Client(),visitor=new Client(),finance=new Client(),checkinUser=new Client();
const post=(client,route,body,status=200)=>client.call(route,{method:'POST',body,status});
const get=async(client,route,status=200)=>(await client.call(route,{status})).data;
const changePrice=(client,order,amountCents,expectedAmountCents=order.amount_cents,status=200,reason='已确认的测试优惠')=>client.call(`/api/admin/orders/${order.id}/price`,{method:'PUT',body:{amountCents,expectedAmountCents,reason},status});
async function submit(name='后台功能验收',options={}){
 const application=(await post(visitor,'/api/applications',{type:'family',name,mobile:'137'+crypto.randomInt(10000000,99999999),idempotencyKey:crypto.randomUUID(),profile:{relationship:'父母',asdAge:'25–34',parentAge:'50–59',count:3,members:['成年ASD本人','父亲','母亲'],fourthMeal:false},topics:['N01'],question:'不应出现在核销名单的私人问题',consent:{privacy:true,sensitive:true,payment:true,model:false},channel:'v7独立测试',...options})).data;
 return application;
}
async function createOrder(application){return (await post(visitor,`/api/applications/${application.code}/orders`,{})).data;}
async function pay(application,order,amount=order.amount_cents,status=200){return post(visitor,`/api/applications/${application.code}/mock-payment`,{orderId:order.id,result:'success',expectedAmountCents:amount},status);}
async function check(name,work){try{await work();results.push({name,passed:true});console.log('通过：'+name);}catch(error){results.push({name,passed:false,error:error.message});throw error;}}
let configuration,application,order,paidTicket;
try{
 const health=await get(visitor,'/api/health');assert.equal(health.testDatabase,process.env.DB_NAME);
 await post(admin,'/api/admin/login',{username:process.env.ADMIN_USER,password:process.env.ADMIN_PASSWORD});
 configuration=await get(admin,'/api/admin/settings');
 await check('工作账号支持六位字母数字密码和七十二位密码，创建后可登录',async()=>{
  for(const password of ['abc123','A1'+'a'.repeat(70)]){
   const username='password_'+crypto.randomBytes(4).toString('hex'),client=new Client();
   await post(admin,'/api/admin/users',{username,password,role:'checkin'});
   await post(client,'/api/admin/login',{username,password});
   assert.equal((await get(client,'/api/admin/me')).role,'checkin');
  }
 });
 await check('拒绝过短、过长、缺少字母或数字、含特殊符号的密码',async()=>{
  for(const password of ['ab123','A1'+'a'.repeat(71),'123456','abcdef','abc12!','abc 12','中文abc123',null]){
   const result=await post(admin,'/api/admin/users',{username:'invalid_password',password,role:'checkin'},400);
   assert.match(result.data.error,/6–72/);
  }
 });

 for(const [role,client] of [['finance',finance],['checkin',checkinUser]]){
  const username=`v7_${role}_${crypto.randomBytes(3).toString('hex')}`,password='Work123';
  await post(admin,'/api/admin/users',{username,password,role});await post(client,'/api/admin/login',{username,password});
 }
 application=await submit('待改价验收');order=await createOrder(application);
 await check('未登录及非管理员不能修改订单价格',async()=>{await changePrice(visitor,order,180050,order.amount_cents,401);await changePrice(finance,order,180050,order.amount_cents,403);await changePrice(checkinUser,order,180050,order.amount_cents,403);});
 await check('拒绝非法金额、无效旧金额和空改价原因',async()=>{
  for(const amount of [-1,10000001,0.1,'180000',null])await changePrice(admin,order,amount,order.amount_cents,400);
  await admin.call(`/api/admin/orders/${order.id}/price`,{method:'PUT',body:{amountCents:170000,reason:'遗漏旧金额测试'},status:400});
  await changePrice(admin,order,170000,null,400);await changePrice(admin,order,170000,250000,400,'   ');
 });
 await check('待支付订单支持分为单位的改价，并同步用户应付金额',async()=>{
  await changePrice(admin,order,168899);
  const current=await get(visitor,`/api/applications/${application.code}`);
  assert.equal(current.fee_cents,168899);assert.equal(current.orders[0].amount_cents,168899);assert.equal(current.orders[0].status,'PAY_PENDING');
  order.amount_cents=168899;
 });
 await check('旧页面不能覆盖其他管理员已修改的价格',async()=>{await changePrice(admin,order,160000,250000,409);assert.equal((await get(visitor,`/api/applications/${application.code}`)).fee_cents,168899);});
 await check('价格变更记录包含操作人、原金额、新金额和原因',async()=>{const [logs]=await pool.execute("SELECT * FROM audit_logs WHERE action='ORDER_PRICE_CHANGED' AND target=? ORDER BY id DESC",[order.id]);assert(logs.length);assert.equal(logs[0].actor,process.env.ADMIN_USER);assert.equal(logs[0].detail.previousAmountCents,250000);assert.equal(logs[0].detail.amountCents,168899);assert.equal(logs[0].detail.reason,'已确认的测试优惠');});
 await check('用户持旧金额付款时要求重新核对，不提前出票',async()=>{await pay(application,order,250000,409);const current=await get(visitor,`/api/applications/${application.code}`);assert.equal(current.ticket,undefined);assert.equal(current.orders[0].status,'PAY_PENDING');});
 await check('用户按新金额付款后出票，已支付订单不能再改价',async()=>{const result=await pay(application,order);paidTicket=result.data.application.ticket;assert.equal(result.data.application.orders[0].amount_cents,168899);assert.equal(paidTicket.members.length,3);await changePrice(admin,order,100000,168899,409);});
 await check('零金额订单可以正常结算出票',async()=>{const record=await submit('免收费验收'),zeroOrder=await createOrder(record);await changePrice(admin,zeroOrder,0);const result=await pay(record,zeroOrder,0);assert.equal(result.data.application.orders[0].amount_cents,0);assert(result.data.application.ticket);});
 await check('已关闭、已退款及活动结束订单不能改价',async()=>{
  const closed=await submit('关闭订单验收'),closedOrder=await createOrder(closed);
  await post(admin,`/api/admin/applications/${closed.id}/decision`,{status:'NEED_INFO',note:'测试关闭待付订单'});await changePrice(admin,closedOrder,100000,closedOrder.amount_cents,409);
  const refunded=await submit('退款订单验收'),refundOrder=await createOrder(refunded);await pay(refunded,refundOrder);await post(admin,`/api/admin/orders/${refundOrder.id}/refund`,{reason:'测试退款'});await changePrice(admin,refundOrder,100000,refundOrder.amount_cents,409);
  const expired=await submit('过期订单验收'),expiredOrder=await createOrder(expired);
  try{await pool.execute('UPDATE event_settings SET config=? WHERE id=1',[JSON.stringify({...configuration,endsAt:'2020-01-01 00:00:00'})]);await changePrice(admin,expiredOrder,100000,expiredOrder.amount_cents,409);}finally{await pool.execute('UPDATE event_settings SET config=? WHERE id=1',[JSON.stringify(configuration)]);}
 });
 await check('改价和付款同时提交时，最终收款与报名费用保持一致',async()=>{
  const record=await submit('并发改价验收'),raceOrder=await createOrder(record);
  const outcomes=await Promise.all([changePrice(admin,raceOrder,180000,250000,[200,409]),pay(record,raceOrder,250000,[200,409])]);
  assert.equal(outcomes.filter(result=>result.status===200).length,1);
  let current=await get(visitor,`/api/applications/${record.code}`);assert.equal(current.fee_cents,current.orders[0].amount_cents);
  if(current.orders[0].status==='PAY_PENDING')await pay(record,raceOrder,current.orders[0].amount_cents);
  current=await get(visitor,`/api/applications/${record.code}`);assert.equal(current.orders[0].status,'PAID');assert(current.ticket);
 });
 await check('手动核销名单仅管理员可以查看',async()=>{await get(visitor,'/api/admin/checkin-list',401);await get(finance,'/api/admin/checkin-list',403);await get(checkinUser,'/api/admin/checkin-list',403);});
 await check('核销名单显示报名用户、完整手机号和进度，不暴露问题与画像',async()=>{
  const result=await get(admin,'/api/admin/checkin-list?search='+application.code);assert.equal(result.total,1);const record=result.records[0];assert.equal(record.name,application.name);assert.equal(record.mobile,application.mobile);assert.equal(record.checked_count,0);assert.equal(record.ticket_status,'VALID');assert(!Object.hasOwn(record,'profile'));assert(!Object.hasOwn(record,'question'));
 });
 await check('核销名单支持姓名、电话、报名号和分页查找',async()=>{
  for(const search of [application.name,application.mobile,application.code])assert((await get(admin,'/api/admin/checkin-list?search='+encodeURIComponent(search))).records.some(record=>record.code===application.code));
  const first=await get(admin,'/api/admin/checkin-list?pageSize=1&page=1'),second=await get(admin,'/api/admin/checkin-list?pageSize=1&page=2');assert(first.total>1);assert.notEqual(first.records[0].id,second.records[0].id);
  await get(admin,'/api/admin/checkin-list?pageSize=201',400);await get(admin,'/api/admin/checkin-list?status=bad',400);
 });
 await check('未出票用户保留在报名名单，不能伪造票据核销',async()=>{
  const record=await submit('尚未出票验收');const list=await get(admin,'/api/admin/checkin-list?status=unpaid&search='+record.code);assert.equal(list.total,1);assert.equal(list.records[0].ticket_id,null);
  await post(admin,'/api/admin/checkins',{ticketId:record.id,memberIds:[crypto.randomUUID()],source:'manual'},400);
 });
 const body={ticketId:paidTicket.id,memberIds:[paidTicket.members[0].id],source:'manual'};
 await check('核销员不能伪装管理员发起列表手动核销',async()=>{await post(checkinUser,'/api/admin/checkins',body,403);});
 await check('从名单核销部分成员后进度和筛选同步更新',async()=>{
  const result=(await post(admin,'/api/admin/checkins',body)).data;assert.equal(result.count,1);assert.equal(result.totalUsed,1);
  const list=await get(admin,'/api/admin/checkin-list?status=partial&search='+application.code);assert.equal(list.total,1);assert.equal(list.records[0].checked_count,1);
  assert.equal((await get(admin,'/api/admin/checkin-list?status=ready&search='+application.code)).total,0);
 });
 await check('手动核销重复请求不会重复计数',async()=>{const result=(await post(admin,'/api/admin/checkins',body)).data;assert.equal(result.count,0);assert.equal(result.totalUsed,1);});
 await check('剩余成员继续核销，全部已核销筛选正确',async()=>{const result=(await post(admin,'/api/admin/checkins',{...body,memberIds:paidTicket.members.slice(1).map(member=>member.id)})).data;assert.equal(result.count,2);assert.equal(result.totalUsed,3);const list=await get(admin,'/api/admin/checkin-list?status=used&search='+application.code);assert.equal(list.total,1);assert.equal(list.records[0].checked_count,3);});
 await check('手动核销记录来源、工作人员和成员时间',async()=>{const [logs]=await pool.execute("SELECT * FROM audit_logs WHERE action='CHECKIN' AND target=? ORDER BY id DESC",[paidTicket.id]);assert.equal(logs[0].detail.source,'manual');const [members]=await pool.execute('SELECT checked_by,checked_at FROM ticket_members WHERE ticket_id=?',[paidTicket.id]);assert(members.every(member=>member.checked_by===process.env.ADMIN_USER&&member.checked_at));});

 await check('历史活动配置未填费用时返回原有默认价格',async()=>{
  const current=await get(admin,'/api/admin/settings');assert.equal(current.familyFeeCents,250000);assert.equal(current.extraMealFeeCents,2500);
 });
 await check('只有管理员可以更改家庭费用配置',async()=>{
  for(const client of [finance,checkinUser])await client.call('/api/admin/settings',{method:'PUT',body:{...configuration,familyFeeCents:188888,extraMealFeeCents:3501},status:403});
 });
 await check('家庭费用配置拒绝负数、小数分和过大金额',async()=>{
  for(const field of ['familyFeeCents','extraMealFeeCents'])for(const invalid of [-1,1.5,10000001,'250000',null])await admin.call('/api/admin/settings',{method:'PUT',body:{...configuration,[field]:invalid},status:400});
 });
 const originalPending=await submit('费用更新前申请'),originalPendingOrder=await createOrder(originalPending);
 await check('后台保存配置后公开活动接口同步返回新费用',async()=>{
  await admin.call('/api/admin/settings',{method:'PUT',body:{...configuration,familyFeeCents:188888,extraMealFeeCents:3501}});
  const current=await get(visitor,'/api/event');assert.equal(current.familyFeeCents,188888);assert.equal(current.extraMealFeeCents,3501);
 });
 await check('新家庭按基础费用和第四人用餐配置计费，客户端金额无效',async()=>{
  const three=await submit('新版基础费验收');assert.equal(three.fee_cents,188888);
  for(const fourthMeal of [true,false]){
   const record=await submit('新版第四人费用验收',{profile:{...three.profile,count:4,members:['成年ASD本人','父亲','母亲','亲属'],fourthMeal},fee_cents:1});
   assert.equal(record.fee_cents,fourthMeal?192389:188888);assert.equal((await createOrder(record)).amount_cents,record.fee_cents);
  }
 });
 await check('费用配置更新不改变已有待支付、已支付订单或管理员改价',async()=>{
  const pending=await get(visitor,`/api/applications/${originalPending.code}`);assert.equal(pending.fee_cents,250000);assert.equal(pending.orders[0].amount_cents,250000);
  const paid=await get(visitor,`/api/applications/${application.code}`);assert.equal(paid.orders[0].amount_cents,168899);
  await changePrice(admin,originalPendingOrder,123456);
  await admin.call('/api/admin/settings',{method:'PUT',body:{...configuration,familyFeeCents:200000,extraMealFeeCents:4000}});
  assert.equal((await get(visitor,`/api/applications/${originalPending.code}`)).fee_cents,123456);
 });
 await check('待审家庭补充资料后使用当前费用重新计算',async()=>{
  const original=await submit('补充资料费用验收',{profile:{relationship:'父母',asdAge:'<25',parentAge:'50–59',count:3,members:['成年ASD本人','父亲','母亲'],fourthMeal:false}});
  await admin.call('/api/admin/settings',{method:'PUT',body:{...configuration,familyFeeCents:155500,extraMealFeeCents:5000}});
  const result=await visitor.call(`/api/applications/${original.code}/supplement`,{method:'PUT',body:{type:'family',name:original.name,mobile:original.mobile,idempotencyKey:original.id,profile:{...original.profile,asdAge:'25–34'},topics:['N01'],question:'',consent:{privacy:true,sensitive:true,payment:true,model:false},channel:'费用验收'}});
  assert.equal(result.data.fee_cents,155500);
 });
 await check('零元费用配置生效，旧版保存请求不抹除已配价格',async()=>{
  await admin.call('/api/admin/settings',{method:'PUT',body:{...configuration,familyFeeCents:0,extraMealFeeCents:0}});
  const {familyFeeCents,extraMealFeeCents,...legacyConfiguration}=configuration;
  await admin.call('/api/admin/settings',{method:'PUT',body:legacyConfiguration});
  const record=await submit('零元家庭配置验收');assert.equal(record.fee_cents,0);assert.equal((await createOrder(record)).amount_cents,0);
 });

 await check('活动子目录下页面、接口和前端资源均可访问',async()=>{
  for(const route of ['/apply','/lookup','/admin','/checkin','/promo/','/styles.css','/registration.js','/admin.js','/promo/app.js','/vendor/jsQR.js'])assert.equal((await fetch(origin+'/shanghai2026'+route)).status,200,route);
  assert.equal((await get(visitor,'/shanghai2026/api/event')).title,configuration.title);
  assert.equal((await get(admin,'/shanghai2026/api/admin/me')).role,'admin');
 });
 await check('子目录入口和补斜杠跳转保留活动前缀',async()=>{
  for(const [route,destination] of [['/shanghai2026','/shanghai2026/'],['/shanghai2026/','/shanghai2026/promo/'],['/shanghai2026/promo','/shanghai2026/promo/'],['/shanghai2026/lookup/','/shanghai2026/lookup']]){
   const response=await fetch(origin+route,{redirect:'manual'});assert([301,302,308].includes(response.status));assert.equal(response.headers.get('location'),destination);
  }
 });
 await check('子目录可报名、生成订单并付款出票，二维码仍指向子目录',async()=>{
  const record=(await post(visitor,'/shanghai2026/api/applications',{type:'family',name:'子目录报名验收',mobile:'138'+crypto.randomInt(10000000,99999999),idempotencyKey:crypto.randomUUID(),profile:{relationship:'父母',asdAge:'25–34',parentAge:'50–59',count:4,members:['成年ASD本人','父亲','母亲','亲属'],fourthMeal:true},topics:['N01'],question:'',consent:{privacy:true,sensitive:true,payment:true,model:false},channel:'子目录验收'})).data;
  const order=(await post(visitor,`/shanghai2026/api/applications/${record.code}/orders`,{})).data;
  const result=(await post(visitor,`/shanghai2026/api/applications/${record.code}/mock-payment`,{orderId:order.id,result:'success',expectedAmountCents:order.amount_cents})).data;
  const png=PNG.sync.read(Buffer.from(result.application.ticket.qr.split(',')[1],'base64'));
  const decoded=jsQR(new Uint8ClampedArray(png.data),png.width,png.height);
  assert(decoded.data.startsWith(origin+'/shanghai2026/checkin?ticket='));
  const candidates=await get(admin,'/shanghai2026/api/admin/tickets/search?query='+encodeURIComponent(decoded.data));assert.equal(candidates[0].code,record.code);
 });
 fs.writeFileSync('.local/qa-fixtures-v7.json',JSON.stringify({application,order,paidTicket}));
 console.log(`后台改价与手动核销通过 ${results.length} 项。`);
}finally{
 if(configuration)await pool.execute('UPDATE event_settings SET config=? WHERE id=1',[JSON.stringify(configuration)]);
 fs.writeFileSync(`work/后台改价与手动核销测试_v7_${Date.now()}.json`,JSON.stringify({database:process.env.DB_NAME,results},null,2));await pool.end();
}
