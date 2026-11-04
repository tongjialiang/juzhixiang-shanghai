export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
export const money=cents=>`¥${(Number(cents||0)/100).toLocaleString('zh-CN',{maximumFractionDigits:2})}`;
export const time=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';
export const labels={APPROVED:'已通过',MANUAL_REVIEW:'待人工确认',NEED_INFO:'待补充信息',WAITLIST:'候补中',NOT_ADMITTED:'请联系工作人员',CANCELLED:'已取消',PAY_PENDING:'待支付',PAID:'已支付',EXPIRED:'已过期',CLOSED:'已关闭',REFUNDED:'已退款',VALID:'可入场',PARTIALLY_USED:'部分已入场',FULLY_USED:'全部已入场',VOID:'已失效',PENDING:'等待处理',PROCESSING:'处理中',DONE:'已完成',FAILED:'处理失败'};
export const badge=status=>`<span class="badge ${['APPROVED','PAID','VALID','DONE','FULLY_USED'].includes(status)?'green':['MANUAL_REVIEW','NEED_INFO','WAITLIST','PAY_PENDING','PENDING'].includes(status)?'amber':'gray'}">${labels[status]||escapeHtml(status)}</span>`;
let toastTimer;
export function toast(message){const element=document.querySelector('#toast');clearTimeout(toastTimer);element.textContent=message;element.classList.add('show');toastTimer=setTimeout(()=>element.classList.remove('show'),5000);}
export async function api(url,options={}){
 let response;
 try{response=await fetch(url,{...options,signal:options.signal||AbortSignal.timeout(25000),headers:{'Content-Type':'application/json',...options.headers},body:options.body===undefined?undefined:JSON.stringify(options.body)});}
 catch{throw new Error('暂时无法连接服务，请检查网络后重试；已填写的信息会保留。');}
 let result;try{result=await response.json();}catch{throw new Error('服务暂时没有正常响应，请稍后重试。');}
 if(!response.ok){const error=new Error(result.error||'操作未完成，请稍后重试');error.status=response.status;throw error;}return result;
}
export function safeRead(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}}
export function save(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch{toast('浏览器未允许保存草稿，请保留报名号。');}}
export function formObject(form){return Object.fromEntries(new FormData(form));}
export const icon=name=>({leaf:'❧',arrow:'↗',check:'✓',plus:'＋',clock:'◷'}[name]||name);
export function openDialog(title,content){
 const previousFocus=document.activeElement;
 const backdrop=document.createElement('div');backdrop.className='modal-backdrop';
 backdrop.innerHTML=`<section class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><div class="modal-header"><h2>${escapeHtml(title)}</h2><button type="button" class="btn ghost" data-close-dialog>✕ 关闭</button></div>${content}</section>`;
 const previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
 function close(){document.removeEventListener('keydown',onKey);backdrop.remove();document.body.style.overflow=previousOverflow;previousFocus?.focus();}
 function onKey(event){
  if(event.key==='Escape'){event.preventDefault();close();return;}
  if(event.key==='Tab'){
   const focusable=[...backdrop.querySelectorAll('button,input,select,textarea,a[href]')].filter(element=>!element.disabled&&element.getClientRects().length);
   const first=focusable[0],last=focusable.at(-1);
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
 }
 backdrop.addEventListener('click',event=>{if(event.target===backdrop||event.target.closest('[data-close-dialog]'))close();});
 document.addEventListener('keydown',onKey);document.body.append(backdrop);backdrop.querySelector('button')?.focus();
 backdrop.close=close;return backdrop;
}
export async function copyText(value){
 if(!value)throw new Error('当前没有可复制的内容，请先查询报名。');
 try{await navigator.clipboard.writeText(value);}catch{openDialog('请手动复制',`<label class="field"><span>长按或选中以下内容复制</span><textarea readonly>${escapeHtml(value)}</textarea></label>`);return;}
 toast('已复制');
}
export function newRequestId(){
 // getRandomValues 可在局域网 HTTP 页面使用，randomUUID 只在安全环境中可用。
 const bytes=globalThis.crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
 const hex=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
