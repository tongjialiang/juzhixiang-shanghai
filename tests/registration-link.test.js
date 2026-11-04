import test from 'node:test';
import assert from 'node:assert/strict';
import {registrationLink} from '../server/registration-link.js';

test('本机宣传页二维码使用局域网地址并保留子目录',()=>{
 assert.equal(registrationLink('http://127.0.0.1:3088','/shanghai2026','http://192.168.1.142:3088'), 'http://192.168.1.142:3088/shanghai2026/apply');
 assert.equal(registrationLink('http://localhost:3088','','http://192.168.1.142:3088/shanghai2026'), 'http://192.168.1.142:3088/apply');
});

test('局域网和公网二维码使用当前访问域名',()=>{
 assert.equal(registrationLink('http://192.168.1.142:3088','/shanghai2026','http://127.0.0.1:3088'), 'http://192.168.1.142:3088/shanghai2026/apply');
 assert.equal(registrationLink('https://events.izhaohu.com','/shanghai2026','http://192.168.1.142:3088'), 'https://events.izhaohu.com/shanghai2026/apply');
});

test('未配置有效局域网地址时仍可本机访问',()=>{
 for(const configuredOrigin of ['', 'invalid', 'http://127.0.0.1:3089', 'file:///tmp']) {
  assert.equal(registrationLink('http://localhost:3089','/shanghai2026/',configuredOrigin), 'http://localhost:3089/shanghai2026/apply');
 }
 assert.equal(registrationLink('http://[::1]:3089','', 'http://192.168.1.142:3088'), 'http://192.168.1.142:3088/apply');
});
