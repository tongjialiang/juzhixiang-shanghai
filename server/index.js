import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import {rateLimit} from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import QRCode from 'qrcode';
import {registrationLink} from './registration-link.js';
import {pool,transaction,audit} from './db.js';
import {applicationSchema,reviewApplication,familyAmount,defaultFamilyPricing,topicNames,organizationCategories,deidentify} from './rules.js';
const app=express();
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const token=()=>crypto.randomBytes(32).toString('base64url');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const secure=process.env.NODE_ENV==='production';
// 测试环境与开发环境可能在同一主机的不同端口打开，浏览器 Cookie 不按端口隔离。
const sessionCookieName=process.env.NODE_ENV==='test'?`admin_session_test_${process.env.PORT}`:'admin_session';
if(secure&&process.env.PAYMENT_MODE==='mock')throw new Error('生产环境不能启用模拟支付');
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'data:'],upgradeInsecureRequests:secure?[]:null}}}));
app.use(express.json({limit:'100kb'}));app.use(cookieParser(process.env.SESSION_SECRET));
app.use('/api',(request,response,next)=>{
 if(['POST','PUT','PATCH'].includes(request.method)&&(!request.body||typeof request.body!=='object'||Array.isArray(request.body)))return next(fail('请求内容不正确，请刷新页面后重试'));
 next();
});
app.use('/api',rateLimit({windowMs:60_000,limit:180,message:{error:'操作较频繁，请稍后再试'}}));
app.use('/api',(request,response,next)=>{
 response.set('Cache-Control','no-store');
 if(!['GET','HEAD','OPTIONS'].includes(request.method)&&request.headers.origin){
  let sameOrigin=false;try{sameOrigin=new URL(request.headers.origin).host===request.get('host')&&['http:','https:'].includes(new URL(request.headers.origin).protocol);}catch{}
  if(!sameOrigin)return next(fail('请求来源不正确',403));
 }
 next();
});
function eventEnd(configuration){return configuration.endsAt||`${configuration.date} 23:59:59`;}
function eventEnded(configuration){return Date.now()>=new Date(eventEnd(configuration).replace(' ','T')+'+08:00').getTime();}
function requestOrigin(request){return request?`${request.protocol}://${request.get('host')}`:process.env.APP_ORIGIN;}

const cookieOptions={httpOnly:true,sameSite:'strict',secure,signed:true,maxAge:30*24*3600_000};
async function settings(connection=pool){const [rows]=await connection.query('SELECT config FROM event_settings WHERE id=1');return {...defaultFamilyPricing,organizationFeeCents:150000,...rows[0].config,endsAt:eventEnd(rows[0].config)};}
async function lockEvent(connection){await connection.query('SELECT id FROM event_settings WHERE id=1 FOR UPDATE');}
async function cleanup(connection){
 const configuration=await settings(connection),end=eventEnd(configuration);
 await connection.execute("UPDATE orders SET expires_at=?,status=IF(?<=NOW(),'EXPIRED','PAY_PENDING') WHERE status='PAY_PENDING'",[end,end]);
 await connection.execute("UPDATE applications ap JOIN orders o ON o.application_id=ap.id SET ap.reserved_until=? WHERE ap.status='APPROVED' AND o.status='PAY_PENDING'",[end]);
 await connection.query("UPDATE applications ap LEFT JOIN tickets ti ON ti.application_id=ap.id SET ap.reserved_until=NULL WHERE ap.reserved_until<NOW() AND ti.id IS NULL");
}

async function reserve(connection,application,configuration){
 if(eventEnded(configuration))return false;
 const [usage]=await connection.execute("SELECT COALESCE(SUM(seat_count),0) used FROM applications WHERE type=? AND id<>? AND reserved_until>NOW()",[application.type,application.id]);
 const maximum=application.type==='family'?configuration.capacity:configuration.organizationCapacity;
 if(Number(usage[0].used)+application.seat_count>maximum)return false;
 await connection.execute('UPDATE applications SET reserved_until=? WHERE id=?',[eventEnd(configuration),application.id]);return true;
}
async function findApplication(request,connection=pool){
 const [rows]=await connection.execute('SELECT * FROM applications WHERE id=? OR code=?',[String(request.params.id).trim(),String(request.params.id).trim().toUpperCase()]);
 const application=rows[0];const receipt=request.signedCookies[`receipt_${application?.id}`];
 if(application&&application.code===String(request.params.id).trim().toUpperCase())return application;
 if(!application||!receipt||!await validAccess(connection,application,receipt))throw fail('请通过报名号查询，或先在查询页面按姓名、手机号找到记录',403);
 return application;
}
async function validAccess(connection,application,receipt){
 if(typeof receipt!=='string'||receipt.length>100)return false;
 if(hash(receipt)===application.access_hash)return true;
 const [sessions]=await connection.execute('SELECT token_hash FROM application_access WHERE application_id=? AND token_hash=? AND expires_at>NOW()',[application.id,hash(receipt)]);
 return sessions.length>0;
}
async function publicApplication(application,request){
 const end=eventEnd(await settings());
 await pool.execute("UPDATE orders SET expires_at=?,status=IF(?<=NOW(),'EXPIRED','PAY_PENDING') WHERE application_id=? AND status='PAY_PENDING'",[end,end,application.id]);
 const [orders]=await pool.execute('SELECT * FROM orders WHERE application_id=? ORDER BY created_at DESC',[application.id]);
 const [tickets]=await pool.execute('SELECT * FROM tickets WHERE application_id=?',[application.id]);
 const ticket=tickets[0];
 if(ticket){const [members]=await pool.execute('SELECT * FROM ticket_members WHERE ticket_id=? ORDER BY slot',[ticket.id]); ticket.members=members;ticket.qr=await QRCode.toDataURL(`${requestOrigin(request)}${request.baseUrl||''}/checkin?ticket=${encodeURIComponent(ticket.token)}`,{width:300,margin:2});}
 return {id:application.id,code:application.code,type:application.type,name:application.name,mobile:application.mobile,status:application.status,review_source:application.review_source,next_step:application.status==='NEED_INFO'?application.reasons.join('；'):'',profile:application.profile,topics:application.topics,question:application.question,consent:application.consent,orders,ticket,created_at:application.created_at,reserved_until:application.reserved_until,fee_cents:application.fee_cents};
}
async function adminAuth(request,response,next){try{
 const session=request.signedCookies[sessionCookieName];
 if(!session)throw fail('请先登录运营后台',401);
 const [rows]=await pool.execute('SELECT u.id,u.username,u.role FROM sessions s JOIN admin_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>NOW()',[hash(session)]);
 if(!rows[0])throw fail('登录已过期，请重新登录',401);request.admin=rows[0];next();
 }catch(error){next(error);}}
