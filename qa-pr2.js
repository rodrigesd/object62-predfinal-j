/* QA PR2 · slot-first. Проверяет гейты G1, G4, G7 и базовые взаимодействия.
   Использование: node qa-pr2.js <base-url> <tag>
   Для G7 нужен бэкенд с DEMO_BUSY s3 19:30–21:30 (wrangler dev). */
const { chromium } = require('/home/rodriges/6and2/landing-skill-sozdanie-sayta/node_modules/playwright');
const EXE = '/home/rodriges/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell';
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8152';
const TAG = process.argv[3] || 'local';
const out = [];
function log(gate, ok, detail) {
  out.push({ gate, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + gate + '  ' + detail);
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  /* ---------- DESKTOP ---------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = [], reqs = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('request', r => reqs.push(r.url()));

    await page.goto(BASE + '/?nogate', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#sbTimes .bk-chip', { timeout: 10000 });
    // ТЗ G1: слот-бар и живая схема видны без кликов; меряем от DOMContentLoaded
    // до готовности слот-бара (сетевая загрузка тяжёлого hero-видео не в счёт)
    const tReady = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const dcl = nav ? nav.domContentLoadedEventEnd : performance.timing.domContentLoadedEventEnd;
      return Math.round(performance.now() - (dcl - (nav ? nav.startTime : 0)));
    });
    log('G1a', tReady <= 1000, 'слот-бар готов через ' + tReady + ' мс после DOMContentLoaded (лимит 1 с)');
    await page.waitForTimeout(900); // плавный скролл стартового шага успевает завершиться

    // дефолтный слот, счётчики
    const sum = await page.textContent('#sbSum');
    const cntAt = await page.textContent('#cntAt');
    log('G1b', /·\s*\d\d:\d\d\s*·\s*\d+\s(гость|гостя|гостей)/.test(sum), 'дефолт: ' + sum);
    log('G1c', /^на \d\d:\d\d свободно$/.test(cntAt), 'счётчик: ' + cntAt);

    // смена слота → перерисовка статусов ≤ 200 мс (замер на смену счётчика)
    const perf = await page.evaluate(async () => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      const chips = [...document.querySelectorAll('#sbTimes .bk-chip')].filter(b => !b.disabled);
      const target = chips[chips.length - 1];
      target.click();
      await new Promise(r => setTimeout(r, 300)); // прогрев: первый клик ещё листает шаг
      const before = norm(document.querySelector('.b-count').innerText);
      const t0 = performance.now();
      target.click(); // перерисовка синхронная: статусы и счётчики сразу в DOM
      const t1 = performance.now();
      return { label: target.textContent, before, after: norm(document.querySelector('.b-count').innerText), ms: Math.round(t1 - t0) };
    });
    log('G1d', perf.ms <= 200, 'перерисовка ' + perf.ms + ' мс (' + perf.before + ' → ' + perf.after + ')');

    // гости: степпер и dimmed
    const guests = await page.evaluate(async () => {
      const click = sel => document.querySelector(sel)?.click();
      for (let i = 0; i < 6; i++) click('#sbGplus');
      await new Promise(r => setTimeout(r, 250));
      const spots = [...document.querySelectorAll('.plan .spot')];
      const status = {};
      spots.forEach(s => status[s.dataset.tableId] = s.classList.contains('busy') ? 'busy'
        : s.classList.contains('dimmed') ? 'dimmed' : s.classList.contains('sel') ? 'sel' : 'free');
      return { gval: document.getElementById('sbGval').textContent, status };
    });
    log('G7b-guests', guests.gval === '8', 'гостей: ' + guests.gval);
    const small = ['s1','s2','s3','s4'].every(k => guests.status[k] === 'dimmed');
    const bigOk = ['b1','b2','cab_cabinet','cab_copper'].every(k => guests.status[k] === 'free' || guests.status[k] === 'busy');
    log('G7b-dimmed', small && bigOk, '8 гостей: маленькие затемнены ' + small + ', большие активны ' + bigOk + ' | ' + JSON.stringify(guests.status));

    // выбор свободного стола → карточка и шаг 02 активен
    const pick = await page.evaluate(async () => {
      document.querySelector('.plan .spot[data-table-id="b1"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      return {
        onStep2: document.querySelector('.bk-step[data-bk="2"]').classList.contains('on'),
        bkV2: document.getElementById('bkV2').textContent,
        pickTtl: document.getElementById('bkPickTtl')?.textContent,
        pickDep: document.getElementById('bkPickDep')?.textContent
      };
    });
    log('P2-step2', pick.onStep2 && pick.pickTtl, 'выбор стола: ' + JSON.stringify(pick));

    // вернуть гостей к 2 и слот внутрь занятости s3 (20:00), иначе занятости не видно
    await page.evaluate(async () => {
      for (let i = 0; i < 6; i++) document.querySelector('#sbGminus').click();
      const chip = [...document.querySelectorAll('#sbTimes .bk-chip')].find(b => b.textContent === '20:00' && !b.disabled);
      if (chip) chip.click();
      await new Promise(r => setTimeout(r, 300));
    });

    // клик по занятому → тултип (если бэк отдаёт DEMO_BUSY)
    const tip = await page.evaluate(async () => {
      const s3 = document.querySelector('.plan .spot[data-table-id="s3"]');
      if (!s3 || !s3.classList.contains('busy')) return { busy: false };
      s3.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const t = document.getElementById('bkTip');
      return { busy: true, hidden: t.hidden, txt: t.querySelector('.bk-tip-txt')?.textContent, act: t.querySelector('.btn')?.textContent };
    });
    if (tip.busy) {
      log('G7a-tip', !tip.hidden && /занят до/i.test(tip.txt || ''), 'тултип: ' + JSON.stringify(tip));
      // кнопка тултипа: переключает слот и выбирает стол
      const jump = await page.evaluate(async () => {
        document.querySelector('#bkTip .btn').click();
        await new Promise(r => setTimeout(r, 400));
        const s3 = document.querySelector('.plan .spot[data-table-id="s3"]');
        return {
          sum: document.getElementById('sbSum').textContent,
          cntAt: document.getElementById('cntAt').textContent,
          s3sel: s3.classList.contains('sel'),
          bkV2: document.getElementById('bkV2').textContent
        };
      });
      log('G7c-jump', jump.s3sel && /21:45/.test(jump.sum + jump.cntAt), 'переход: ' + JSON.stringify(jump));
    } else {
      log('G7a-tip', null, 's3 не занят (нет DEMO_BUSY: локальный фолбэк) — гейт гоняется на wrangler dev');
    }

    // заявка: шаги 03–04 (десктоп)
    const apply = await page.evaluate(async () => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      document.getElementById('bkTo3').click(); await new Promise(r => setTimeout(r, 200));
      const inp = (id, v) => { const el = document.getElementById(id); el.focus(); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      inp('bkName', 'Игорь');
      inp('bkPhone', '79991234567');
      document.getElementById('bkTo4').click(); await new Promise(r => setTimeout(r, 250));
      const on4 = document.querySelector('.bk-step[data-bk="4"]').classList.contains('on');
      const agree = document.getElementById('bkAgree');
      agree.checked = true; agree.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('bkSubmit').click();
      await new Promise(r => setTimeout(r, 1200));
      const ok = document.getElementById('bkSuccess');
      return { on4, success: !ok.hidden, line: norm(ok.querySelector('#bkSuccessLine')?.textContent) };
    });
    log('P2-apply', apply.on4 && apply.success, JSON.stringify(apply));
    // повторный заход → плашка «У вас есть заявка»
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#sbTimes .bk-chip', { timeout: 10000 });
    const pend = await page.evaluate(() => ({
      hidden: document.getElementById('bkPending').hidden,
      text: document.getElementById('bkPending')?.textContent?.replace(/\s+/g, ' ').trim()
    }));
    log('P2-pending', !pend.hidden && /есть заявка/.test(pend.text), JSON.stringify(pend));
    await page.click('#bkPendingReset');

    await page.locator('#bron').scrollIntoViewIfNeeded();
    await page.waitForTimeout(900);
    await page.locator('#bron').screenshot({ path: `/home/rodriges/6and2qween/qa-pr2-${TAG}-desktop-bron.png`, fullPage: false });
    const external = reqs.filter(u => !u.startsWith(BASE) && !u.startsWith('data:') && !u.includes('fonts.') && !u.includes('gsap'));
    log('G2', external.length === 0, 'внешних запросов данных с фронта (кроме шрифтов/анимации, которые вне блока брони): ' + external.length + (external.length ? ' → ' + external.join(', ') : ''));
    const realErr = errors.filter(e => !e.includes('404') && !e.includes('501') && !e.includes('405'));
    log('ERR', realErr.length === 0, 'ошибки: ' + (realErr.join(' | ') || 'нет'));
    await ctx.close();
  }

  /* ---------- G4 · ночная логика (debug_now) ---------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/?nogate&debug_now=2026-08-22T01:00', { waitUntil: 'networkidle' });
    await page.waitForSelector('#sbTimes .bk-chip', { timeout: 10000 });
    const g4 = await page.evaluate(() => {
      const dates = [...document.querySelectorAll('#sbDates .bk-chip')].slice(0, 2).map(b => b.textContent);
      const times = [...document.querySelectorAll('#sbTimes .bk-chip')].map(b => b.textContent);
      return {
        dates,
        firstTime: times[0],
        lastTime: times[times.length - 1],
        sum: document.getElementById('sbSum').textContent,
        cntAt: document.getElementById('cntAt').textContent,
        onChip: document.querySelector('#sbTimes .bk-chip.on')?.textContent
      };
    });
    const ok = g4.lastTime === '03:30' && /02:30/.test(g4.sum);
    log('G4', ok, JSON.stringify(g4));
    await ctx.close();
  }

  /* ---------- MOBILE ---------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(BASE + '/?nogate', { waitUntil: 'networkidle' });
    await page.waitForSelector('#sbTimes .bk-chip', { timeout: 10000 });
    await page.locator('#bron').scrollIntoViewIfNeeded();
    await page.waitForTimeout(900);

    // нет горизонтального скролла страницы
    const horiz = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    log('G5-page', horiz <= 0, 'горизонтальный скролл страницы: ' + horiz + 'px (внутри слот-бара — штатно)');

    // wizard: слот-бар внутри мастера (шаг 1 = КОГДА)
    await page.click('#bkOpen');
    await page.waitForTimeout(700);
    const w1 = await page.evaluate(() => ({
      kicker: document.getElementById('bkwKicker').textContent,
      title: document.getElementById('bkwTitle').textContent,
      dates: document.querySelectorAll('#bkwDates .bkw-date').length,
      times: document.querySelectorAll('#bkwTimes .bkw-time').length,
      hint: document.getElementById('bkwFootHint').textContent
    }));
    log('P2-w1', w1.times > 0 && /КОГДА/.test(w1.kicker), JSON.stringify(w1));
    await page.click('#bkwGo');
    await page.waitForTimeout(500);
    const w2 = await page.evaluate(() => ({
      kicker: document.getElementById('bkwKicker').textContent,
      cards: document.querySelectorAll('#bkwList .bkw-card').length,
      slotline: document.getElementById('bkwSlotLineText')?.textContent
    }));
    log('P2-w2', w2.cards > 0, JSON.stringify(w2));
    // выбор стола → шаг 3 (Кто)
    await page.click('#bkwList .bkw-card:not(.dimmed):not(.busy)');
    await page.waitForTimeout(800);
    const w3 = await page.evaluate(() => ({
      kicker: document.getElementById('bkwKicker').textContent,
      gval: document.getElementById('bkwGval')?.textContent ?? null,
      selchip: document.getElementById('bkwSelTtl3')?.textContent
    }));
    log('P2-w3', /ГОСТИ/.test(w3.kicker) && w3.selchip, JSON.stringify(w3));
    const inp = async (id, v) => { await page.fill('#' + id, v); };
    await inp('bkwName', 'Игорь');
    await inp('bkwPhone', '79991234567');
    await page.click('#bkwGo');
    await page.waitForTimeout(600);
    const w4 = await page.evaluate(() => ({
      kicker: document.getElementById('bkwKicker').textContent,
      go: document.getElementById('bkwGo').textContent,
      s1: document.getElementById('bkwS1')?.textContent,
      s2: document.getElementById('bkwS2')?.textContent
    }));
    log('P2-w4', /ФИНАЛ/.test(w4.kicker) && /Отправить заявку/.test(w4.go), JSON.stringify(w4));
    await page.check('#bkwAgree');
    await page.click('#bkwGo');
    await page.waitForTimeout(1500);
    const okMob = await page.evaluate(() => !document.getElementById('bkSuccess').hidden);
    log('P2-w5', okMob, 'success на мобильном: ' + okMob);

    await page.locator('#bron').screenshot({ path: `/home/rodriges/6and2qween/qa-pr2-${TAG}-mobile-bron.png` });
    await ctx.close();
  }

  await browser.close();
  const fails = out.filter(o => o.ok === false);
  console.log('\nитог: ' + out.filter(o => o.ok).length + ' pass / ' + fails.length + ' fail');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
