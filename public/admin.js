import {decodeQr,readQrFile} from './qr-scanner.js';
import {renderMarkdown} from './markdown.js';
import {api,escapeHtml as text,money,badge,time,toast,formObject,openDialog} from './shared.js';
const standalone=document.body.dataset.page==='checkin';let initialTicket=new URLSearchParams(location.search).get('ticket');
const root=document.querySelector('#app');let user,tab='overview',applications=[],ticket,settings,orderRecords=[],renderVersion=0;
const manualFilters={search:'',status:'',page:1};
const listFilters={applications:{search:'',status:'',type:''},review:{search:'',status:'MANUAL_REVIEW',type:''}};
let cameraStream,cameraTimer,scanVersion=0,ticketQueryVersion=0;
function stopCamera(){scanVersion++;clearInterval(cameraTimer);cameraStream?.getTracks().forEach(track=>track.stop());cameraStream=null;document.querySelector('#scanner')?.replaceChildren();}
const tabs=[['overview','活动总览'],['applications','报名管理'],['review','人工审核'],['orders','订单票务'],['checkin','现场核销'],['manual-checkin','手动核销'],['needs','研修需求'],['settings','活动设置']];
const permission={admin:tabs.map(([id])=>id),reviewer:['overview','applications','review','needs'],finance:['overview','orders'],checkin:['overview','checkin']};
function initialPage(){const requested=new URLSearchParams(location.search).get('tab');return (standalone||new URLSearchParams(location.search).get('ticket'))&&permission[user.role].includes('checkin')?'checkin':permission[user.role].includes(requested)?requested:'overview';}
const roleLabels={admin:'负责人',reviewer:'报名审核',finance:'财务',checkin:'现场核销'};
const actionLabels={ORDER_PRICE_CHANGED:'修改待支付订单价格',SUPPLEMENT:'补充参与资料',SUBMIT:'收到参与申请',REVIEW_DECISION:'完成人工审核',CREATE_ORDER:'生成支付订单',MOCK_PAYMENT_SUCCESS:'模拟收款并出票',MOCK_PAYMENT_FAILURE:'模拟支付失败',CHECKIN:'确认成员入场',SETTINGS:'更新活动设置',MOCK_REFUND:'完成模拟退款',UPDATE_NEEDS:'更新研修需求',RETRY_JOB:'重试后台任务',CREATE_USER:'新增工作人员',EXPORT_ANONYMOUS:'导出匿名主题统计'};
const heading=(title,subtitle,actions='')=>`<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${actions}</div>`;
const empty=message=>`<div class="empty">${message}</div>`;
const field=(name,label,value,type='text',extra='')=>`<label class="field"><span>${label}</span><input type="${type}" name="${name}" value="${text(value)}" ${extra}></label>`;
function login(){root.innerHTML=`<main class="login-shell"><form class="card login-card" id="login"><a href="./promo/" class="brand"><span class="brand-mark" aria-hidden="true">榉</span><span><strong>榉之乡 × 上海</strong><small>活动运营工作台</small></span></a><h1>${standalone?'现场核销登录':'活动运营工作台'}</h1><p class="card-subtitle">报名、审核与入场安排，在这里完成。</p>${field('username','工作账号','','text','required autocomplete="username"')}${field('password','登录密码','','password','required autocomplete="current-password"')}<button class="btn full" type="submit">${standalone?'进入现场核销 →':'登录工作台 →'}</button><p class="small muted center">请使用管理员或分配的工作账号登录</p><a class="small" href="./promo/">← 查看活动宣传页</a></form></main>`;}
function shell(content,renderState){if(renderState&&renderState.version!==renderVersion)return;root.innerHTML=`<header class="topbar admin-top"><a href="./admin" class="brand"><span class="brand-mark" aria-hidden="true">榉</span><span><strong>榉之乡 × 上海</strong><small>${standalone?'现场核销':'活动运营工作台'}</small></span></a><div class="nav-actions">${standalone?'<a href="./admin">运营后台</a>':'<a href="./checkin" target="_blank" rel="noopener">独立现场核销 ↗</a>'}<a href="./promo/" target="_blank" rel="noopener">查看 H5 ↗</a><span class="muted">${text(user.username)} · ${roleLabels[user.role]}</span><button class="btn ghost small-btn" data-action="logout">退出</button></div></header>${standalone?'':`<nav class="admin-nav" aria-label="运营功能">${tabs.filter(([id])=>permission[user.role].includes(id)).map(([id,label])=>`<button data-tab="${id}" class="${tab===id?'active':''}" aria-current="${tab===id?'page':'false'}">${label}</button>`).join('')}</nav>`}<main class="admin-content">${content}</main>`;}
async function render(){if(standalone){if(!permission[user.role]?.includes('checkin')){shell('<div class="card"><h2>此账号没有现场核销权限</h2><p>请退出后使用管理员或现场核销账号登录。</p></div>');return;}tab='checkin';}const page=tab,renderState={version:++renderVersion};try{
 if(page==='overview')await overview(renderState);if(page==='applications'||page==='review')await listing(renderState);if(page==='orders')await orders(renderState);if(page==='checkin')checkin(renderState);if(page==='manual-checkin')await manualCheckin(renderState);if(page==='needs')await needs(renderState);if(page==='settings')await configuration(renderState);
 }catch(error){if(error.status===401){user=null;login();}else toast(error.message);}}
