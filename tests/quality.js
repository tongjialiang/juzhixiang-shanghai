import 'dotenv/config';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {pool} from '../server/db.js';
const origin=process.env.APP_ORIGIN;
if(process.env.NODE_ENV!=='test'||!process.env.DB_NAME.startsWith('jzx_quality_'))throw new Error('扩展测试只能在独立测试库运行');
const results=[];const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
class Client{
 cookies=new Map();
 async call(route,{method='GET',body,status=200,headers={},raw=false}={}){
  const response=await fetch(origin+route,{method,headers:{'Content-Type':'application/json',Cookie:[...this.cookies].map(([name,value])=>`${name}=${value}`).join('; '),...headers},body:body===undefined?undefined:raw?body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],position=pair.indexOf('=');this.cookies.set(pair.slice(0,position),pair.slice(position+1));}
  const data=raw&&method==='GET'?await response.text():await response.json();assert.equal(response.status,status,`${route}：${typeof data==='string'?data:data.error||JSON.stringify(data)}`);return data;
 }
}
const admin=new Client(),applicant=new Client(),outsider=new Client();
async function check(name,work){try{await work();results.push({name,passed:true});console.log('通过：'+name);}catch(error){results.push({name,passed:false,error:error.message});throw error;}}
async function sms(mobile,purpose='apply'){
 const id=crypto.randomUUID(),code=String(crypto.randomInt(100000,999999));await pool.execute('INSERT INTO sms_codes(id,mobile,code_hash,purpose,expires_at) VALUES(?,?,?,?,DATE_ADD(NOW(),INTERVAL 5 MINUTE))',[id,mobile,hash(code),purpose]);return {id,code};
}
async function payload(options={}){
 const mobile='138'+String(crypto.randomInt(10000000,99999999));const verification=await sms(mobile);
 return {type:'family',name:'独立测试家庭',mobile,smsId:verification.id,smsCode:verification.code,idempotencyKey:crypto.randomUUID(),profile:{relationship:'父母',asdAge:'35–44',parentAge:'50–59',count:2,members:['成年ASD本人','父亲'],fourthMeal:false},topics:['N08'],question:'',channel:'独立质量测试',consent:{privacy:true,sensitive:true,payment:true,pilot:false,photo:false,share:false,model:false},...options};
}
const post=(client,route,body,status=200)=>client.call(route,{method:'POST',body,status});
const put=(client,route,body,status=200)=>client.call(route,{method:'PUT',body,status});
let originalSettings,baseApplication,basePayload,paidOrder,paidTicket;
const fixtures={};
try{
 const health=await admin.call('/api/health');assert.equal(health.testDatabase,process.env.DB_NAME,'测试接口和数据库必须一致');
 await post(admin,'/api/admin/login',{username:process.env.ADMIN_USER,password:process.env.ADMIN_PASSWORD});originalSettings=await admin.call('/api/admin/settings');
 await check('同主机不同端口的测试登录不会覆盖开发后台Cookie',async()=>{assert(admin.cookies.has(`admin_session_test_${process.env.PORT}`));assert(!admin.cookies.has('admin_session'));});
 await check('缺少必要授权不能提交申请',async()=>{const body=await payload();body.consent.privacy=false;await post(applicant,'/api/applications',body,400);});
 await check('重复和非法研修主题均被服务端拒绝',async()=>{for(const topics of [['N01','N01'],['N09'],['N01','N02','N03','N04']])await post(applicant,'/api/applications',await payload({topics}),400);});
 await check('人数与成员不一致时不能提交',async()=>{const body=await payload();body.profile.count=3;await post(applicant,'/api/applications',body,400);});
 await check('空姓名、错误手机与任意成员角色不能提交',async()=>{await post(applicant,'/api/applications',await payload({name:'   '}),400);await post(applicant,'/api/applications',await payload({mobile:'123'}),400);const body=await payload();body.profile.members=['自造ASD标签','父亲'];await post(applicant,'/api/applications',body,400);});
 await check('验证码错误次数达到五次后必须重新获取',async()=>{const body=await payload();for(let attempt=0;attempt<5;attempt++)await post(applicant,'/api/applications',{...body,smsCode:'000000'},400);await post(applicant,'/api/applications',body,400);const [codes]=await pool.execute('SELECT attempts FROM sms_codes WHERE id=?',[body.smsId]);assert.equal(codes[0].attempts,5);});
 await check('过期验证码不能使用',async()=>{const body=await payload();await pool.execute('UPDATE sms_codes SET expires_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE id=?',[body.smsId]);await post(applicant,'/api/applications',body,400);});
 await check('查询验证码不能挪用为报名验证码',async()=>{const body=await payload(),verification=await sms(body.mobile,'lookup');await post(applicant,'/api/applications',{...body,smsId:verification.id,smsCode:verification.code},400);});
 await check('N08无文字、拒绝自愿授权仍能自动通过',async()=>{basePayload=await payload();baseApplication=await post(applicant,'/api/applications',basePayload);assert.equal(baseApplication.status,'APPROVED');assert.equal(baseApplication.consent.model,false);});
 await check('同一手机的同类申请不能重复建立',async()=>{const body=await payload({mobile:basePayload.mobile});const verification=await sms(body.mobile);body.smsId=verification.id;body.smsCode=verification.code;await post(applicant,'/api/applications',body,400);});
 await check('多设备查询不会让已有查询口令和会话失效',async()=>{const second=new Client(),third=new Client();await post(second,'/api/lookup',{code:baseApplication.code.toLowerCase(),recoveryKey:baseApplication.recoveryKey});await post(third,'/api/lookup',{code:baseApplication.code,recoveryKey:baseApplication.recoveryKey});await second.call(`/api/applications/${baseApplication.id}`);await applicant.call(`/api/applications/${baseApplication.id}`);});
 await check('手机号验证找回可与原设备同时使用',async()=>{const second=new Client(),verification=await sms(basePayload.mobile,'lookup');const records=await post(second,'/api/lookup',{mobile:basePayload.mobile,smsId:verification.id,smsCode:verification.code});assert.equal(records[0].id,baseApplication.id);await applicant.call(`/api/applications/${baseApplication.id}`);await second.call(`/api/applications/${baseApplication.id}`);});
 await check('只凭手机号不能读取报名内容',async()=>{await post(outsider,'/api/lookup',{mobile:basePayload.mobile},400);await outsider.call(`/api/applications/${baseApplication.id}`,{status:403});});
 await check('他人不能修改需求或代替付款',async()=>{await put(outsider,`/api/applications/${baseApplication.id}/needs`,{topics:['N01']},403);await post(outsider,`/api/applications/${baseApplication.id}/orders`,{},403);});
 await check('新订单金额忽略客户端篡改值',async()=>{paidOrder=await post(applicant,`/api/applications/${baseApplication.id}/orders`,{amount_cents:1});assert.equal(paidOrder.amount_cents,250000);});
 await check('过期订单查询立即显示EXPIRED且允许重新下单',async()=>{await pool.execute('UPDATE orders SET expires_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE id=?',[paidOrder.id]);const record=await applicant.call(`/api/applications/${baseApplication.id}`);assert.equal(record.orders[0].status,'EXPIRED');await post(applicant,`/api/applications/${baseApplication.id}/mock-payment`,{orderId:paidOrder.id,result:'success'},400);const replacement=await post(applicant,`/api/applications/${baseApplication.id}/orders`,{});assert.notEqual(replacement.id,paidOrder.id);paidOrder=replacement;});
 await check('并发支付确认只生成一张主票',async()=>{const responses=await Promise.all(Array.from({length:5},()=>post(applicant,`/api/applications/${baseApplication.id}/mock-payment`,{orderId:paidOrder.id,result:'success'})));assert.equal(new Set(responses.map(record=>record.application.ticket.id)).size,1);paidTicket=responses[0].application.ticket;});
 await check('已支付后收到失败重试不能把成功显示成失败',async()=>{const response=await post(applicant,`/api/applications/${baseApplication.id}/mock-payment`,{orderId:paidOrder.id,result:'failure'});assert.equal(response.result,'success');assert.equal(response.application.ticket.id,paidTicket.id);});
 await check('已付款不能再修改成员资料或撤销审核',async()=>{await put(applicant,`/api/applications/${baseApplication.id}/supplement`,basePayload,400);await post(admin,`/api/admin/applications/${baseApplication.id}/decision`,{status:'NOT_ADMITTED',note:'测试'},400);});
 await check('无效核销成员类型返回可读错误',async()=>{await post(admin,'/api/admin/checkins',{ticketId:paidTicket.id,memberIds:[{}]},400);});
 await check('其他票的成员不能混入本次核销',async()=>{await post(admin,'/api/admin/checkins',{ticketId:paidTicket.id,memberIds:[paidTicket.members[0].id,crypto.randomUUID()]},400);const ticket=await admin.call(`/api/admin/tickets/resolve?token=${paidTicket.token}`);assert(ticket.members.every(member=>!member.checked_at));});
 await check('同一成员并发核销只计一次',async()=>{const records=await Promise.all(Array.from({length:5},()=>post(admin,'/api/admin/checkins',{ticketId:paidTicket.id,memberIds:[paidTicket.members[0].id]})));assert.equal(records.reduce((total,record)=>total+record.count,0),1);});
 await check('扫码链接与小写报名编码都能查询',async()=>{const record=await admin.call(`/api/admin/tickets/resolve?token=${encodeURIComponent(`${origin}/admin?ticket=${paidTicket.token}`)}`);assert.equal(record.id,paidTicket.id);const lower=await admin.call(`/api/admin/tickets/resolve?token=${baseApplication.code.toLowerCase()}`);assert.equal(lower.id,paidTicket.id);});
 await check('外部和损坏的扫码链接不产生服务器错误',async()=>{await admin.call(`/api/admin/tickets/resolve?token=${encodeURIComponent('https://example.com/?ticket=123')}`,{status:400});await admin.call(`/api/admin/tickets/resolve?token=${encodeURIComponent('http://[?ticket=123')}`,{status:400});await admin.call('/api/admin/tickets/resolve?token=',{status:400});});
 await check('机构七个类别都进入人工确认且没有家庭价格',async()=>{for(const orgCategory of ['学术科研','保险','照护','器具厂家','公益社会组织','医疗','其他']){const body=await payload({type:'organization',topics:[],profile:{count:1,members:['专业人士'],orgCategory,orgName:'测试单位',orgRole:'测试角色',orgFocus:'专业交流'}});const record=await post(applicant,'/api/applications',body);assert.equal(record.status,'MANUAL_REVIEW');assert.equal(record.fee_cents,null);fixtures.organization??=record;}});
 await check('机构不选家庭主题也可以修改专业问题',async()=>{await put(applicant,`/api/applications/${fixtures.organization.id}/needs`,{topics:[],question:'机构专业交流问题'});});
 await check('补充资料准确保存授权，并由规则重新审核',async()=>{const body=await payload({profile:{...basePayload.profile,asdAge:'<25'}});const record=await post(applicant,'/api/applications',body);body.profile.asdAge='35–44';body.consent.model=true;body.consent.pilot=true;const updated=await put(applicant,`/api/applications/${record.id}/supplement`,body);assert.equal(updated.status,'APPROVED');assert.equal(updated.consent.model,true);assert.equal(updated.consent.pilot,true);});
 await check('人工要求补资料、候补和通过均可保存',async()=>{const body=await payload({profile:{...basePayload.profile,asdAge:'<25'}});const record=await post(applicant,'/api/applications',body);for(const status of ['NEED_INFO','WAITLIST','APPROVED']){await post(admin,`/api/admin/applications/${record.id}/decision`,{status,note:'独立测试处理说明'});const updated=await applicant.call(`/api/applications/${record.id}`);assert.equal(updated.status,status);if(status==='NEED_INFO')assert.equal(updated.next_step,'独立测试处理说明');}fixtures.manual=record;});
 await check('退款后票据作废且申请不能再次直接批准',async()=>{const body=await payload();const record=await post(applicant,'/api/applications',body),order=await post(applicant,`/api/applications/${record.id}/orders`,{});const payment=await post(applicant,`/api/applications/${record.id}/mock-payment`,{orderId:order.id,result:'success'});await post(admin,`/api/admin/orders/${order.id}/refund`,{reason:'独立测试退款'});await post(admin,`/api/admin/orders/${order.id}/refund`,{reason:'重复回调'});await post(admin,`/api/admin/applications/${record.id}/decision`,{status:'APPROVED',note:'测试'},400);await post(admin,'/api/admin/checkins',{ticketId:payment.application.ticket.id,memberIds:[payment.application.ticket.members[0].id]},400);});
 await check('非法退款原因返回400而非服务器异常',async()=>{await post(admin,`/api/admin/orders/${paidOrder.id}/refund`,{reason:{text:'错误类型'}},400);});
 await check('关闭报名后不能提交，重新打开后恢复',async()=>{await put(admin,'/api/admin/settings',{...originalSettings,registrationOpen:false});try{await post(applicant,'/api/applications',await payload(),400);}finally{await put(admin,'/api/admin/settings',originalSettings);}});
 await check('设置中的布尔值不能用字符串绕过',async()=>{await put(admin,'/api/admin/settings',{...originalSettings,legalConfirmed:'false'},400);});
 await check('非法JSON和非对象请求均返回中文提示',async()=>{const response=await applicant.call('/api/applications',{method:'POST',body:'{bad',raw:true,status:400});assert(/格式/.test(response.error));await post(applicant,'/api/applications',[],400);});
 await check('跨来源写请求被拒绝',async()=>{await applicant.call('/api/sms',{method:'POST',body:{mobile:basePayload.mobile},headers:{Origin:'https://example.com'},status:403});});
 await check('过长报名问题不能提交',async()=>{await post(applicant,'/api/applications',await payload({question:'测'.repeat(301)}),400);});
 const accounts={};
 await check('负责人可创建三类工作账号，重复账号有明确错误',async()=>{for(const role of ['reviewer','finance','checkin']){const username=`quality_${role}_${crypto.randomBytes(3).toString('hex')}`,password=crypto.randomBytes(16).toString('hex');await post(admin,'/api/admin/users',{username,password,role});accounts[role]={username,password,client:new Client()};await post(accounts[role].client,'/api/admin/login',{username,password});}const existing=accounts.checkin;await post(admin,'/api/admin/users',{...existing,client:undefined,role:'checkin'},409);await post(admin,'/api/admin/users',{password:'123456789012',role:'checkin'},400);});
 await check('核销人员在总览也不能读取金额',async()=>{const overview=await accounts.checkin.client.call('/api/admin/dashboard');assert.equal(overview.financialAccess,false);assert(overview.orders.every(order=>!Object.hasOwn(order,'amount')));await accounts.checkin.client.call('/api/admin/orders',{status:403});await accounts.checkin.client.call('/api/admin/applications',{status:403});});
 await check('财务不能读取家庭画像、审核与设置',async()=>{await accounts.finance.client.call('/api/admin/applications',{status:403});await accounts.finance.client.call('/api/admin/needs',{status:403});await put(accounts.finance.client,'/api/admin/settings',originalSettings,403);});
 await check('审核员不能核准机构金额或导出明细',async()=>{await post(accounts.reviewer.client,`/api/admin/applications/${fixtures.organization.id}/decision`,{status:'APPROVED',note:'测试',feeCents:0},400);await accounts.reviewer.client.call('/api/admin/export',{status:403});});
 await check('登出后原会话不能继续调用后台',async()=>{const checker=accounts.checkin.client;await post(checker,'/api/admin/logout',{});await checker.call('/api/admin/me',{status:401});});
 await check('不存在的后台任务不能伪报重试成功',async()=>{await post(admin,'/api/admin/jobs/99999999/retry',{},400);});
 await check('报名列表按身份、状态、编码筛选准确',async()=>{const records=await admin.call('/api/admin/applications?status=MANUAL_REVIEW&type=organization');assert.equal(records.length,7);assert(records.every(record=>record.type==='organization'&&record.status==='MANUAL_REVIEW'));const searched=await admin.call('/api/admin/applications?search='+baseApplication.code);assert.equal(searched.length,1);assert(!Object.hasOwn(searched[0],'access_hash'));});
 await check('匿名导出有版本号且不含联系人、手机或问题原文',async()=>{const response=await fetch(origin+'/api/admin/export',{headers:{Cookie:[...admin.cookies].map(([name,value])=>`${name}=${value}`).join('; ')}});assert.equal(response.status,200);assert(response.headers.get('content-disposition').includes('_v1_'));const csv=await response.text();assert(!csv.includes(basePayload.mobile));assert(!csv.includes(basePayload.name));assert(csv.includes('未来居住'));});
 await check('12个并发申请不会耗尽连接池或超卖',async()=>{
  const [usage]=await pool.query("SELECT COALESCE(SUM(seat_count),0) used FROM applications WHERE type='family' AND reserved_until>NOW()");
  await put(admin,'/api/admin/settings',{...originalSettings,capacity:Number(usage[0].used)+4});
  try{const requests=await Promise.all(Array.from({length:12},()=>payload({profile:{...basePayload.profile,count:1,members:['成年ASD本人']}})));const records=await Promise.all(requests.map(body=>post(applicant,'/api/applications',body)));assert.equal(records.filter(record=>record.status==='APPROVED').length,4);assert.equal(records.filter(record=>record.status==='WAITLIST').length,8);}finally{await put(admin,'/api/admin/settings',originalSettings);}
 });
 fixtures.paid={...baseApplication,ticket:paidTicket};fixtures.accounts=Object.fromEntries(Object.entries(accounts).map(([role,{username,password}])=>[role,{username,password}]));
 fs.writeFileSync('.local/qa-fixtures.json',JSON.stringify(fixtures));
 console.log(`扩展测试通过 ${results.length} 项。`);
}finally{
 if(originalSettings)try{await put(admin,'/api/admin/settings',originalSettings);}catch{}
 fs.writeFileSync(`work/功能回归结果_v3_${Date.now()}.json`,JSON.stringify({at:new Date().toISOString(),database:process.env.DB_NAME,results},null,2));await pool.end();
}
