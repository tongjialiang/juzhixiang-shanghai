import {z} from 'zod';
export const topicNames=['未来居住与日常生活','生活能力与自主性','行为理解与沟通支持','工作与社会参与','家庭之外的长期支持','未来生活与保障准备','父母自身养老与双养','其他／希望先了解整体内容'];
export const organizationCategories=['学术科研','保险','照护','器具厂家','公益社会组织','医疗','其他'];
export const applicationSchema=z.object({
 type:z.enum(['family','organization']),name:z.string().trim().min(1).max(40),mobile:z.string().regex(/^1[3-9]\d{9}$/),
 idempotencyKey:z.string().uuid('申请标识无效，请刷新后重试'),
 profile:z.object({relationship:z.enum(['父母','ASD本人','兄弟姐妹','照护支持者','其他']).optional(),asdAge:z.enum(['<25','25–34','35–44','45–54','55+','不便提供']).optional(),parentAge:z.enum(['<50','50–59','60–69','70+','不便提供']).optional(),
 count:z.number().int().min(1).max(200),members:z.array(z.enum(['成年ASD本人','父亲','母亲','亲属','照护支持者','专业人士','其他'])).min(1).max(200),fourthMeal:z.boolean().default(false),
 supporter:z.string().max(80).optional(),living:z.string().max(80).optional(),supportNeed:z.string().max(300).optional(),
 orgCategory:z.enum(organizationCategories).optional(),orgName:z.string().max(100).optional(),orgRole:z.string().max(80).optional(),orgFocus:z.string().max(150).optional(),
 otherDetail:z.string().max(300).optional(),helpType:z.string().max(80).optional()}),
 topics:z.array(z.enum(['N01','N02','N03','N04','N05','N06','N07','N08'])).max(3).refine(topics=>new Set(topics).size===topics.length),
 question:z.string().max(300).default(''),channel:z.string().max(100).default('直接访问'),
 consent:z.object({privacy:z.literal(true),sensitive:z.literal(true),pilot:z.boolean().default(false),photo:z.boolean().default(false),share:z.boolean().default(false),model:z.boolean().default(false),payment:z.literal(true)})
}).superRefine((value,context)=>{
 const profile=value.profile;
 if(profile.members.length!==profile.count)context.addIssue({code:'custom',message:'参加人数与成员名单不一致',path:['profile','members']});
 if(value.type==='family'&&(!profile.relationship||!profile.asdAge||!profile.parentAge||!value.topics.length))context.addIssue({code:'custom',message:'请补全家庭画像并选择研修主题',path:['profile']});
 if(value.type==='organization'&&(!profile.orgCategory||!profile.orgName?.trim()||!profile.orgRole?.trim()||!profile.orgFocus?.trim()))context.addIssue({code:'custom',message:'请补全机构资料',path:['profile']});
});
export function reviewApplication(application){
 const reasons=[];const profile=application.profile;
 if(application.type==='organization')reasons.push('机构名额与收费需由工作人员确认');
 else {
  if(profile.count>4)reasons.push('超过四人的参加安排需单独确认');
  if(profile.asdAge==='<25'||profile.asdAge==='不便提供')reasons.push('年龄范围需人工确认');
  if(!profile.members.some(member=>member.includes('ASD')))reasons.push('本人未到场，需确认参加安排');
 }
 // 父母年龄、支持程度、研修主题、开放问题和后续服务意向不作为拒绝条件。
 return {status:reasons.length?'MANUAL_REVIEW':'APPROVED',source:reasons.length?null:'AUTO',reasons,version:'宽松规则-v1'};
}
export const defaultFamilyPricing={familyFeeCents:250000,extraMealFeeCents:2500};
export function familyAmount(profile,pricing=defaultFamilyPricing){return (pricing.familyFeeCents??defaultFamilyPricing.familyFeeCents)+(profile.count===4&&profile.fourthMeal?(pricing.extraMealFeeCents??defaultFamilyPricing.extraMealFeeCents):0);}
export function deidentify(text){return String(text??'').replace(/1[3-9]\d{9}/g,'[已隐去手机]').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[已隐去邮箱]').replace(/\d{15,18}[Xx]?/g,'[已隐去证件]').replace(/(?:姓名|名字|叫|联系人)[：:是]?\s*[\u4e00-\u9fa5]{2,4}/g,'[已隐去姓名]');}