async function overview(renderState){const result=await api('./api/admin/dashboard');settings=result.settings;
 const total=result.applications.reduce((sum,row)=>sum+row.count,0);const manual=result.applications.filter(row=>['MANUAL_REVIEW','NEED_INFO'].includes(row.status)).reduce((sum,row)=>sum+row.count,0);const paid=result.orders.find(row=>row.status==='PAID')||{count:0,amount:0};const family=result.applications.filter(row=>row.type==='family').reduce((sum,row)=>sum+row.count,0);const approved=result.applications.filter(row=>row.status==='APPROVED').reduce((sum,row)=>sum+row.count,0);
 shell(`${heading('把每一位参与者安排好','2026 年 11 月 25 日 · 上药信谊大厦2F',`<button class="btn secondary" data-action="refresh">↻ 刷新数据</button>`)}<div class="callout row spread"><div><strong>活动筹备进行中</strong><div class="small muted">${manual?`有 ${manual} 份申请需要人工确认，请优先处理。`:'报名信息将实时汇总到这里，准备好后即可开始邀请。'}</div></div>${permission[user.role].includes('review')?'<button class="btn" data-tab="review">处理人工审核 →</button>':''}</div><div class="stats">${[[total,'累计申请',`${family} 个家庭 · ${total-family} 个机构`],[manual,'待人工确认','建议在 6 小时内联系'],[result.financialAccess?money(paid.amount):paid.count,result.financialAccess?'模拟支付金额':'已支付订单',result.financialAccess?`${paid.count} 笔已支付订单`:'金额仅向财务和负责人展示'],[result.checkins,'实际到场人数','按成员核销，重复扫码不重复计数']].map(([value,label,detail])=>`<div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="change">${detail}</div></div>`).join('')}</div><div class="admin-grid"><section class="card"><div class="row spread"><h3>报名进度</h3><span class="small muted">实时数据</span></div>${[['提交申请',total],['审核通过',approved],['支付完成',paid.count],['实际到场',result.checkins]].map(([name,count])=>`<div class="bar-row"><span>${name}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100,total?count/Math.max(total,count)*100:0)}%"></div></div><b>${count}</b></div>`).join('')}<div class="note">家庭容量 ${settings.capacity} 人 · 机构容量 ${settings.organizationCapacity} 人<br>订单在活动结束前一直有效（${text(settings.endsAt)}）。</div></section><section class="card"><h3>最近操作</h3>${result.recent.length?result.recent.map(item=>`<div class="activity-item">${text(actionLabels[item.action]||item.action)}<small>${text(item.actor)}　${time(item.created_at)}</small></div>`).join(''):empty('还没有操作记录')}</section></div><div class="card" style="margin-top:22px"><h3>处理提醒</h3><p class="small muted">人工提醒与需求分析独立运行，分析失败不会阻止审核和付款。</p><div class="row">${result.jobs.map(job=>`<span class="small">${job.kind==='webhook'?'人工审核提醒':'需求分析'} ${badge(job.status)} ${job.count} 项</span>`).join('')||'<span class="small muted">暂无后台任务</span>'}</div></div>`,renderState);
}
async function listing(renderState){const {search,status,type}=listFilters[tab];
 applications=await api(`./api/admin/applications?search=${encodeURIComponent(search)}&status=${status}&type=${type}`);
 shell(`${heading(tab==='review'?'人工审核':'报名管理',tab==='review'?'确认例外情况，审核通过后自动回到统一付款流程。':'按姓名、手机或报名编码查找；点击“查看”处理申请。',`<button class="btn secondary" data-action="refresh">↻ 刷新</button>`)}<div class="card"><div class="toolbar"><input id="search" placeholder="姓名 / 手机 / 报名编码" value="${text(search)}" aria-label="搜索报名"><select id="filter-status" aria-label="审核状态"><option value="">全部状态</option>${['MANUAL_REVIEW','NEED_INFO','APPROVED','WAITLIST','NOT_ADMITTED','CANCELLED'].map(option=>`<option value="${option}" ${status===option?'selected':''}>${{MANUAL_REVIEW:'待人工确认',NEED_INFO:'待补充信息',APPROVED:'已通过',WAITLIST:'候补中',NOT_ADMITTED:'请联系工作人员',CANCELLED:'已取消'}[option]}</option>`).join('')}</select><select id="filter-type" aria-label="参与身份"><option value="">全部身份</option><option value="family" ${type==='family'?'selected':''}>ASD 家庭</option><option value="organization" ${type==='organization'?'selected':''}>机构 / 专业人士</option></select><button class="btn secondary" data-action="search">查找</button><span class="small muted">${applications.length} 份申请</span></div><div class="table-wrap"><table><thead><tr><th>联系人 / 报名编码</th><th>参与身份</th><th>人数</th><th>申请状态</th><th>支付状态</th><th>申请时间</th><th>操作</th></tr></thead><tbody>${applications.map(application=>`<tr><td><b>${text(application.name)}</b><small>${text(application.code)}</small></td><td>${application.type==='family'?'ASD 家庭':text(application.profile.orgCategory)}<small>${text(application.mobile)}</small></td><td>${application.seat_count} 人</td><td>${badge(application.status)}${application.review_source?`<small>${application.review_source==='AUTO'?'规则自动通过':'人工通过'}</small>`:''}</td><td>${application.order_status?badge(application.order_status):'<span class="muted">未生成订单</span>'}</td><td class="nowrap">${time(application.created_at)}</td><td><button class="btn secondary small-btn" data-open="${application.id}">查看 →</button></td></tr>`).join('')}</tbody></table>${!applications.length?empty('没有符合条件的申请。可调整筛选条件，或先从 H5 提交一份测试申请。'):''}</div></div>${tab==='review'?await jobsPanel():''}`,renderState);
}
async function jobsPanel(){const jobs=await api('./api/admin/jobs');return `<section class="card" style="margin-top:24px"><h3>提醒发送与需求分析</h3><p class="small muted">发送失败会自动重试，达到重试上限后可手动重试。提醒仅包含报名编码和后台入口。</p><div class="table-wrap"><table><thead><tr><th>报名编码</th><th>任务</th><th>结果</th><th>尝试次数</th><th>操作</th></tr></thead><tbody>${jobs.map(job=>`<tr><td>${text(job.code)}</td><td>${job.kind==='webhook'?'人工审核提醒':'研修需求分析'}</td><td>${badge(job.status)}<small>${text(job.last_error||'')}</small></td><td>${job.attempts}</td><td>${['FAILED','PENDING'].includes(job.status)?`<button class="btn secondary small-btn" data-retry="${job.id}">重新处理</button>`:'—'}</td></tr>`).join('')}</tbody></table>${jobs.length?'':empty('暂无后台任务')}</div></section>`;}
function openDetail(id){const application=applications.find(item=>item.id===id);if(!application)return;const profile=application.profile;const ownerFeeRequired=(application.type==='organization'||application.seat_count>4)&&user.role!=='admin';
 const fieldLabels={relationship:'联系人关系',asdAge:'ASD 人士年龄段',parentAge:'父母年龄段',supporter:'主要支持者',living:'居住方式',supportNeed:'现场支持需求',orgCategory:'机构类型',orgName:'单位名称',orgRole:'专业角色',orgFocus:'关注领域',otherDetail:'其他关切'};
 const backdrop=openDialog('参与申请详情',`<div class="row spread"><span class="receipt-code">${text(application.code)}</span>${badge(application.status)}</div><ul class="detail-list"><li><span>联系人</span><b>${text(application.name)} · ${text(application.mobile)}</b></li><li><span>参加成员</span><span>${profile.members.map(text).join('、')}</span></li>${Object.entries(fieldLabels).filter(([key])=>profile[key]).map(([key,label])=>`<li><span class="muted">${label}</span><span>${text(profile[key])}</span></li>`).join('')}<li><span>来源渠道</span><span>${text(application.channel)}</span></li></ul><div class="note amber">${application.reasons.length?application.reasons.map(text).join('；'):'资料符合宽松规则，自动通过。'}</div><h3>研修关切</h3><p class="small">${application.topics.map(code=>text(topicName(code))).join('、')||'未选择'}</p><div class="markdown">${renderMarkdown(application.question||'未填写个性问题')}</div><details><summary>查看自愿授权</summary><p>${['pilot','photo','share','model'].map(key=>`${{pilot:'后续联系',photo:'照片联系',share:'匿名展示联系',model:'模型整理主题'}[key]}：${application.consent[key]?'已同意':'未同意'}`).join('；')}</p></details>${application.analysis?.suggestion?`<div class="note markdown"><b>模型辅助建议（仅供内部参考）</b>${renderMarkdown(application.analysis.suggestion)}</div>`:''}<div class="divider"></div>${application.status==='CANCELLED'?'<div class="note">申请已取消。需要再次参与时，请申请人重新报名。</div>':application.order_status==='PAID'?'<div class="note">该申请已付款。如需取消，请到“订单票务”处理退款。</div>':`<form id="decision-form" data-id="${application.id}"><h3>处理这份申请</h3><label class="field"><span>处理结果 *</span><select name="status"><option value="APPROVED" ${ownerFeeRequired?'disabled':''}>通过审核，允许付款</option><option value="NEED_INFO" ${ownerFeeRequired?'selected':''}>需要补充信息</option><option value="WAITLIST">安排候补</option><option value="NOT_ADMITTED">本次暂不适配（先联系申请人）</option></select></label>${ownerFeeRequired?'<div class="note amber">这份申请的费用须由负责人核准。您可以记录联系情况、要求补充信息或安排候补。</div>':(application.type==='organization'||application.seat_count>4)?((application.type==='organization'?`<div class="note">机构标准参与费 ${money(organizationFeeCents)} / 人，本次 ${application.seat_count} 人，标准合计 ${money(organizationFeeCents*application.seat_count)}。请确认实际参加人数及核准费用。</div>`:'')+field('fee','负责人核准费用（元，填 0 表示免收费）',application.fee_cents===null?'':application.fee_cents/100,'number','min="0" max="100000" step="0.01"')):`<div class="note">家庭费用：${money(application.fee_cents)}。通过后沿用相同订单入口。</div>`}<label class="field"><span>处理说明 / 联系记录 *</span><textarea name="note" required maxlength="500" placeholder="例如：已电话确认参加安排，同意通过。"></textarea></label><button class="btn full">保存处理结果 →</button></form>`}`);}
