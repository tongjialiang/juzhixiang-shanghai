import test from 'node:test';
import assert from 'node:assert/strict';
import {api,escapeHtml,badge} from '../public/shared.js';
import {newRequestId} from '../public/shared.js';
test('局域网HTTP可使用不依赖randomUUID的请求标识',()=>{const ids=Array.from({length:50},()=>newRequestId());assert.equal(new Set(ids).size,50);assert(ids.every(id=>/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id)));});
test('联系人及问题中的HTML不会作为网页代码显示',()=>assert.equal(escapeHtml('<img src=x onerror="x">'), '&lt;img src=x onerror=&quot;x&quot;&gt;'));
test('未知状态也会转义后再展示',()=>assert(!badge('<script>alert(1)</script>').includes('<script>')));
test('断网时返回自然中文提示',async context=>{
 context.mock.method(globalThis,'fetch',async()=>{throw new TypeError('Failed to fetch');});await assert.rejects(api('/api/event'),/暂时无法连接服务/);
});
test('服务器返回非JSON时提供可读提示',async context=>{
 context.mock.method(globalThis,'fetch',async()=>new Response('<html>Bad gateway</html>',{status:502}));await assert.rejects(api('/api/event'),/服务暂时没有正常响应/);
});
test('接口权限错误保留状态码以便前端返回登录',async context=>{
 context.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({error:'请先登录'}),{status:401}));await assert.rejects(api('/api/admin/me'),error=>error.status===401&&error.message==='请先登录');
});
