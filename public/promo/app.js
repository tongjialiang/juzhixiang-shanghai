(() => {
  // 宣传页和报名页使用同一费用配置，避免后台改价后仍展示旧金额。
  fetch('../api/event',{cache:'no-store'}).then(response=>{
    if(!response.ok)throw new Error('费用读取失败');
    return response.json();
  }).then(configuration=>{
    const formatFee=cents=>'¥'+(cents/100).toLocaleString('zh-CN',{maximumFractionDigits:2});
    document.querySelectorAll('[data-family-fee]').forEach(element=>element.textContent=formatFee(configuration.familyFeeCents));
    document.querySelectorAll('[data-extra-meal-fee]').forEach(element=>element.textContent=formatFee(configuration.extraMealFeeCents));
    document.querySelectorAll('[data-organization-fee]').forEach(element=>element.textContent=formatFee(configuration.organizationFeeCents));
  }).catch(()=>{
    document.querySelectorAll('[data-family-fee],[data-extra-meal-fee],[data-organization-fee]').forEach(element=>element.textContent='以报名页为准');
  });
  const toggle = document.querySelector('.type-toggle');
  const setLargeType = enabled => {
    document.body.classList.toggle('large-type', enabled);
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.setAttribute('aria-label', enabled ? '恢复标准字号' : '开启大字阅读');
    toggle.textContent = enabled ? '标准字号' : '大字阅读';
  };
  try { setLargeType(localStorage.getItem('family-seminar-large-type') === 'true'); } catch {}
  toggle.addEventListener('click', () => {
    const enabled = toggle.getAttribute('aria-pressed') !== 'true';
    setLargeType(enabled);
    try { localStorage.setItem('family-seminar-large-type', String(enabled)); } catch {}
  });

  const configured = window.EVENT_CONFIG?.registrationUrl?.trim();
  let registrationUrl = null;
  try { const url = new URL(configured, location.href); if (url.origin === location.origin || url.protocol === 'https:') registrationUrl = configured; } catch {}
  if (registrationUrl) {
    document.querySelectorAll('[data-register-link]').forEach(link => {
      link.href = registrationUrl;
      link.firstChild.textContent = (link.dataset.registerLabel || '申请参与研修') + ' ';
    });
  }

  // 导航按实际阅读位置高亮，滚动到页尾时保持最后一个内容区高亮。
  const navigation = document.querySelector('.section-nav');
  const navigationLinks = [...navigation.querySelectorAll('a')];
  const sections = [...document.querySelectorAll('main > section')];
  let navigationFrame = 0;
  const updateNavigation = () => {
    navigationFrame = 0;
    const readingTop = navigation.getBoundingClientRect().bottom + 24;
    let currentSection = sections[0];
    sections.forEach(section => {
      if (section.getBoundingClientRect().top <= readingTop) currentSection = section;
    });
    if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8) {
      currentSection = sections[sections.length - 1];
    }
    navigationLinks.forEach(link => {
      if (link.hash === '#' + (currentSection.dataset.navigation || currentSection.id)) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  };
  const scheduleNavigationUpdate = () => {
    if (!navigationFrame) navigationFrame = requestAnimationFrame(updateNavigation);
  };
  window.addEventListener('scroll', scheduleNavigationUpdate, {passive:true});
  window.addEventListener('resize', scheduleNavigationUpdate);
  window.addEventListener('load', scheduleNavigationUpdate);
  updateNavigation();
})();