let topicNames=[],organizationFeeCents=150000;
function openPriceDialog(orderId){
 const order=orderRecords.find(record=>record.id===orderId);
 if(!order||order.status!=='PAY_PENDING'||user.role!=='admin')return;
 const dialog=openDialog('修改待支付订单价格',`<p><b>${text(order.name)}</b> · ${text(order.code)}</p><div class="note">当前订单金额 <b>${money(order.amount_cents)}</b>。保存后，报名用户按新金额付款，参加人数保持不变。</div><form id="price-form">${field('amount','新订单金额（元） *',(order.amount_cents/100).toFixed(2),'number','required min="0" max="100000" step="0.01"')}<p class="small muted">最多两位小数，填 0 表示免收费。</p><label class="field"><span>改价原因 *</span><textarea name="reason" required maxlength="500" placeholder="例如：已确认优惠安排，调整为约定金额。"></textarea></label><div class="form-footer"><button type="button" class="btn secondary" data-close-dialog>取消</button><button type="submit" class="btn">保存新价格</button></div></form>`);
 dialog.querySelector('form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.target,button=event.submitter;button.disabled=true;
  try{
   const value=form.elements.amount.value.trim();
   if(!/^\d{1,6}(\.\d{1,2})?$/.test(value))throw new Error('请填写有效金额，最多两位小数。');
   await api(`./api/admin/orders/${order.id}/price`,{method:'PUT',body:{amountCents:Math.round(Number(value)*100),expectedAmountCents:order.amount_cents,reason:form.elements.reason.value}});
   dialog.close();toast('订单价格已修改，用户将按新金额付款');await render();
  }catch(error){toast(error.message);if(error.status===409){dialog.close();await render();}}finally{button.disabled=false;}
 });
}
async function manualCheckin(renderState){
 const result=await api(`./api/admin/checkin-list?search=${encodeURIComponent(manualFilters.search)}&status=${manualFilters.status}&page=${manualFilters.page}`);
 const pages=Math.max(1,Math.ceil(result.total/result.pageSize));
 if(result.page>pages){manualFilters.page=pages;return manualCheckin(renderState);}
 shell(`${heading('手动核销','从报名列表选择用户，核对信息后勾选实际到场成员。', '<button class="btn secondary" data-action="refresh">↻ 刷新列表</button>')}<section class="card"><div class="toolbar"><input id="manual-search" aria-label="搜索手动核销名单" placeholder="姓名 / 手机号 / 报名号" value="${text(manualFilters.search)}"><select id="manual-status" aria-label="核销状态">${[['','全部报名'],['ready','待核销'],['partial','部分已核销'],['used','全部已核销'],['unpaid','未出票'],['void','票据已失效']].map(([value,label])=>`<option value="${value}" ${manualFilters.status===value?'selected':''}>${label}</option>`).join('')}</select><button class="btn secondary" data-action="manual-search">查找</button><span class="small muted">共 ${result.total} 份报名</span></div><div class="note">已完成付款并生成电子票的用户可以核销。同一家庭可分批到场，重复操作不会重复统计。</div><div class="table-wrap"><table><thead><tr><th>联系人 / 报名号</th><th>手机号</th><th>身份 / 人数</th><th>付款 / 票据</th><th>核销进度</th><th>操作</th></tr></thead><tbody>${result.records.map(record=>{
  const usable=record.ticket_id&&['VALID','PARTIALLY_USED'].includes(record.ticket_status)&&record.order_status==='PAID'&&record.application_status==='APPROVED';
  return `<tr><td><b>${text(record.name)}</b><small>${text(record.code)}</small></td><td>${text(record.mobile)}</td><td>${record.type==='family'?'ASD 家庭':'机构 / 专业人士'}<small>${record.seat_count} 人</small></td><td>${record.order_status?badge(record.order_status):badge(record.application_status)}<small>${record.ticket_status?badge(record.ticket_status):'未出票'}</small></td><td>${Number(record.checked_count)} / ${record.seat_count} 人</td><td>${usable?`<button class="btn secondary small-btn" data-manual-checkin="${text(record.code)}">选择成员核销</button>`:`<span class="small muted">${record.ticket_status==='FULLY_USED'?'已全部核销':record.ticket_status==='VOID'?'票据已失效':'暂不可核销'}</span>`}</td></tr>`;
 }).join('')}</tbody></table>${result.records.length?'':empty('没有符合条件的报名，请调整姓名、手机号或核销状态。')}</div><div class="row spread pagination"><span class="small muted">第 ${result.page} / ${pages} 页 · 每页 ${result.pageSize} 条</span><div class="row"><button class="btn secondary small-btn" data-manual-page="${result.page-1}" ${result.page<=1?'disabled':''}>上一页</button><button class="btn secondary small-btn" data-manual-page="${result.page+1}" ${result.page>=pages?'disabled':''}>下一页</button></div></div></section>`,renderState);
}
async function openManualCheckin(code){
 const version=renderVersion;
 const record=await api(`./api/admin/tickets/resolve?token=${encodeURIComponent(code)}`);
 if(tab!=='manual-checkin'||version!==renderVersion)return;
 if(!['VALID','PARTIALLY_USED'].includes(record.status)){toast('这张票已全部核销或已失效，请刷新列表。');await render();return;}
 const dialog=openDialog('手动核销 · 选择到场成员',`<h3>${text(record.name)} · ${text(record.code)}</h3><p>联系手机 ${text(record.mobile)}</p><div class="note">仅勾选本次实际到场成员。已入场的成员不能重复勾选，其他成员可以稍后继续核销。</div><form id="manual-checkin-form">${record.members.map(member=>`<label class="member-check"><input type="checkbox" name="member" value="${member.id}" ${member.checked_at?'disabled':''}><span>成员 ${member.slot} · ${text(member.label)}</span><span class="badge ${member.checked_at?'green':'gray'}">${member.checked_at?'已入场':'待入场'}</span></label>`).join('')}<button class="btn full" type="submit" disabled>请先勾选本次到场成员</button></form>`);
 dialog.querySelector('form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.target,button=event.submitter,memberIds=new FormData(form).getAll('member');
  if(!memberIds.length)return;button.disabled=true;
  try{
   const result=await api('./api/admin/checkins',{method:'POST',body:{ticketId:record.id,memberIds,source:'manual'}});
   dialog.close();toast(`本次核销 ${result.count} 人，累计 ${result.totalUsed} / ${result.total} 人`);await render();
  }catch(error){toast(error.message);}finally{button.disabled=false;}
 });
}
const topicName=code=>topicNames[Number(code.slice(1))-1]||code;
async function orders(renderState){const records=await api('./api/admin/orders');if(renderState.version===renderVersion)orderRecords=records;shell(`${heading('订单与电子票','待支付订单可修改价格，已支付订单可查看票据及办理模拟退款。')}<div class="card"><div class="table-wrap"><table><thead><tr><th>报名 / 订单</th><th>联系人</th><th>金额</th><th>支付状态</th><th>电子票</th><th>支付时间</th><th>操作</th></tr></thead><tbody>${records.map(order=>`<tr><td>${text(order.code)}<small>${text(order.id.slice(0,8))} · ${text(order.provider)}</small></td><td>${text(order.name)}<small>${order.type==='family'?'家庭':'机构'}</small></td><td>${money(order.amount_cents)}</td><td>${badge(order.status)}</td><td>${order.ticket_status?badge(order.ticket_status):'未出票'}</td><td>${time(order.paid_at)}</td><td>${order.status==='PAY_PENDING'&&user.role==='admin'?`<button class="btn secondary small-btn" data-edit-price="${order.id}">修改价格</button>`:order.status==='PAID'?`<button class="btn danger small-btn" data-refund="${order.id}">模拟退款</button>`:'—'}</td></tr>`).join('')}</tbody></table>${records.length?'':empty('暂时没有支付订单')}</div></div>`,renderState);}
function checkin(renderState){shell(`${heading('现场核销','扫码，或输入手机号、联系人姓名、报名号查找电子票。')}<div class="admin-grid"><section class="card"><h3>查找入场票</h3><p class="card-subtitle">同一家庭分批到场，可使用同一张电子票。</p><form id="resolve-form"><label class="field"><span>手机号 / 联系人姓名 / 报名号 / 扫码结果</span><input name="token" required value="${text(ticket?.token||new URLSearchParams(location.search).get('ticket')||'')}" placeholder="输入手机号、完整姓名、报名号或扫码结果" autocomplete="off" autofocus></label><div class="row"><button class="btn" type="submit">查询电子票 →</button><button class="btn secondary" type="button" data-action="scan">拍照扫码</button><button class="btn secondary" type="button" data-action="scan-album">从相册识别</button>${window.isSecureContext&&navigator.mediaDevices?.getUserMedia?'<button class="btn secondary" type="button" data-action="scan-live">实时扫码</button>':''}</div></form><input id="scan-photo" type="file" accept="image/*" capture="environment" hidden><input id="scan-album" type="file" accept="image/*" hidden><div id="scanner" role="status" aria-live="polite"></div><div class="note">点击“拍照扫码”，拍下完整二维码即可查询。也可从相册选择电子票截图，或使用扫码枪。照片仅在本机识别。</div></section><section class="card" id="ticket-result">${ticket?ticketPanel():empty('查找到电子票后，在这里选择实际到场成员')}</section></div>`,renderState);if(initialTicket&&document.querySelector('#resolve-form')){initialTicket=null;document.querySelector('#resolve-form').requestSubmit();}}
function ticketPanel(){return `<div class="row spread"><h3>${text(ticket.name)} · ${text(ticket.code)}</h3>${badge(ticket.status)}</div><p class="small muted">联系手机 ${text(ticket.mobile)}</p>${ticket.status==='VOID'?'<div class="note amber">票据已失效，请交现场负责人处理。</div>':`<div class="note">请勾选本次实际到场的成员，其他成员可在稍后到场时继续核销。</div><form id="checkin-form">${ticket.members.map(member=>`<label class="member-check"><input type="checkbox" name="member" value="${member.id}" ${member.checked_at?'disabled':''}><span>成员 ${member.slot} · ${text(member.label)}</span>${member.checked_at?'<span class="badge green">已入场</span>':'<span class="badge gray">待入场</span>'}</label>`).join('')}<button class="btn full" disabled>${ticket.members.every(member=>member.checked_at)?'全部成员已入场':'请先勾选本次到场成员'}</button></form>`}`;}
async function needs(renderState){const result=await api('./api/admin/needs');shell(`${heading('研修需求，提前了解','结构化主题用于课程准备，不参与资格评分。',user.role==='admin'?'<a class="btn secondary" href="./api/admin/export">导出匿名统计 ↓</a>':'')}<div class="stats"><div class="stat"><div class="label">参与调研家庭</div><div class="value">${result.families}</div><div class="change">按家庭申请去重</div></div><div class="stat"><div class="label">研修主题</div><div class="value">8</div><div class="change">每个家庭最多选择 3 项</div></div><div class="stat"><div class="label">已完成需求整理</div><div class="value">${result.analyzed}</div><div class="change">规则整理优先，模型仅辅助</div></div><div class="stat"><div class="label">可分享主题明细</div><div class="value">${result.questions.length}</div><div class="change">至少 5 个家庭选择后展示</div></div></div><div class="admin-grid"><section class="card"><h3>家庭最关注的八个主题</h3>${result.topics.map(topic=>`<div class="bar-row"><span>${text(topic.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${result.families?topic.count/result.families*100:0}%"></div></div><b>${topic.count}</b></div>`).join('')}</section><section class="card"><h3>Workshop 讨论准备</h3><p class="small muted">${text(result.notice)}</p>${result.questions.length?result.questions.map(question=>`<div class="activity-item"><b>${text(question.theme)}</b><div class="markdown">${renderMarkdown(question.prompt)}</div><small>${question.count} 个家庭关注 · 发送给讲师前请人工复核</small></div>`).join(''):empty('积累足够申请后，在这里查看匿名主题建议。')}</section></div>`,renderState);}
async function configuration(renderState){settings=await api('./api/admin/settings');const users=await api('./api/admin/users');shell(`${heading('活动设置','日常调整集中在这里，费用和审核操作均保留记录。')}<div class="admin-grid"><section class="card"><h3>报名与席位</h3><form id="settings-form"><h3>家庭收费</h3><div class="grid-2">${field('familyFee','家庭报名基础费用（元） *',(settings.familyFeeCents/100).toFixed(2),'number','required min="0" max="100000" step="0.01"')}${field('extraMealFee','第 4 人额外用餐费（元） *',(settings.extraMealFeeCents/100).toFixed(2),'number','required min="0" max="100000" step="0.01"')}</div><div class="note">基础费用包含 1–3 人研修及午餐，第 4 人选择用餐时加收额外用餐费。新费用用于新提交及补充资料后重新审核的申请；已有申请和订单保留原金额，单笔调整请到“订单票务”修改价格。填 0 表示不收费。</div><h3>报名名额与时间</h3><div class="grid-2">${field('capacity','家庭容量（人）',settings.capacity,'number','required min="1"')}${field('organizationCapacity','机构容量（人）',settings.organizationCapacity,'number','required min="0"')}${field('endsAt','活动结束时间（订单在此之前有效）',settings.endsAt.replace(' ','T'),'datetime-local','required step="1"')}</div><label class="check-label"><input name="registrationOpen" type="checkbox" ${settings.registrationOpen?'checked':''}>开放报名</label>${field('contact','工作人员联系方式 / 联系提示',settings.contact,'text','required maxlength="1000"')}${field('privacyEntity','个人信息处理主体',settings.privacyEntity,'text','required maxlength="1000"')}<label class="field"><span>退款与支付说明</span><textarea name="refundPolicy" maxlength="1000">${text(settings.refundPolicy)}</textarea></label><label class="check-label"><input name="legalConfirmed" type="checkbox" ${settings.legalConfirmed?'checked':''}>负责人已确认正式隐私、费用及退款条款</label><button class="btn">保存活动设置</button></form></section><section class="card"><h3>工作人员与权限</h3>${users.map(item=>`<div class="activity-item row spread"><span>${text(item.username)}</span><span class="badge gray">${roleLabels[item.role]}</span></div>`).join('')}<div class="divider"></div><form id="user-form"><h3>新增工作账号</h3>${field('username','账号','','text','required pattern="[a-zA-Z0-9_-]{3,40}"')}${field('password','初始密码（6–72 位，包含字母和数字）','','password','required minlength="6" maxlength="72" pattern="(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{6,72}" title="请输入 6–72 位字母和数字，至少包含一个字母和一个数字" autocomplete="new-password"')}<label class="field"><span>工作权限</span><select name="role"><option value="reviewer">报名审核</option><option value="finance">财务</option><option value="checkin">现场核销</option></select></label><button class="btn secondary">创建工作账号</button></form></section></div>`,renderState);}
function resolveScannedTicket(value){
 const form=document.querySelector('#resolve-form');
 if(!form)return;
 ticket=null;
 document.querySelector('#ticket-result').innerHTML=empty('正在查询电子票…');
 form.elements.token.value=value;
 form.requestSubmit();
}
function chooseQrPhoto(fromAlbum=false){
 stopCamera();
 const input=document.querySelector(fromAlbum?'#scan-album':'#scan-photo');
 input.value='';
 input.click();
}
async function scanPhoto(input){
 const file=input.files?.[0];if(!file)return;
 stopCamera();const currentScan=scanVersion;
 ticketQueryVersion++;ticket=null;document.querySelector('#resolve-form').elements.token.value='';document.querySelector('#ticket-result').innerHTML=empty('请稍候，正在识别新电子票。');
 document.querySelector('#scanner').textContent='正在识别二维码…';
 try{
  const value=await readQrFile(file);
  if(currentScan!==scanVersion||tab!=='checkin')return;
  stopCamera();resolveScannedTicket(value);
 }catch(error){
  if(currentScan!==scanVersion||tab!=='checkin')return;
  document.querySelector('#scanner').textContent=error.message;document.querySelector('#ticket-result').innerHTML=empty('未识别到可用电子票，请重新拍照、选择截图或输入报名信息。');toast(error.message);
 }finally{input.value='';}
}
async function scan(){
 if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){chooseQrPhoto();return;}
 stopCamera();const currentScan=scanVersion;
 ticketQueryVersion++;ticket=null;document.querySelector('#resolve-form').elements.token.value='';document.querySelector('#ticket-result').innerHTML=empty('请将二维码对准摄像头。');
 try{
  const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
  if(currentScan!==scanVersion||tab!=='checkin'){stream.getTracks().forEach(track=>track.stop());return;}
  cameraStream=stream;
  const video=document.createElement('video');video.className='video-preview';video.playsInline=true;video.muted=true;video.srcObject=stream;
  const stopButton=document.createElement('button');stopButton.type='button';stopButton.className='btn secondary';stopButton.dataset.action='stop-scan';stopButton.textContent='停止扫码';
  document.querySelector('#scanner').replaceChildren(video,stopButton);await video.play();
  cameraTimer=setInterval(()=>{
   if(currentScan!==scanVersion||tab!=='checkin'||!document.body.contains(video)){stopCamera();return;}
   try{const value=decodeQr(video,1000);if(value){stopCamera();resolveScannedTicket(value);}}
   catch{stopCamera();toast('识别未完成，请使用“拍照扫码”或“从相册识别”。');}
  },500);
 }catch{
  if(currentScan!==scanVersion)return;
  stopCamera();toast('无法打开实时摄像头，请使用“拍照扫码”或“从相册识别”。');
 }
}
function captureFilters(){if(tab==='manual-checkin'&&document.querySelector('#manual-search')){manualFilters.search=document.querySelector('#manual-search').value.trim();manualFilters.status=document.querySelector('#manual-status').value;return;}if(!listFilters[tab]||!document.querySelector('#search'))return;listFilters[tab]={search:document.querySelector('#search').value.trim(),status:document.querySelector('#filter-status').value,type:document.querySelector('#filter-type').value};}
function openRefundDialog(orderId){
 const dialog=openDialog('确认模拟退款',`<div class="note amber">确认后该订单的电子票会失效，未入场席位会释放；已经核销的票不能在此退款。</div><form><label class="field"><span>退款原因 *</span><textarea name="reason" required maxlength="500" placeholder="请填写退款原因"></textarea></label><div class="form-footer"><button type="button" class="btn secondary" data-close-dialog>暂不退款</button><button class="btn danger">确认模拟退款</button></div></form>`);
 dialog.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{await api(`./api/admin/orders/${orderId}/refund`,{method:'POST',body:{reason:event.target.elements.reason.value}});dialog.close();toast('模拟退款完成，票据已作废');await render();}catch(error){toast(error.message);}finally{button.disabled=false;}});
}
window.addEventListener('pagehide',stopCamera);

document.addEventListener('click',async event=>{
 const button=event.target.closest('button');if(!button)return;try{
  if(button.dataset.tab){ticketQueryVersion++;captureFilters();stopCamera();tab=button.dataset.tab;await render();return;}
  if(button.dataset.editPrice){openPriceDialog(button.dataset.editPrice);return;}
  if(button.dataset.manualCheckin){await openManualCheckin(button.dataset.manualCheckin);return;}
  if(button.dataset.manualPage){captureFilters();manualFilters.page=Number(button.dataset.manualPage);await render();return;}
  if(button.dataset.pickTicket){await selectTicket(button.dataset.pickTicket);return;}
  if(button.dataset.open){openDetail(button.dataset.open);return;}
  if(button.dataset.retry){await api(`./api/admin/jobs/${button.dataset.retry}/retry`,{method:'POST',body:{}});toast('已加入重试队列');await render();}
  if(button.dataset.refund){openRefundDialog(button.dataset.refund);return;}
  const action=button.dataset.action;if(action==='manual-search'){captureFilters();manualFilters.page=1;await render();return;}if(action==='logout'){ticketQueryVersion++;stopCamera();await api('./api/admin/logout',{method:'POST',body:{}});user=null;tab='overview';ticket=null;login();}if(action==='refresh'||action==='search'){captureFilters();await render();}if(action==='close')button.closest('.modal-backdrop').close?.();if(action==='scan')chooseQrPhoto();if(action==='scan-album')chooseQrPhoto(true);if(action==='scan-live')await scan();if(action==='stop-scan')stopCamera();
 }catch(error){toast(error.message);}
});
document.addEventListener('change',event=>{if(event.target.id==='manual-status'){captureFilters();manualFilters.page=1;render();return;}if(['scan-photo','scan-album'].includes(event.target.id)){scanPhoto(event.target);return;}if(event.target.name==='member'){const form=event.target.form,selected=new FormData(form).getAll('member').length;const submit=form.querySelector('button');submit.disabled=selected===0;submit.textContent=selected?`确认 ${selected} 位成员入场 ✓`:'请先勾选本次到场成员';}if(['filter-status','filter-type'].includes(event.target.id)){captureFilters();render();}});
document.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.id==='manual-search'){event.preventDefault();captureFilters();manualFilters.page=1;render();return;}if(event.key==='Enter'&&event.target.id==='search'){event.preventDefault();captureFilters();render();}});
document.addEventListener('submit',async event=>{
 const form=event.target;if(!['login','decision-form','resolve-form','checkin-form','settings-form','user-form'].includes(form.id))return;event.preventDefault();if(form.id==='resolve-form'){await resolveTicketForm(form);return;}const fields=formObject(form),button=form.querySelector('button[type="submit"]')||form.querySelector('button:last-child');if(button)button.disabled=true;
 try{
  if(form.id==='login'){user=await api('./api/admin/login',{method:'POST',body:fields});tab=initialPage();ticket=null;await render();}
  if(form.id==='decision-form'){const body={status:fields.status,note:fields.note};if(fields.fee!==undefined&&fields.fee!=='')body.feeCents=Math.round(Number(fields.fee)*100);await api(`./api/admin/applications/${form.dataset.id}/decision`,{method:'POST',body});form.closest('.modal-backdrop').close();toast('处理结果已保存，申请人刷新即可查看');await render();}
  if(form.id==='checkin-form'){
   const submittedTicket=ticket,queryVersion=ticketQueryVersion;
   if(!submittedTicket)throw new Error('请先查询电子票，再选择本次入场成员。');
   const memberIds=new FormData(form).getAll('member');
   const result=await api('./api/admin/checkins',{method:'POST',body:{ticketId:submittedTicket.id,memberIds}});
   toast(`本次入场 ${result.count} 人，累计 ${result.totalUsed} / ${result.total} 人`);
   if(queryVersion===ticketQueryVersion&&form.isConnected)await selectTicket(submittedTicket.token,queryVersion);
  }
  if(form.id==='settings-form'){for(const name of ['familyFee','extraMealFee'])if(!/^\d{1,6}(\.\d{1,2})?$/.test(fields[name]))throw new Error('费用请填写有效金额，最多两位小数。');const body={...fields,familyFeeCents:Math.round(Number(fields.familyFee)*100),extraMealFeeCents:Math.round(Number(fields.extraMealFee)*100),capacity:Number(fields.capacity),organizationCapacity:Number(fields.organizationCapacity),endsAt:fields.endsAt.replace('T',' ').padEnd(19,':00'),registrationOpen:fields.registrationOpen==='on',legalConfirmed:fields.legalConfirmed==='on'};await api('./api/admin/settings',{method:'PUT',body});toast('活动设置已保存');await render();}
  if(form.id==='user-form'){await api('./api/admin/users',{method:'POST',body:fields});toast('工作账号已创建');await render();}
 }catch(error){toast(error.message);}finally{if(button)button.disabled=false;}
});
try{const configuration=await api('./api/event');topicNames=configuration.topicNames;organizationFeeCents=configuration.organizationFeeCents;user=await api('./api/admin/me');tab=initialPage();ticket=null;await render();}catch(error){login();}

