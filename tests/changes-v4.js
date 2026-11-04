import 'dotenv/config';
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import http from 'node:http';
import {pool} from '../server/db.js';
if(process.env.NODE_ENV!=='test'||!process.env.DB_NAME.startsWith('jzx_quality_'))throw new Error('只能对独立测试库运行');
const origin=process.env.APP_ORIGIN,results=[],fixtures={};
class Client{
 cookies=new Map();
 async call(route,{method='GET',body,status=200,headers={}}={}){
  const options={method,headers:{'Content-Type':'application/json',Cookie:[...this.cookies].map(([name,value])=>`${name}=${value}`).join('; '),...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(12000)};
  const response=headers.Host?await hostRequest(origin+route,options):await fetch(origin+route,options);
  for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],index=pair.indexOf('=');this.cookies.set(pair.slice(0,index),pair.slice(index+1));}
  const data=await response.json();assert.equal(response.status,status,`${route}: ${data.error||JSON.stringify(data)}`);return data;
 }
}
function hostRequest(url,options){return new Promise((resolve,reject)=>{const request=http.request(url,{method:options.method,headers:options.headers},response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>{const headers=new Headers();for(let index=0;index<response.rawHeaders.length;index+=2)headers.append(response.rawHeaders[index],response.rawHeaders[index+1]);resolve(new Response(body,{status:response.statusCode,headers}));});});request.on('error',reject);if(options.body)request.write(options.body);request.end();});}
const admin=new Client(),applicant=new Client(),visitor=new Client();
const post=(client,route,body,status=200,headers={})=>client.call(route,{method:'POST',body,status,headers});
const put=(client,route,body,status=200)=>client.call(route,{method:'PUT',body,status});
function payload(options={}){return {type:'family',name:'新版功能测试',mobile:'136'+String(crypto.randomInt(10000000,99999999)),idempotencyKey:crypto.randomUUID(),profile:{relationship:'父母',asdAge:'25–34',parentAge:'50–59',count:2,members:['成年ASD本人','父亲'],fourthMeal:false},topics:['N08'],question:'',consent:{privacy:true,sensitive:true,payment:true,model:false},channel:'v4独立测试',...options};}
async function submit(options={}){return post(applicant,'/api/applications',payload(options));}
async function pay(application){const order=await post(visitor,`/api/applications/${application.code}/orders`,{});const response=await post(visitor,`/api/applications/${application.code}/mock-payment`,{orderId:order.id,result:'success'});return {order,application:response.application};}
async function check(name,work){try{await work();results.push({name,passed:true});console.log('通过：'+name);}catch(error){results.push({name,passed:false,error:error.message});throw error;}}
let configuration,first,paid;
try{
 const health=await admin.call('/api/health');assert.equal(health.testDatabase,process.env.DB_NAME);
 await check('管理员新密码可登录，旧密码不能登录',async()=>{await post(admin,'/api/admin/login',{username:'admin',password:'旧密码不可用'},401);await post(admin,'/api/admin/login',{username:'admin',password:process.env.ADMIN_PASSWORD});assert(admin.cookies.has(`admin_session_test_${process.env.PORT}`));});
 configuration=await admin.call('/api/admin/settings');
 await check('报名无需验证码，响应不再含查询口令',async()=>{first=await submit({question:'只用于确认不出现在查询列表'});assert.equal(first.status,'APPROVED');assert(!Object.hasOwn(first,'recoveryKey'));});
 await check('验证码接口已移除',async()=>{await post(visitor,'/api/sms',{mobile:first.mobile},404);});
 await check('报名号可在全新设备查询，忽略大小写及空格',async()=>{const records=await post(visitor,'/api/lookup',{query:' '+first.code.toLowerCase()+' '});assert.equal(records.length,1);assert.equal(records[0].code,first.code);const details=await visitor.call(`/api/applications/${first.code}`);assert.equal(details.id,first.id);});
 await check('完整手机号可查询，列表显示完整手机号且不含画像和问题',async()=>{const records=await post(visitor,'/api/lookup',{query:first.mobile});assert.equal(records[0].mobile,first.mobile);assert(!JSON.stringify(records).includes(first.question));assert(!Object.hasOwn(records[0],'profile'));});
 await check('同名返回多条候选，不能默认认为是同一人',async()=>{const second=await submit();const records=await post(visitor,'/api/lookup',{query:first.name});assert(records.some(record=>record.code===first.code));assert(records.some(record=>record.code===second.code));});
 await check('空查询有提示，手机号尾号不做模糊查询',async()=>{await post(visitor,'/api/lookup',{query:''},400);assert.equal((await post(visitor,'/api/lookup',{query:first.mobile.slice(-4)})).length,0);});
 await check('不知道报名号的内部UUID访问仍被拒绝',async()=>{await visitor.call(`/api/applications/${first.id}`,{status:403});});
 await check('同一手机号同身份不能重复报名',async()=>{await submit({mobile:first.mobile}).then(()=>assert.fail('不应重复成功'),error=>assert(error.message.includes('400')||error.message.includes('已有申请')));});
 await check('报名号查询后可生成订单，金额由服务器计算',async()=>{const order=await post(visitor,`/api/applications/${first.code}/orders`,{amount_cents:1});assert.equal(order.amount_cents,250000);});
 await check('订单和席位保留到活动结束，不再按30分钟释放',async()=>{const application=await visitor.call(`/api/applications/${first.code}`);const order=application.orders[0];assert.equal(new Date(order.expires_at).getTime(),new Date(configuration.endsAt.replace(' ','T')+'+08:00').getTime());assert.equal(new Date(application.reserved_until).getTime(),new Date(order.expires_at).getTime());});
 await check('旧的短有效期待付订单自动沿用活动结束时间',async()=>{let application=await visitor.call(`/api/applications/${first.code}`);const id=application.orders[0].id;await pool.execute('UPDATE orders SET expires_at=DATE_SUB(NOW(),INTERVAL 1 HOUR) WHERE id=?',[id]);application=await visitor.call(`/api/applications/${first.code}`);assert.equal(application.orders[0].status,'PAY_PENDING');const order=await post(visitor,`/api/applications/${first.code}/orders`,{});assert.equal(order.id,id);});
 await check('已支付的订单重复失败操作仍显示成功',async()=>{paid=await pay(first);const response=await post(visitor,`/api/applications/${first.code}/mock-payment`,{orderId:paid.order.id,result:'failure'});assert.equal(response.result,'success');});
 await check('活动结束后不能下单或继续付款',async()=>{
  const pending=await submit();const order=await post(visitor,`/api/applications/${pending.code}/orders`,{});
  const past={...configuration,endsAt:'2020-01-01 23:59:59'};await pool.execute('UPDATE event_settings SET config=? WHERE id=1',[JSON.stringify(past)]);
  try{await post(visitor,`/api/applications/${pending.code}/orders`,{},400);await post(visitor,`/api/applications/${pending.code}/mock-payment`,{orderId:order.id,result:'success'},400);await post(visitor,'/api/applications',payload(),400);}finally{await pool.execute('UPDATE event_settings SET config=? WHERE id=1',[JSON.stringify(configuration)]);}
 });
 await check('活动结束时间可以配置，错误日期格式被拒绝',async()=>{await put(admin,'/api/admin/settings',{...configuration,endsAt:'不是日期'},400);await put(admin,'/api/admin/settings',configuration);});
 let institution;
 await check('机构可申请12人，未核费不能付款',async()=>{institution=await submit({type:'organization',name:'手动人数机构',profile:{count:12,members:Array(12).fill('专业人士'),orgCategory:'照护',orgName:'测试单位',orgRole:'工作人员',orgFocus:'长期支持'},topics:[]});assert.equal(institution.profile.count,12);assert.equal(institution.status,'MANUAL_REVIEW');await post(visitor,`/api/applications/${institution.code}/orders`,{},400);});
 await check('负责人批准后机构生成12个核销成员',async()=>{await post(admin,`/api/admin/applications/${institution.id}/decision`,{status:'APPROVED',note:'核准12人参与',feeCents:120000});const result=await pay(institution);assert.equal(result.application.ticket.members.length,12);fixtures.institution=result.application;});
 await check('机构人数支持200人，超过200或不为整数被拒绝',async()=>{const profile={count:200,members:Array(200).fill('专业人士'),orgCategory:'医疗',orgName:'大团体测试',orgRole:'联系人',orgFocus:'专业交流'};const record=await submit({type:'organization',profile,topics:[]});assert.equal(record.profile.count,200);const bad=payload({type:'organization',profile:{...profile,count:201,members:Array(201).fill('专业人士')},topics:[]});await post(applicant,'/api/applications',bad,400);await post(applicant,'/api/applications',payload({profile:{...first.profile,count:1.5}}),400);});
 await check('核销查找支持手机号和姓名',async()=>{for(const query of [first.mobile,first.name]){const records=await admin.call('/api/admin/tickets/search?query='+encodeURIComponent(query));assert(records.some(record=>record.code===first.code&&record.mobile===first.mobile));}});
 await check('同名已出票家庭返回两张票供选择',async()=>{const record=await submit();await pay(record);const candidates=await admin.call('/api/admin/tickets/search?query='+encodeURIComponent(first.name));assert.equal(candidates.length,2);fixtures.sameName=record;});
 await check('未出票申请不会出现在可核销候选中',async()=>{const record=await submit({name:'尚未付款测试'});assert.equal((await admin.call('/api/admin/tickets/search?query='+record.mobile)).length,0);});
 await check('未登录不能按手机号查询核销信息',async()=>{await visitor.call('/api/admin/tickets/search?query='+first.mobile,{status:401});});
 await check('姓名查票后按成员核销，重复核销不重复计数',async()=>{const candidates=await admin.call('/api/admin/tickets/search?query='+first.mobile);const ticket=await admin.call('/api/admin/tickets/resolve?token='+candidates[0].token);assert.equal(ticket.mobile,first.mobile);const body={ticketId:ticket.id,memberIds:[ticket.members[0].id]};assert.equal((await post(admin,'/api/admin/checkins',body)).count,1);assert.equal((await post(admin,'/api/admin/checkins',body)).count,0);});
 await check('损坏或其他网站扫码内容不会误匹配',async()=>{await admin.call('/api/admin/tickets/search?query='+encodeURIComponent('https://example.com/?ticket=x'),{status:400});});
 await check('局域网同源请求可登录，其他网站跨源请求被拒绝',async()=>{await post(new Client(),'/api/admin/login',{username:'admin',password:process.env.ADMIN_PASSWORD},200,{Host:'192.168.1.142:3089',Origin:'http://192.168.1.142:3089'});await post(visitor,'/api/lookup',{query:first.code},403,{Origin:'https://example.com'});});
 await check('二维码根据当前访问地址生成',async()=>{const local=await visitor.call(`/api/applications/${first.code}`);const lan=await visitor.call(`/api/applications/${first.code}`,{headers:{Host:'192.168.1.142:3089'}});assert.notEqual(local.ticket.qr,lan.ticket.qr);});
 await check('独立核销页和所有前端资源都使用相对地址',async()=>{const response=await fetch(origin+'/checkin');assert.equal(response.status,200);const html=await response.text();assert(html.includes('data-page="checkin"'));assert(html.includes('src="./admin.js"'));for(const name of ['registration.js','admin.js','index.html','admin.html','checkin.html']){const source=fs.readFileSync('public/'+name,'utf8');assert(!/href=["']https?:\/\//.test(source));assert(!/href=["']\//.test(source));assert(!/api\(["'`]\/api\//.test(source));}});
 await check('Markdown题目和分析原文可由后台读取供安全渲染',async()=>{const markdown='# 研修关切\n\n**优先讨论**\n\n- 未来居住\n- 长期支持\n\n<script>alert(1)</script><img src=x onerror=alert(1)>';const record=await submit({name:'Markdown渲染测试',question:markdown});await pool.execute('UPDATE applications SET analysis=? WHERE id=?',[JSON.stringify({source:'qwen-max',suggestion:'## 课程准备\n\n**明确主题**\n\n1. 居住\n2. 支持网络'}),record.id]);const rows=await admin.call('/api/admin/applications?search='+record.code);assert.equal(rows[0].question,markdown);fixtures.markdown=record;});
 fixtures.first=first;fixtures.origin=origin;fs.writeFileSync('.local/qa-fixtures-v4.json',JSON.stringify(fixtures));
 console.log(`本轮需求回归通过 ${results.length} 项。`);
}finally{
 if(configuration)await pool.execute('UPDATE event_settings SET config=? WHERE id=1',[JSON.stringify(configuration)]);
 fs.writeFileSync(`work/本轮需求测试结果_v4_${Date.now()}.json`,JSON.stringify({at:new Date().toISOString(),database:process.env.DB_NAME,results},null,2));await pool.end();
}