const roles=(...allowed)=>(request,response,next)=>allowed.includes(request.admin.role)?next():next(fail('当前账号没有操作权限',403));

app.get('/api/health',async(request,response)=>{await pool.query('SELECT 1');response.json({ok:true,database:'mysql',payment:process.env.PAYMENT_MODE,...(process.env.NODE_ENV==='test'?{testDatabase:process.env.DB_NAME}:{})});});
app.get('/api/event',async(request,response)=>{response.json({...await settings(),topicNames,organizationCategories,paymentMode:process.env.PAYMENT_MODE});});
app.get('/api/registration-qr.svg',async(request,response)=>{
 const destination=registrationLink(requestOrigin(request),request.baseUrl,process.env.APP_ORIGIN);
 const image=await QRCode.toString(destination,{type:'svg',width:220,margin:2});
 response.type('image/svg+xml').send(image);
});
app.post('/api/applications',async(request,response)=>{
 const parsed=applicationSchema.safeParse(request.body);if(!parsed.success)throw fail('报名资料不完整或格式不正确，请核对手机号、年龄段、人数、研修主题及必选授权');
 const data=parsed.data;const receipt=token();
 const application=await transaction(async connection=>{
  await lockEvent(connection);await cleanup(connection);const configuration=await settings(connection);
  if(!configuration.registrationOpen)throw fail('报名暂未开放，请稍后再来');
  if(eventEnded(configuration))throw fail('本次活动已结束，报名已关闭');
  const [previous]=await connection.execute('SELECT * FROM applications WHERE id=?',[data.idempotencyKey]);
  if(previous[0]){const existingReceipt=request.signedCookies[`receipt_${previous[0].id}`];if(previous[0].mobile!==data.mobile&&(!existingReceipt||!await validAccess(connection,previous[0],existingReceipt)))throw fail('该申请已提交，请通过查询入口找回');return {...previous[0],existing:true};}
  const [duplicates]=await connection.execute("SELECT id,code FROM applications WHERE mobile=? AND type=? AND status<>'CANCELLED'",[data.mobile,data.type]);
  if(duplicates.length)throw fail('该手机号已有申请，请前往“查询报名”查看，避免重复报名');
  const decision=reviewApplication(data);const id=data.idempotencyKey;const code='JZX'+crypto.randomBytes(5).toString('hex').toUpperCase();
  const amount=data.type==='family'&&data.profile.count<=4?familyAmount(data.profile,configuration):null;
  await connection.execute(`INSERT INTO applications(id,code,access_hash,type,name,mobile,status,review_source,reasons,profile,topics,question,consent,channel,seat_count,fee_cents,fee_authorized) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,code,hash(receipt),data.type,data.name,data.mobile,decision.status,decision.source,JSON.stringify(decision.reasons),JSON.stringify(data.profile),JSON.stringify(data.topics),data.question,JSON.stringify({...data.consent,version:'v1-20261103',at:new Date().toISOString()}),data.channel,data.profile.count,amount,data.type==='family'&&data.profile.count<=4]);
  let status=decision.status;
  if(status==='APPROVED'&&!await reserve(connection,{id,type:data.type,seat_count:data.profile.count},configuration)){status='WAITLIST';await connection.execute("UPDATE applications SET status='WAITLIST',review_source=NULL WHERE id=?",[id]);}
  if(status==='MANUAL_REVIEW'||status==='WAITLIST')await connection.execute("INSERT INTO jobs(application_id,kind) VALUES(?,'webhook')",[id]);
  await connection.execute("INSERT INTO jobs(application_id,kind) VALUES(?,'analysis')",[id]);
  await audit(connection,'applicant','SUBMIT',id,{rule:decision.version,status,reasons:decision.reasons,consentVersion:'v1-20261103'});
  const [rows]=await connection.execute('SELECT * FROM applications WHERE id=?',[id]);return rows[0];
 });
 if(!application.existing)response.cookie(`receipt_${application.id}`,receipt,cookieOptions);
 response.json(await publicApplication(application,request));
});
app.post('/api/lookup',rateLimit({windowMs:60_000,limit:30,message:{error:'查询较频繁，请稍后再试'}}),async(request,response)=>{
 const query=String(request.body.query||request.body.code||request.body.mobile||request.body.name||'').trim();
 if(!query||query.length>100)throw fail('请输入报名号、完整姓名或完整手机号');
 const [rows]=await pool.execute('SELECT id,code,type,name,mobile,status,seat_count,created_at FROM applications WHERE code=? OR mobile=? OR name=? ORDER BY created_at DESC LIMIT 50',[query.toUpperCase(),query,query]);
 response.json(rows);
});
app.get('/api/applications/:id',async(request,response)=>{response.json(await publicApplication(await findApplication(request),request));});
app.put('/api/applications/:id/supplement',async(request,response)=>{
 const owned=await findApplication(request);
 const parsed=applicationSchema.safeParse({...request.body,type:owned.type,mobile:owned.mobile,idempotencyKey:owned.id});
 if(!parsed.success)throw fail('补充资料不完整，请核对必填信息和参加成员');
 const data=parsed.data;
 await transaction(async connection=>{
  await lockEvent(connection);await cleanup(connection);const configuration=await settings(connection);
  const [rows]=await connection.execute('SELECT * FROM applications WHERE id=? FOR UPDATE',[owned.id]);const current=rows[0];
  if(!['MANUAL_REVIEW','NEED_INFO','WAITLIST'].includes(current.status))throw fail('当前状态不能直接修改参加资料，请联系工作人员');
  const decision=reviewApplication(data);let status=decision.status;
  await connection.execute('UPDATE applications SET reserved_until=NULL,seat_count=? WHERE id=?',[data.profile.count,owned.id]);
  if(status==='APPROVED'&&!await reserve(connection,{id:owned.id,type:owned.type,seat_count:data.profile.count},await settings(connection)))status='WAITLIST';
  await connection.execute('UPDATE applications SET name=?,profile=?,topics=?,question=?,consent=?,seat_count=?,status=?,review_source=?,reasons=?,fee_cents=?,fee_authorized=?,analysis=NULL WHERE id=?',[data.name,JSON.stringify(data.profile),JSON.stringify(data.topics),data.question,JSON.stringify({...data.consent,version:'v1-20261103',at:new Date().toISOString()}),data.profile.count,status,status==='APPROVED'?'AUTO':null,JSON.stringify(decision.reasons),owned.type==='family'&&data.profile.count<=4?familyAmount(data.profile,configuration):null,owned.type==='family'&&data.profile.count<=4,owned.id]);
  for(const kind of status==='APPROVED'?['analysis']:['analysis','webhook'])await connection.execute("INSERT INTO jobs(application_id,kind) VALUES(?,?) ON DUPLICATE KEY UPDATE status='PENDING',attempts=0,generation=generation+1,next_at=NOW()",[owned.id,kind]);
  await audit(connection,'applicant','SUPPLEMENT',owned.id,{status,rule:decision.version});
 });response.json(await publicApplication(await findApplication(request),request));
});
app.put('/api/applications/:id/needs',async(request,response)=>{
 const application=await findApplication(request);const {topics,question=''}=request.body;
 if(!Array.isArray(topics)||(application.type==='family'&&!topics.length)||topics.length>3||new Set(topics).size!==topics.length||topics.some(topic=>typeof topic!=='string'||!/^N0[1-8]$/.test(topic))||typeof question!=='string'||question.length>300)throw fail('请选择最多 3 个有效主题，问题不超过 300 字');
 await transaction(async connection=>{await connection.execute('UPDATE applications SET topics=?,question=?,analysis=NULL WHERE id=?',[JSON.stringify(topics),question,application.id]);await connection.execute("INSERT INTO jobs(application_id,kind) VALUES(?,'analysis') ON DUPLICATE KEY UPDATE status='PENDING',attempts=0,generation=generation+1,next_at=NOW()",[application.id]);await audit(connection,'applicant','UPDATE_NEEDS',application.id);});response.json({ok:true});
});
app.post('/api/applications/:id/orders',async(request,response)=>{
 const owned=await findApplication(request);
 const order=await transaction(async connection=>{
  await lockEvent(connection);await cleanup(connection);const configuration=await settings(connection);
  const [rows]=await connection.execute('SELECT * FROM applications WHERE id=? FOR UPDATE',[owned.id]);const application=rows[0];
  if(application.status!=='APPROVED')throw fail('申请通过审核后才能生成订单');
  if(!application.fee_authorized||application.fee_cents===null)throw fail('费用尚未核准，请等待工作人员确认');
  if(eventEnded(configuration))throw fail('本次活动已结束，不能再创建订单');
  if(!configuration.legalConfirmed&&process.env.PAYMENT_MODE!=='mock')throw fail('正式收款条款尚未确认');
  const [existing]=await connection.execute("SELECT * FROM orders WHERE application_id=? AND status IN ('PAID','PAY_PENDING') ORDER BY created_at DESC",[application.id]);if(existing[0])return existing[0];
  if(!await reserve(connection,application,configuration))throw fail('当前名额已满，请联系工作人员安排候补',409);
  const id=crypto.randomUUID();await connection.execute("INSERT INTO orders(id,application_id,amount_cents,status,expires_at,provider) VALUES(?,?,?,'PAY_PENDING',?,?)",[id,application.id,application.fee_cents,eventEnd(configuration),process.env.PAYMENT_MODE]);await audit(connection,'applicant','CREATE_ORDER',id,{amount:application.fee_cents});const [orders]=await connection.execute('SELECT * FROM orders WHERE id=?',[id]);return orders[0];
 });response.json(order);
});
app.post('/api/applications/:id/mock-payment',async(request,response)=>{
 if(process.env.PAYMENT_MODE!=='mock'||secure)throw fail('模拟支付已关闭',404);
 const owned=await findApplication(request);const {orderId,result}=request.body;
 let settledResult=result;
 if(!['success','failure'].includes(result))throw fail('请选择模拟支付结果');
 await transaction(async connection=>{
  await lockEvent(connection);await cleanup(connection);const [rows]=await connection.execute('SELECT * FROM orders WHERE id=? AND application_id=? FOR UPDATE',[orderId,owned.id]);const order=rows[0];
  if(!order)throw fail('订单不存在',404);if(order.status==='PAID'){settledResult='success';return;}if(order.status!=='PAY_PENDING')throw fail('订单已过期或关闭，请重新生成');
  const [applications]=await connection.execute('SELECT * FROM applications WHERE id=? FOR UPDATE',[owned.id]);const application=applications[0];
  if(application.status!=='APPROVED')throw fail('当前申请不能付款');
  if(result==='success'&&request.body.expectedAmountCents!==undefined&&request.body.expectedAmountCents!==order.amount_cents)throw fail('订单金额已调整，请刷新页面，核对最新金额后再付款',409);
  if(result==='failure'){await audit(connection,'applicant','MOCK_PAYMENT_FAILURE',order.id);return;}
  await connection.execute("UPDATE orders SET status='PAID',paid_at=NOW() WHERE id=?",[order.id]);
  await connection.execute('UPDATE applications SET reserved_until=? WHERE id=?',[eventEnd(await settings(connection)),owned.id]);
  const ticketId=crypto.randomUUID();await connection.execute('INSERT INTO tickets(id,application_id,order_id,token) VALUES(?,?,?,?)',[ticketId,owned.id,order.id,token()]);
  for(let index=0;index<application.seat_count;index++)await connection.execute('INSERT INTO ticket_members(id,ticket_id,slot,label) VALUES(?,?,?,?)',[crypto.randomUUID(),ticketId,index+1,application.profile.members[index]||`成员 ${index+1}`]);
  await audit(connection,'applicant','MOCK_PAYMENT_SUCCESS',order.id,{ticketId});
 });response.json({result:settledResult,application:await publicApplication(await findApplication(request),request)});
});
app.post('/api/admin/login',rateLimit({windowMs:15*60_000,limit:20,message:{error:'登录尝试过多，请稍后再试'}}),async(request,response)=>{
 const [rows]=await pool.execute('SELECT * FROM admin_users WHERE username=?',[String(request.body.username||'')]);const user=rows[0];
 if(!user||!await bcrypt.compare(String(request.body.password||''),user.password_hash))throw fail('账号或密码不正确',401);
 const session=token();await pool.execute('INSERT INTO sessions VALUES(?,?,DATE_ADD(NOW(),INTERVAL 8 HOUR))',[hash(session),user.id]);response.cookie(sessionCookieName,session,{...cookieOptions,maxAge:8*3600_000});response.json({username:user.username,role:user.role});
});
app.use('/api/admin',adminAuth);
app.get('/api/admin/me',(request,response)=>response.json(request.admin));
app.post('/api/admin/logout',async(request,response)=>{await pool.execute('DELETE FROM sessions WHERE token_hash=?',[hash(request.signedCookies[sessionCookieName])]);response.clearCookie(sessionCookieName);response.json({ok:true});});
app.get('/api/admin/dashboard',roles('admin','reviewer','finance','checkin'),async(request,response)=>{
 await transaction(async connection=>{await lockEvent(connection);await cleanup(connection);});
 const [applications]=await pool.query('SELECT type,status,COUNT(*) count,SUM(seat_count) seats FROM applications GROUP BY type,status');
 const [orders]=await pool.query('SELECT status,COUNT(*) count,SUM(amount_cents) amount FROM orders GROUP BY status');
 const [checkins]=await pool.query('SELECT COUNT(*) count FROM ticket_members WHERE checked_at IS NOT NULL');
 const [jobs]=await pool.query("SELECT kind,status,COUNT(*) count FROM jobs GROUP BY kind,status");
 const [recent]=await pool.query('SELECT actor,action,target,created_at FROM audit_logs ORDER BY id DESC LIMIT 8');
 const financialAccess=['admin','finance'].includes(request.admin.role);
 response.json({applications,orders:financialAccess?orders:orders.map(({amount,...order})=>order),financialAccess,checkins:checkins[0].count,jobs,recent:request.admin.role==='admin'?recent:[],settings:await settings()});
});
app.get('/api/admin/applications',roles('admin','reviewer'),async(request,response)=>{
 const search=String(request.query.search||'').slice(0,100),status=String(request.query.status||''),type=String(request.query.type||'');
 const [rows]=await pool.execute(`SELECT ap.*,o.status order_status,o.amount_cents,ti.status ticket_status FROM applications ap LEFT JOIN orders o ON o.id=(SELECT id FROM orders WHERE application_id=ap.id ORDER BY created_at DESC LIMIT 1) LEFT JOIN tickets ti ON ti.application_id=ap.id WHERE (ap.name LIKE ? OR ap.mobile LIKE ? OR ap.code LIKE ?) AND (?='' OR ap.status=?) AND (?='' OR ap.type=?) ORDER BY ap.created_at DESC LIMIT 300`,[`%${search}%`,`%${search}%`,`%${search}%`,status,status,type,type]);
 response.json(rows.map(({access_hash,...application})=>application));
});
app.post('/api/admin/applications/:id/decision',roles('admin','reviewer'),async(request,response)=>{
 const {status,note,feeCents}=request.body;
 if(!['APPROVED','NEED_INFO','WAITLIST','NOT_ADMITTED'].includes(status)||typeof note!=='string'||!note.trim()||note.length>500)throw fail('请选择处理结果并填写原因');
 await transaction(async connection=>{
  await lockEvent(connection);await cleanup(connection);const [rows]=await connection.execute('SELECT * FROM applications WHERE id=? FOR UPDATE',[request.params.id]);const application=rows[0];if(!application)throw fail('申请不存在',404);
  if(application.status==='CANCELLED')throw fail('该申请已取消，不能重新批准；请让申请人重新报名');
  const [paid]=await connection.execute("SELECT id FROM orders WHERE application_id=? AND status='PAID'",[application.id]);if(paid.length)throw fail('已付款申请请先走退款流程，不能直接改审核结果');
  if(status==='APPROVED'){
   if(!await reserve(connection,application,await settings(connection)))throw fail('名额不足，请安排候补');
   if(application.type==='organization'||application.seat_count>4){if(request.admin.role!=='admin'||!Number.isInteger(feeCents)||feeCents<0||feeCents>10000000)throw fail('机构或超四人费用须由负责人核准');await connection.execute('UPDATE applications SET fee_cents=?,fee_authorized=TRUE WHERE id=?',[feeCents,application.id]);}
  }else await connection.execute('UPDATE applications SET reserved_until=NULL WHERE id=?',[application.id]);
  await connection.execute('UPDATE applications SET status=?,review_source=?,reasons=? WHERE id=?',[status,status==='APPROVED'?'HUMAN':null,JSON.stringify([note]),application.id]);
  await connection.execute("UPDATE orders SET status='CLOSED' WHERE application_id=? AND status='PAY_PENDING'",[application.id]);
  await audit(connection,request.admin.username,'REVIEW_DECISION',application.id,{status,note,feeCents:feeCents??null});
 });response.json({ok:true});
});
app.get('/api/admin/orders',roles('admin','finance'),async(request,response)=>{
 const [rows]=await pool.query('SELECT o.*,ap.code,ap.name,ap.type,ti.status ticket_status FROM orders o JOIN applications ap ON ap.id=o.application_id LEFT JOIN tickets ti ON ti.order_id=o.id ORDER BY o.created_at DESC LIMIT 300');response.json(rows);
});
app.put('/api/admin/orders/:id/price',roles('admin'),async(request,response)=>{
 const {amountCents,expectedAmountCents,reason}=request.body;
 if(!Number.isSafeInteger(amountCents)||amountCents<0||amountCents>10000000)throw fail('订单金额须为 0 至 100000 元，最多两位小数');
 if(!Number.isSafeInteger(expectedAmountCents)||expectedAmountCents<0)throw fail('请刷新订单后再修改金额');
 if(typeof reason!=='string'||!reason.trim()||reason.length>500)throw fail('请填写改价原因，最多 500 字');
 const updated=await transaction(async connection=>{
  await lockEvent(connection);await cleanup(connection);
  const [rows]=await connection.execute('SELECT * FROM orders WHERE id=? FOR UPDATE',[request.params.id]);const order=rows[0];
  if(!order)throw fail('订单不存在',404);
  if(order.status!=='PAY_PENDING'||eventEnded(await settings(connection)))throw fail('只有活动期内的待支付订单可以修改价格',409);
  if(order.amount_cents!==expectedAmountCents)throw fail('订单金额已被其他操作更新，请刷新后再修改',409);
  const [applications]=await connection.execute('SELECT * FROM applications WHERE id=? FOR UPDATE',[order.application_id]);const application=applications[0];
  if(application.status!=='APPROVED'||!application.fee_authorized)throw fail('当前申请未获准付款，不能修改订单价格',409);
  await connection.execute('UPDATE orders SET amount_cents=? WHERE id=?',[amountCents,order.id]);
  await connection.execute('UPDATE applications SET fee_cents=? WHERE id=?',[amountCents,application.id]);
  await audit(connection,request.admin.username,'ORDER_PRICE_CHANGED',order.id,{previousAmountCents:order.amount_cents,amountCents,reason:reason.trim(),applicationCode:application.code});
  return {id:order.id,amount_cents:amountCents};
 });response.json(updated);
});
app.post('/api/admin/orders/:id/refund',roles('admin','finance'),async(request,response)=>{
 if(process.env.PAYMENT_MODE!=='mock')throw fail('真实退款接口尚未接入');if(typeof request.body.reason!=='string'||!request.body.reason.trim()||request.body.reason.length>500)throw fail('请填写退款原因，最多 500 字');
 await transaction(async connection=>{await lockEvent(connection);const [rows]=await connection.execute('SELECT * FROM orders WHERE id=? FOR UPDATE',[request.params.id]);const order=rows[0];if(!order)throw fail('订单不存在');if(order.status==='REFUNDED')return;if(order.status!=='PAID')throw fail('只能退还已支付订单');const [used]=await connection.execute('SELECT tm.id FROM ticket_members tm JOIN tickets ti ON ti.id=tm.ticket_id WHERE ti.order_id=? AND tm.checked_at IS NOT NULL',[order.id]);if(used.length)throw fail('已有成员入场，请交现场负责人处理');await connection.execute("UPDATE orders SET status='REFUNDED' WHERE id=?",[order.id]);await connection.execute("UPDATE tickets SET status='VOID' WHERE order_id=?",[order.id]);await connection.execute("UPDATE applications SET status='CANCELLED',reserved_until=NULL WHERE id=?",[order.application_id]);await audit(connection,request.admin.username,'MOCK_REFUND',order.id,{reason:request.body.reason});});response.json({ok:true});
});
app.get('/api/admin/checkin-list',roles('admin'),async(request,response)=>{
 const search=String(request.query.search||'').trim().slice(0,100),status=String(request.query.status||'');
 const page=Number(request.query.page||1),pageSize=Number(request.query.pageSize||25);
 if(!Number.isInteger(page)||page<1||page>100000||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw fail('分页参数不正确');
 const statusConditions={'':'1=1',ready:"ti.status='VALID'",partial:"ti.status='PARTIALLY_USED'",used:"ti.status='FULLY_USED'",unpaid:'ti.id IS NULL',void:"ti.status='VOID'"};
 if(!Object.hasOwn(statusConditions,status))throw fail('请选择有效的核销状态');
 const joins='FROM applications ap LEFT JOIN tickets ti ON ti.application_id=ap.id LEFT JOIN orders o ON o.id=(SELECT id FROM orders WHERE application_id=ap.id ORDER BY created_at DESC,id DESC LIMIT 1)';
 const condition=`WHERE (ap.name LIKE ? OR ap.mobile LIKE ? OR ap.code LIKE ?) AND ${statusConditions[status]}`;
 const parameters=Array(3).fill(`%${search}%`);
 const [totals]=await pool.execute(`SELECT COUNT(*) total ${joins} ${condition}`,parameters);
 const [rows]=await pool.query(`SELECT ap.id,ap.code,ap.name,ap.mobile,ap.type,ap.status application_status,ap.seat_count,ap.created_at,o.status order_status,ti.id ticket_id,ti.status ticket_status,COALESCE(members.checked_count,0) checked_count ${joins} LEFT JOIN (SELECT ticket_id,COUNT(checked_at) checked_count FROM ticket_members GROUP BY ticket_id) members ON members.ticket_id=ti.id ${condition} ORDER BY ap.created_at DESC,ap.id DESC LIMIT ? OFFSET ?`,[...parameters,pageSize,(page-1)*pageSize]);
 response.json({records:rows,total:Number(totals[0].total),page,pageSize});
});
app.get('/api/admin/tickets/search',roles('admin','checkin'),async(request,response)=>{
 const query=String(request.query.query||'').trim();
 if(!query||query.length>2048)throw fail('请输入报名号、手机号、联系人姓名或扫码结果');
 if(query.includes('ticket=')){
  let scanned;try{scanned=new URL(query,requestOrigin(request));if(![requestOrigin(request),process.env.APP_ORIGIN].includes(scanned.origin))throw new Error();}catch{throw fail('扫码内容不正确，请重新扫描本次活动的电子票');}
  const value=scanned.searchParams.get('ticket');
  const [rows]=await pool.execute('SELECT ti.id,ti.token,ti.status,ap.code,ap.name,ap.mobile,ap.type FROM tickets ti JOIN applications ap ON ap.id=ti.application_id WHERE ti.token=?',[value||'']);
  return response.json(rows);
 }
 const [rows]=await pool.execute('SELECT ti.id,ti.token,ti.status,ap.code,ap.name,ap.mobile,ap.type FROM tickets ti JOIN applications ap ON ap.id=ti.application_id WHERE ti.token=? OR ap.code=? OR ap.mobile=? OR ap.name=? ORDER BY ti.created_at DESC LIMIT 50',[query,query.toUpperCase(),query,query]);
 response.json(rows);
});
app.get('/api/admin/tickets/resolve',roles('admin','checkin'),async(request,response)=>{
 const value=String(request.query.token||'').trim();let parsed=value;
 if(!value||value.length>2048)throw fail('请输入报名编码或扫描电子票');
 if(value.includes('ticket=')){
  try{const scanned=new URL(value,requestOrigin(request));if(![requestOrigin(request),process.env.APP_ORIGIN].includes(scanned.origin))throw new Error();parsed=scanned.searchParams.get('ticket');if(!parsed)throw new Error();}catch{throw fail('扫码内容不正确，请重新扫描本次活动的电子票');}
 }
 if(/^jzx/i.test(parsed))parsed=parsed.toUpperCase();
 const [rows]=await pool.execute('SELECT ti.*,ap.code,ap.name,ap.mobile FROM tickets ti JOIN applications ap ON ap.id=ti.application_id WHERE ti.token=? OR ap.code=?',[parsed,parsed]);const ticket=rows[0];if(!ticket)throw fail('未找到有效电子票，请核对二维码或报名编码',404);
 const [members]=await pool.execute('SELECT * FROM ticket_members WHERE ticket_id=? ORDER BY slot',[ticket.id]);response.json({...ticket,members});
});
app.post('/api/admin/checkins',roles('admin','checkin'),async(request,response)=>{
 const source=request.body.source||'onsite';
 if(!['onsite','manual'].includes(source))throw fail('核销方式不正确');
 if(source==='manual'&&request.admin.role!=='admin')throw fail('手动列表核销仅限管理员操作',403);
 const {ticketId,memberIds}=request.body;if(typeof ticketId!=='string'||!uuidPattern.test(ticketId)||!Array.isArray(memberIds)||!memberIds.length||memberIds.length>200||memberIds.some(id=>typeof id!=='string'||!uuidPattern.test(id)))throw fail('请重新查询电子票并勾选本次到场成员');
 const result=await transaction(async connection=>{
  await lockEvent(connection);const [rows]=await connection.execute('SELECT ti.*,o.status order_status,ap.status application_status FROM tickets ti JOIN orders o ON o.id=ti.order_id JOIN applications ap ON ap.id=ti.application_id WHERE ti.id=? FOR UPDATE',[ticketId]);const ticket=rows[0];if(!ticket||ticket.status==='VOID'||ticket.order_status!=='PAID'||ticket.application_status!=='APPROVED')throw fail('票据未生效或已失效，请联系现场负责人');
  const [validMembers]=await connection.execute('SELECT id FROM ticket_members WHERE ticket_id=?',[ticketId]);
  if(memberIds.some(id=>!validMembers.some(member=>member.id===id)))throw fail('所选成员不属于这张票，请重新查询后核销');
  let count=0;for(const memberId of new Set(memberIds)){const [updated]=await connection.execute('UPDATE ticket_members SET checked_at=NOW(),checked_by=? WHERE id=? AND ticket_id=? AND checked_at IS NULL',[request.admin.username,memberId,ticketId]);count+=updated.affectedRows;}
  const [totals]=await connection.execute('SELECT COUNT(*) total,SUM(checked_at IS NOT NULL) used FROM ticket_members WHERE ticket_id=?',[ticketId]);const summary=totals[0];await connection.execute('UPDATE tickets SET status=? WHERE id=?',[Number(summary.used)===summary.total?'FULLY_USED':Number(summary.used)>0?'PARTIALLY_USED':'VALID',ticketId]);await audit(connection,request.admin.username,'CHECKIN',ticketId,{count,totalUsed:Number(summary.used),source});return {count,totalUsed:Number(summary.used),total:summary.total};
 });response.json(result);
});
app.get('/api/admin/needs',roles('admin','reviewer'),async(request,response)=>{
 const [rows]=await pool.query("SELECT topics,type,analysis FROM applications WHERE status<>'CANCELLED'");
 const family=rows.filter(row=>row.type==='family');const topics=topicNames.map((name,index)=>({code:`N0${index+1}`,name,count:family.filter(row=>row.topics.includes(`N0${index+1}`)).length}));
 response.json({families:family.length,topics,analyzed:family.filter(row=>row.analysis).length,questions:family.length>=5?topics.filter(topic=>topic.count>=5).map(topic=>({theme:topic.name,prompt:`请结合榉之乡实践，讨论“${topic.name}”可借鉴的做法。`,count:topic.count})):[],notice:'按家庭去重统计；不足 5 个家庭的主题不展示讨论明细，个人问题原文不对外导出。'});
});
app.get('/api/admin/export',roles('admin'),async(request,response)=>{
 const [rows]=await pool.query("SELECT topics FROM applications WHERE type='family' AND status<>'CANCELLED'");
 const records=topicNames.map((name,index)=>[name,rows.filter(row=>row.topics.includes(`N0${index+1}`)).length]);
 await audit(pool,request.admin.username,'EXPORT_ANONYMOUS','event',{count:rows.length});
 response.setHeader('Content-Disposition',`attachment; filename="workshop_summary_v1_${Date.now()}.csv"`);response.type('text/csv').send('\ufeff主题,家庭数\r\n'+records.map(record=>record.join(',')).join('\r\n'));
});
app.get('/api/admin/settings',roles('admin'),async(request,response)=>response.json(await settings()));
app.put('/api/admin/settings',roles('admin'),async(request,response)=>{
 const configuration=request.body;
 if(typeof configuration.legalConfirmed!=='boolean')throw fail('请明确选择是否已确认正式条款');
 if(!Number.isInteger(configuration.capacity)||configuration.capacity<1||!Number.isInteger(configuration.organizationCapacity)||configuration.organizationCapacity<0||typeof configuration.registrationOpen!=='boolean')throw fail('容量和订单时限不正确');
 if(typeof configuration.endsAt!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(configuration.endsAt)||Number.isNaN(new Date(configuration.endsAt.replace(' ','T')+'+08:00').getTime()))throw fail('请填写有效的活动结束时间');
 for(const field of ['familyFeeCents','extraMealFeeCents'])if(configuration[field]!==undefined&&(!Number.isSafeInteger(configuration[field])||configuration[field]<0||configuration[field]>10000000))throw fail('报名费用和额外用餐费须为 0 至 100000 元，最多两位小数');
 const allowed=['familyFeeCents','extraMealFeeCents','capacity','organizationCapacity','registrationOpen','contact','privacyEntity','refundPolicy','legalConfirmed','endsAt'];
 for(const field of ['contact','privacyEntity','refundPolicy'])if(typeof configuration[field]!=='string'||configuration[field].length>1000)throw fail('活动说明不正确');
 await transaction(async connection=>{await lockEvent(connection);const existing=await settings(connection);for(const field of allowed)if(configuration[field]!==undefined)existing[field]=configuration[field];const [usage]=await connection.query('SELECT type,SUM(seat_count) used FROM applications WHERE reserved_until>NOW() GROUP BY type');if(usage.some(row=>Number(row.used)>(row.type==='family'?existing.capacity:existing.organizationCapacity)))throw fail('容量不能低于已预留及已付款的席位数');await connection.execute('UPDATE event_settings SET config=? WHERE id=1',[JSON.stringify(existing)]);await audit(connection,request.admin.username,'SETTINGS','event',{fields:allowed});});response.json({ok:true});
});
app.get('/api/admin/jobs',roles('admin','reviewer'),async(request,response)=>{const [rows]=await pool.query('SELECT j.*,ap.code FROM jobs j JOIN applications ap ON ap.id=j.application_id ORDER BY j.id DESC LIMIT 100');response.json(rows);});
app.post('/api/admin/jobs/:id/retry',roles('admin','reviewer'),async(request,response)=>{const [result]=await pool.execute("UPDATE jobs SET status='PENDING',attempts=0,generation=generation+1,next_at=NOW() WHERE id=? AND status IN ('PENDING','FAILED')",[request.params.id]);if(!result.affectedRows)throw fail('任务不存在、已完成或正在处理中，暂时不能重试');await audit(pool,request.admin.username,'RETRY_JOB',request.params.id);response.json({ok:true});});
app.get('/api/admin/users',roles('admin'),async(request,response)=>{const [rows]=await pool.query('SELECT id,username,role FROM admin_users');response.json(rows);});
app.post('/api/admin/users',roles('admin'),async(request,response)=>{
 const {username,password,role}=request.body;
 if(typeof username!=='string'||!/^[\w-]{3,40}$/.test(username))throw fail('账号需为 3–40 位字母、数字、下划线或短横线');
 if(typeof password!=='string'||!/^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{6,72}$/.test(password))throw fail('密码需为 6–72 位字母和数字，且至少包含一个字母和一个数字');
 if(!['reviewer','finance','checkin'].includes(role))throw fail('请选择工作权限');
 await pool.execute('INSERT INTO admin_users(username,password_hash,role) VALUES(?,?,?)',[username,await bcrypt.hash(password,12),role]);await audit(pool,request.admin.username,'CREATE_USER',username,{role});response.json({ok:true});
});
app.use((request,response,next)=>{if(['/apply/','/lookup/','/admin/','/checkin/'].includes(request.path))return response.redirect(308,(request.baseUrl||'')+request.path.slice(0,-1)+(request.url.includes('?')?'?'+request.url.split('?')[1]:''));next();});
app.use(express.static(path.resolve('public'),{index:false}));
if(process.env.NODE_ENV==='test')app.get('/__qa/responsive',(request,response)=>{
 const width=Number(request.query.width),page=String(request.query.page||'/apply');
 if(![320,390,768,1440].includes(width)||!['/apply','/lookup','/admin','/checkin','/promo/'].includes(page))throw fail('测试页面参数不正确');
 response.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>独立测试环境 · ${width}像素</title><style>html,body{margin:0;background:#e5eaf1}iframe{display:block;border:0;width:${width}px;height:900px;background:white}</style></head><body><iframe id="qa-frame" title="${width}像素页面测试" src="${page}"></iframe></body></html>`);
});
app.get('/promo',(request,response,next)=>request.path.endsWith('/')?next():response.redirect((request.baseUrl||'')+'/promo/'));
app.get('/promo/',(request,response)=>response.sendFile(path.resolve('public/promo/index.html')));
app.get('/admin',(request,response)=>response.sendFile(path.resolve('public/admin.html')));
app.get('/checkin',(request,response)=>response.sendFile(path.resolve('public/checkin.html')));
app.get(['/', '/apply','/lookup'],(request,response)=>response.sendFile(path.resolve('public/index.html')));
app.use('/api',(request,response)=>response.status(404).json({error:'接口不存在'}));
app.use((error,request,response,next)=>{
 if(error.type==='entity.parse.failed')return response.status(400).json({error:'提交内容的格式不正确，请刷新页面后重试'});
 if(error.type==='entity.too.large')return response.status(413).json({error:'提交内容过长，请精简后重试'});
 if(error.code==='ER_DUP_ENTRY')return response.status(409).json({error:'记录已存在，请勿重复提交；工作账号请换一个名称'});
 if(error.status)response.status(error.status).json({error:error.message});else {console.error('请求处理失败：',error.code||error.name);response.status(500).json({error:'暂时无法完成操作，请稍后重试；已提交的数据不会丢失。'});}
});

let workerBusy=false;
async function runJobs(){
 if(workerBusy)return;workerBusy=true;
 try{
  await transaction(async connection=>{await lockEvent(connection);await cleanup(connection);});
  const [jobs]=await pool.query("SELECT * FROM jobs WHERE status='PENDING' AND next_at<=NOW() ORDER BY id LIMIT 5");
  for(const job of jobs){
   const [claimed]=await pool.execute("UPDATE jobs SET status='PROCESSING',attempts=attempts+1 WHERE id=? AND generation=? AND status='PENDING'",[job.id,job.generation]);if(!claimed.affectedRows)continue;
   try{
    const [rows]=await pool.execute('SELECT * FROM applications WHERE id=?',[job.application_id]);const application=rows[0];
    if(!application){await pool.execute("UPDATE jobs SET status='DONE',last_error=NULL WHERE id=? AND generation=?",[job.id,job.generation]);continue;}
    if(job.kind==='webhook'){
     if(!['MANUAL_REVIEW','WAITLIST','NEED_INFO'].includes(application.status)){await pool.execute("UPDATE jobs SET status='DONE',last_error=NULL WHERE id=? AND generation=?",[job.id,job.generation]);continue;}
     const result=await fetch(process.env.MANUAL_WEBHOOK_URL,{method:'POST',headers:{Authorization:`Bearer ${process.env.MANUAL_WEBHOOK_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({type:'manual_review_required',applicationCode:application.code,applicantType:application.type,reasons:application.reasons,message:'有新的研修活动申请需要人工确认，请在六小时内处理。',reviewUrl:`${process.env.APP_ORIGIN}/admin`,requestedAt:new Date().toISOString()}),signal:AbortSignal.timeout(15000)});
     if(!result.ok)throw fail(`通知接口返回 ${result.status}`);
    }else {
     let analysis={source:'rules',themes:application.topics.map(code=>topicNames[Number(code.slice(1))-1]),status:'COMPLETED'};
     await pool.execute('UPDATE applications ap JOIN jobs j ON j.application_id=ap.id SET ap.analysis=? WHERE ap.id=? AND j.id=? AND j.generation=?',[JSON.stringify(analysis),application.id,job.id,job.generation]);
     // 仅在单独同意后调用模型；只发送结构化主题，不发送联系信息、画像或问题原文。
     if(process.env.QWEN_ENABLED==='true'&&application.consent.model&&application.topics.length){
      const result=await fetch(`${process.env.QWEN_BASE_URL}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${process.env.QWEN_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.QWEN_MODEL,messages:[{role:'system',content:'你协助准备研修课程。根据主题写一段简短的讨论建议，不诊断，不判断报名资格，不承诺服务。'},{role:'user',content:analysis.themes.join('；')}],max_tokens:250,temperature:0.2}),signal:AbortSignal.timeout(20000)});
      if(!result.ok)throw fail(`需求分析接口返回 ${result.status}`);const output=await result.json();analysis={...analysis,source:'qwen-max',suggestion:deidentify(output.choices?.[0]?.message?.content||'').slice(0,1500)};
     }
     await pool.execute('UPDATE applications ap JOIN jobs j ON j.application_id=ap.id SET ap.analysis=? WHERE ap.id=? AND j.id=? AND j.generation=?',[JSON.stringify(analysis),application.id,job.id,job.generation]);
    }
    await pool.execute("UPDATE jobs SET status='DONE',last_error=NULL WHERE id=? AND generation=?",[job.id,job.generation]);
   }catch(error){await pool.execute("UPDATE jobs SET status=?,next_at=DATE_ADD(NOW(),INTERVAL ? MINUTE),last_error=? WHERE id=? AND generation=?",[job.attempts>=3?'FAILED':'PENDING',Math.pow(2,job.attempts),String(error.status?error.message:'网络请求未完成，请重试').slice(0,200),job.id,job.generation]);}
  }
 }catch(error){console.error('后台任务暂未完成：',error.code||error.name);}finally{workerBusy=false;}
}
await pool.query("UPDATE jobs SET status='PENDING' WHERE status='PROCESSING'");
if(!(process.env.NODE_ENV==='test'&&process.env.BACKGROUND_JOBS==='false'))setInterval(runJobs,process.env.NODE_ENV==='test'?Number(process.env.JOB_POLL_MS||5000):5000).unref();
// 同一套页面同时支持活动子目录和原入口，方便本地预演正式部署。
const site=express();
site.use((request,response,next)=>{
 if(request.path==='/shanghai2026')return response.redirect(308,'/shanghai2026/');
 if(request.path==='/shanghai2026/')return response.redirect(302,'/shanghai2026/promo/');
 next();
});
site.use('/shanghai2026',app);
site.use('/',app);
site.listen(Number(process.env.PORT),process.env.HOST||'127.0.0.1',()=>console.log(`报名系统已启动：http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT}`));
