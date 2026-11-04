import './vendor/jsQR.js';

// 图片只在当前浏览器内识别，不上传到服务器。
function readImage(file){
 return new Promise((resolve,reject)=>{
  const reader=new FileReader();
  reader.onerror=()=>reject(new Error('图片读取失败，请重新选择。'));
  reader.onload=()=>{
   const image=new Image();
   image.onload=()=>resolve(image);
   image.onerror=()=>reject(new Error('无法打开这张图片，请改用 JPG、PNG 或电子票截图。'));
   image.src=reader.result;
  };
  reader.readAsDataURL(file);
 });
}

export function decodeQr(source,maxEdge=1600){
 const sourceWidth=source.videoWidth||source.naturalWidth||source.width;
 const sourceHeight=source.videoHeight||source.naturalHeight||source.height;
 if(!sourceWidth||!sourceHeight)return null;
 const scale=Math.min(1,maxEdge/Math.max(sourceWidth,sourceHeight));
 const canvas=document.createElement('canvas');
 canvas.width=Math.max(1,Math.round(sourceWidth*scale));
 canvas.height=Math.max(1,Math.round(sourceHeight*scale));
 const context=canvas.getContext('2d',{willReadFrequently:true});
 context.drawImage(source,0,0,canvas.width,canvas.height);
 const pixels=context.getImageData(0,0,canvas.width,canvas.height);
 return window.jsQR(pixels.data,pixels.width,pixels.height,{inversionAttempts:'attemptBoth'})?.data||null;
}

export async function readQrFile(file){
 if(!file)return null;
 if(file.size>20*1024*1024)throw new Error('图片过大，请选用 20MB 以内的照片或截图。');
 if(file.type&&!file.type.startsWith('image/'))throw new Error('请选择电子票图片或拍摄二维码。');
 const image=await readImage(file);
 const result=decodeQr(image)||decodeQr(image,2400);
 if(!result)throw new Error('没有识别到二维码，请靠近拍摄，确保二维码完整清晰，或选择电子票截图。');
 return result;
}
