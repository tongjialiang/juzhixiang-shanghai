import {marked} from './vendor/marked.js';
import DOMPurify from './vendor/purify.js';
export function renderMarkdown(value){
 const html=marked.parse(String(value||''),{gfm:true,breaks:true,async:false});
 return DOMPurify.sanitize(html,{USE_PROFILES:{html:true},FORBID_TAGS:['img','video','audio','iframe','form','input','button','style'],FORBID_ATTR:['style']});
}
