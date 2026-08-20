/* QA PR3 · G10: детерминированные скриншоты секций для сравнения «до/после».
   Снимаются против двух копий сайта (HEAD на :8153 и рабочее дерево на :8152).
   Эффектные канвасы (пыль/дым/зерно) скрыты — это оверлей, не контент;
   видео стоит на первом кадре, шрифты дожидаются document.fonts.ready.
   Использование: node qa-pr3-shots.js <base-url> <tag> */
const { chromium } = require('/home/rodriges/6and2/landing-skill-sozdanie-sayta/node_modules/playwright');
const fs = require('fs');
const EXE = [
  '/home/rodriges/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell',
  '/usr/bin/google-chrome'
].find(p => fs.existsSync(p));

const BASE = process.argv[2] || 'http://127.0.0.1:8152';
const TAG = process.argv[3] || 'after';
const DIR = '/home/rodriges/6and2qween';
const SECTIONS = ['hero', 'manifest', 'atmosfera', 'story', 'menu', 'cabinets', 'club', 'afisha', 'reviews', 'faq', 'contacts'];
const SEL = id => ({ hero: '.hero', manifest: '.manifest' }[id] || '#' + id);

const STABILIZE = `(() => {
  const st = document.createElement('style');
  st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' +
    '#dust,#smokeFront,#smokeBack,#gateSmoke,.grain{display:none!important}';
  document.head.appendChild(st);
  document.querySelectorAll('video').forEach(v => { try { v.pause(); v.currentTime = 0.01; } catch (e) {} });
})()`;

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  for (const vp of [{ width: 1440, height: 900, tag: 'desktop' }, { width: 360, height: 640, tag: 'mobile', dsf: 2, mobile: true }]) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.dsf || 1, isMobile: !!vp.mobile, hasTouch: !!vp.mobile
    });
    const page = await ctx.newPage();
    await page.goto(BASE + '/?nogate', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#sbTimes .bk-chip', { timeout: 15000 });
    await page.evaluate(STABILIZE);
    await page.evaluate(() => document.fonts && document.fonts.ready);
    // ждём конец GSAP-интро героя (~3 с), затем замораживаем таймлайн
    await page.waitForTimeout(3500);
    await page.evaluate(() => { try { window.gsap && gsap.globalTimeline && gsap.globalTimeline.clear(); } catch (e) {} });
    await page.waitForTimeout(400);
    for (const id of SECTIONS) {
      await page.locator(SEL(id)).scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.locator(SEL(id)).screenshot({ path: `${DIR}/qa-pr3-cmp-${TAG}-${vp.tag}-${id}.png` });
    }
    await page.locator('footer').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.locator('footer').screenshot({ path: `${DIR}/qa-pr3-cmp-${TAG}-${vp.tag}-footer.png` });
    await ctx.close();
    console.log('done', vp.tag);
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