document.addEventListener('input',event=>{if(event.target.matches('#resolve-form [name=token]')){ticketQueryVersion++;stopCamera();ticket=null;document.querySelector('#ticket-result').innerHTML=empty('输入已更改，请重新查询电子票。');}});

function ticketCandidates(records){return `<h3>找到 ${records.length} 张票，请选择</h3><p class="small muted">请核对姓名、手机号和报名号，避免重名误选。</p>${records.map(record=>`<div class="lookup-record"><div><b>${text(record.name)}</b> ${badge(record.status)}<p class="small muted">${text(record.code)} · ${text(record.mobile)}</p></div><button class="btn secondary" data-pick-ticket="${text(record.token)}">选择这张票</button></div>`).join('')}`;}
async function selectTicket(token,queryVersion=++ticketQueryVersion){
 const resolved=await api(`./api/admin/tickets/resolve?token=${encodeURIComponent(token)}`);
 if(queryVersion!==ticketQueryVersion||tab!=='checkin'||!document.querySelector('#ticket-result'))return;
 ticket=resolved;document.querySelector('#ticket-result').innerHTML=ticketPanel();
}
async function resolveTicketForm(form){
 stopCamera();const queryVersion=++ticketQueryVersion;
 const button=form.querySelector('button[type="submit"]');button.disabled=true;
 ticket=null;document.querySelector('#ticket-result').innerHTML=empty('正在查询电子票…');
 try{
  const records=await api(`./api/admin/tickets/search?query=${encodeURIComponent(form.elements.token.value.trim())}`);
  if(queryVersion!==ticketQueryVersion||tab!=='checkin'||!form.isConnected)return;
  if(!records.length)throw new Error('未找到电子票，请核对信息并确认已完成付款。');
  if(records.length===1)await selectTicket(records[0].token,queryVersion);
  else document.querySelector('#ticket-result').innerHTML=ticketCandidates(records);
 }catch(error){
  if(queryVersion!==ticketQueryVersion||!form.isConnected)return;
  ticket=null;document.querySelector('#ticket-result').innerHTML=empty('没有查到可用电子票，请核对后重新查询。');toast(error.message);
 }finally{if(form.isConnected)button.disabled=false;}
}
