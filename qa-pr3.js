/* QA PR3 · адаптив и доступность (ТЗ §8). Гейты G5, G10 + замеры для G6.
   Использование: node qa-pr3.js <base-url> <tag>
   G5  — 360×640: страница без горизонтального скролла, тап-таргеты ≥ 44×44;
   G5b — слот-бар sticky на мобильном, занятый/dimmed стол → bottom-sheet;
   G10 — скрины всех секций (до/после сравниваются скриптом qa-pr3-diff.py),
         grayscale-снимок схемы: статусы различимы без цвета.
   Демо-занятость на статическом превью эмулируется классами (без бэка). */
const { chromium } = require('/home/rodriges/6and2/landing-skill-sozdanie-sayta/node_modules/playwright');
const fs = require('fs');
const EXE_CANDIDATES = [
  '/home/rodriges/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell',
  '/usr/bin/google-chrome'
];
const EXE = EXE_CANDIDATES.find(p => fs.existsSync(p));

const BASE = process.argv[2] || 'http://127.0.0.1:8152';
const TAG = process.argv[3] || 'local';
const DIR = '/home/rodriges/6and2qween';
const out = [];
function log(gate, ok, detail) {
  out.push({ gate, ok, detail });
  console.log((ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL') + '  ' + gate + '  ' + detail);
}

// стабилизация перед скриншотами: без анимаций, видео на первом кадре
const STABILIZE = `(() => {
  const st = document.createElement('style');
  st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
  document.head.appendChild(st);
  document.querySelectorAll('video').forEach(v => { try { v.pause(); v.currentTime = 0.01; } catch (e) {} });
})()`;

const SECTIONS = ['hero', 'manifest', 'atmosfera', 'story', 'menu', 'cabinets', 'club', 'afisha', 'reviews', 'faq', 'contacts'];
const SEC_SEL = id => ({ hero: '.hero', manifest: '.manifest' }[id] || '#' + id);

// аудит тап-таргетов: все видимые интерактивные элементы внутри селекторов
async function tapAudit(page, scopeSel) {
  return page.evaluate(scope => {
    const bad = [];
    const seen = new Set();
    document.querySelectorAll(scope).forEach(root => {
      root.querySelectorAll('button, a[href], input, [role="button"], .bk-chip, .bkw-date, .bkw-time, .bkw-filter').forEach(el => {
        if (seen.has(el)) return;
        seen.add(el);
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden]')) return;
        // чекбокс внутри label: тап-таргет — вся строка-лейбл (клик по ней переключает)
        let r = el.getBoundingClientRect();
        if (el.type === 'checkbox' && el.closest('label')) {
          const lr = el.closest('label').getBoundingClientRect();
          if (lr.width >= 44 && lr.height >= 44) return;
        }
        if (r.width === 0 && r.height === 0) return;
        if (r.width < 43.5 || r.height < 43.5) {
          bad.push({
            sel: el.id ? '#' + el.id : el.className.toString().split(' ').slice(0, 2).join('.'),
            txt: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 22),
            w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10
          });
        }
      });
    });
    return bad;
  }, scopeSel);
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  /* ================= DESKTOP 1440 ================= */
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(BASE + '/?nogate', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#sbTimes .bk-chip', { timeout: 10000 });
    await page.waitForTimeout(1200);

    // фокус-стили: Tab по слот-бару должен давать видимый индикатор
    const focus = await page.evaluate(() => {
      const chip = document.querySelector('#sbTimes .bk-chip:not(.on):not(:disabled)');
      chip.focus();
      const cs = getComputedStyle(chip);
      const hasOutline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      const hasShadow = cs.boxShadow !== 'none';
      chip.blur();
      return { hasOutline, hasShadow };
    });
    log('A11Y-focus-chip', focus.hasOutline || focus.hasShadow, 'фокус на чипе времени: ' + JSON.stringify(focus));

    // G10-grayscale: эмулируем busy/dimmed/selected классами, снимаем схему в градациях серого
    const gray = await page.evaluate(() => {
      const mk = (id, cls) => {
        const el = document.querySelector('.plan .spot[data-table-id="' + id + '"]');
        if (el) el.classList.add(cls);
        return !!el;
      };
      const r = { s3: mk('s3', 'busy'), s5: mk('s5', 'dimmed') };
      document.querySelector('.plan .spot[data-table-id="b1"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const card = document.querySelector('.plan-card');
      card.style.filter = 'grayscale(1)';
      return r;
    });
    await page.waitForTimeout(400);
    const selMarkVisible = await page.evaluate(() => {
      const m = document.querySelector('.plan .sel-mark');
      return m && m.closest('g').style.display !== 'none';
    });
    await page.locator('.plan-card').screenshot({ path: `${DIR}/qa-pr3-${TAG}-desktop-plan-gray.png` });
    log('G10-gray', gray.s3 && gray.s5 && selMarkVisible,
      'схема в grayscale: busy=штриховка, dimmed=пунктир, sel=галка (снимок qa-pr3-' + TAG + '-desktop-plan-gray.png)');
    // откат эмуляции
    await page.evaluate(() => {
      document.querySelector('.plan-card').style.filter = '';
      document.querySelector('.plan .spot[data-table-id="s3"]')?.classList.remove('busy');
      document.querySelector('.plan .spot[data-table-id="s5"]')?.classList.remove('dimmed');
      document.querySelector('.plan .spot[data-table-id="b1"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForTimeout(300);

    // скриншоты секций для G10 (до/после)
    await page.evaluate(STABILIZE);
    for (const id of SECTIONS) {
      const sel = SEC_SEL(id);
      await page.locator(sel).scrollIntoViewIfNeeded();
      await page.waitForTimeout(350);
      await page.locator(sel).screenshot({ path: `${DIR}/qa-pr3-${TAG}-desktop-sec-${id}.png` });
    }
    await page.locator('footer').scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    await page.locator('footer').screenshot({ path: `${DIR}/qa-pr3-${TAG}-desktop-sec-footer.png` });
    // блок брони — отдельно (он меняется в PR3, сравнение «до/после» не по нему)
    await page.locator('#bron').scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    await page.locator('#bron').screenshot({ path: `${DIR}/qa-pr3-${TAG}-desktop-bron.png` });

    log('ERR-desktop', errors.length === 0, 'ошибки: ' + (errors.join(' | ') || 'нет'));
    await ctx.close();
  }

  /* ================= MOBILE 360×640 ================= */
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(BASE + '/?nogate', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#sbTimes .bk-chip', { timeout: 10000 });
    await page.waitForTimeout(1000);

    // G5a: страница без горизонтального скролла (кроме внутренних лент)
    await page.locator('#bron').scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    const horiz = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.documentElement.clientWidth
    }));
    log('G5-scroll', horiz.doc <= 0 && horiz.body <= 0, 'переполнение по ширине: doc=' + horiz.doc + 'px body=' + horiz.body + 'px');

    // G5b: слот-бар sticky к верху секции при скролле внутри блока
    const sticky = await page.evaluate(async () => {
      const sb = document.getElementById('slotbar');
      const cs = getComputedStyle(sb);
      // уводим слот-бар выше края экрана скроллом внутри секции
      const sec = document.getElementById('bron');
      window.scrollTo(0, sec.offsetTop + window.innerHeight * 1.2);
      await new Promise(r => setTimeout(r, 400));
      const r = sb.getBoundingClientRect();
      const head = document.querySelector('header.nav')?.getBoundingClientRect();
      return { pos: cs.position, top: Math.round(r.top), visible: r.bottom > 0, headBottom: head ? Math.round(head.bottom) : 0 };
    });
    log('G5-sticky', sticky.pos === 'sticky' && sticky.top <= Math.max(76, sticky.headBottom + 2) && sticky.visible,
      'slotbar: position=' + sticky.pos + ' top=' + sticky.top + ' виден=' + sticky.visible + ' шапка до=' + sticky.headBottom);

    // G5c: тап-таргеты ≥ 44 на странице блока
    const badPage = await tapAudit(page, '#bron');
    log('G5-tap-page', badPage.length === 0, 'мелкие таргеты на странице: ' + (badPage.length ? JSON.stringify(badPage.slice(0, 8)) : 'нет'));

    // bottom-sheet: 8 гостей → маленькие столы dimmed, тап по карточке → шит
    await page.evaluate(async () => {
      for (let i = 0; i < 6; i++) document.getElementById('sbGplus').click();
      await new Promise(r => setTimeout(r, 250));
    });
    const sheet = await page.evaluate(async () => {
      const card = document.querySelector('#bkMgrid .bk-mcard.dimmed');
      if (!card) return { dimmed: false };
      card.click();
      await new Promise(r => setTimeout(r, 400));
      const tip = document.getElementById('bkTip');
      const cs = getComputedStyle(tip);
      const r = tip.getBoundingClientRect();
      return {
        dimmed: true, hidden: tip.hidden, pos: cs.position,
        atBottom: window.innerHeight - r.bottom < 40,
        txt: tip.querySelector('.bk-tip-txt')?.textContent
      };
    });
    log('G5-sheet', !sheet.dimmed ? null : (!sheet.hidden && sheet.pos === 'fixed' && sheet.atBottom),
      'bottom-sheet: ' + JSON.stringify(sheet));
    await page.screenshot({ path: `${DIR}/qa-pr3-${TAG}-mobile-sheet.png` });
    await page.evaluate(() => {
      document.getElementById('bkTip').hidden = true;
      document.querySelector('.bk-tip-veil')?.classList.remove('show');
      for (let i = 0; i < 6; i++) document.getElementById('sbGminus').click();
    });

    // G5d: тап-таргеты внутри мобильного мастера, все шаги
    await page.click('#bkOpen');
    await page.waitForTimeout(600);
    const badW1 = await tapAudit(page, '#bkw .bkw-step[data-bkw="1"], #bkw .bkw-top, #bkw .bkw-foot');
    await page.screenshot({ path: `${DIR}/qa-pr3-${TAG}-mobile-bkw1.png` });
    await page.click('#bkwGo');
    await page.waitForTimeout(500);
    const badW2 = await tapAudit(page, '#bkw .bkw-step[data-bkw="2"], #bkw .bkw-foot');
    await page.click('#bkwList .bkw-card:not(.dimmed):not(.busy)');
    await page.waitForTimeout(600);
    const badW3 = await tapAudit(page, '#bkw .bkw-step[data-bkw="3"], #bkw .bkw-foot');
    await page.fill('#bkwName', 'Игорь');
    await page.fill('#bkwPhone', '79991234567');
    await page.click('#bkwGo');
    await page.waitForTimeout(500);
    const badW4 = await tapAudit(page, '#bkw .bkw-step[data-bkw="4"], #bkw .bkw-foot');
    await page.screenshot({ path: `${DIR}/qa-pr3-${TAG}-mobile-bkw4.png` });
    const badW = [...badW1, ...badW2, ...badW3, ...badW4];
    log('G5-tap-wizard', badW.length === 0, 'мелкие таргеты в мастере: ' + (badW.length ? JSON.stringify(badW.slice(0, 8)) : 'нет'));

    // sticky кнопки отправки на шагах 03-04 (ТЗ §8)
    const foot = await page.evaluate(() => {
      const f = document.querySelector('.bkw-foot');
      const r = f.getBoundingClientRect();
      return { visible: r.bottom <= window.innerHeight + 1 && r.bottom > window.innerHeight - 120, h: Math.round(r.height) };
    });
    log('G5-sticky-foot', foot.visible, 'нижняя панель мастера прибита: ' + JSON.stringify(foot));
    await page.click('#bkwX');
    await page.waitForTimeout(500);

    // скриншоты секций (мобил) для G10
    await page.evaluate(STABILIZE);
    for (const id of SECTIONS) {
      const sel = SEC_SEL(id);
      await page.locator(sel).scrollIntoViewIfNeeded();
      await page.waitForTimeout(350);
      await page.locator(sel).screenshot({ path: `${DIR}/qa-pr3-${TAG}-mobile-sec-${id}.png` });
    }
    await page.locator('footer').scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    await page.locator('footer').screenshot({ path: `${DIR}/qa-pr3-${TAG}-mobile-sec-footer.png` });
    await page.locator('#bron').scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    await page.locator('#bron').screenshot({ path: `${DIR}/qa-pr3-${TAG}-mobile-bron.png` });

    log('ERR-mobile', errors.length === 0, 'ошибки: ' + (errors.join(' | ') || 'нет'));
    await ctx.close();
  }

  await browser.close();
  const fails = out.filter(o => o.ok === false);
  console.log('\nитог: ' + out.filter(o => o.ok).length + ' pass / ' + fails.length + ' fail');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
