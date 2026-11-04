// 本机预览时优先使用配置的局域网地址，让手机能够打开报名页。
export function registrationLink(currentOrigin, basePath = '', configuredOrigin = '') {
 const currentAddress = new URL(currentOrigin);
 const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];
 let publicOrigin = currentAddress.origin;
 if (loopbackHosts.includes(currentAddress.hostname) && configuredOrigin) {
  try {
   const configuredAddress = new URL(configuredOrigin);
   if (['http:', 'https:'].includes(configuredAddress.protocol) && !loopbackHosts.includes(configuredAddress.hostname)) {
    publicOrigin = configuredAddress.origin;
   }
  } catch {
   // 配置不完整时，仍可通过当前访问地址打开报名页。
  }
 }
 return `${publicOrigin}${basePath.replace(/\/$/, '')}/apply`;
}
