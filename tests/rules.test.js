import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewApplication,familyAmount,applicationSchema} from '../server/rules.js';
const family={type:'family',profile:{count:3,asdAge:'25–34',parentAge:'<50',members:['成年ASD本人','父亲','母亲']},topics:['N03'],consent:{pilot:false}};
test('宽松规则：父母年龄和主题选择不阻止自动通过',()=>assert.equal(reviewApplication(family).status,'APPROVED'));
test('年龄例外进入人工确认，不直接拒绝',()=>assert.equal(reviewApplication({...family,profile:{...family.profile,asdAge:'<25'}}).status,'MANUAL_REVIEW'));
test('父母单独到场转人工确认',()=>assert.equal(reviewApplication({...family,profile:{...family.profile,members:['父亲','母亲']}}).status,'MANUAL_REVIEW'));
test('机构不自动套用家庭收费',()=>assert.equal(reviewApplication({type:'organization',profile:{count:1}}).status,'MANUAL_REVIEW'));
test('第四人午餐只加收25元',()=>{assert.equal(familyAmount({count:4,fourthMeal:true}),252500);assert.equal(familyAmount({count:4,fourthMeal:false}),250000);assert.equal(familyAmount({count:3,fourthMeal:true}),250000);});

test('家庭收费按配置计算，零金额配置不使用默认价',()=>{
 const pricing={familyFeeCents:188888,extraMealFeeCents:3501};
 assert.equal(familyAmount({count:3,fourthMeal:true},pricing),188888);
 assert.equal(familyAmount({count:4,fourthMeal:true},pricing),192389);
 assert.equal(familyAmount({count:4,fourthMeal:false},pricing),188888);
 assert.equal(familyAmount({count:4,fourthMeal:true},{familyFeeCents:0,extraMealFeeCents:0}),0);
});
