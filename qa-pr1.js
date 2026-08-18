/* QA PR1: слепок блока брони до/после.
   Использование: node qa-pr1.js <base-url> <tag> [mobile]
   Дампит тексты блока, счётчики, депозиты после кликов, сетевые запросы и скриншоты. */
const { chromium } = require('/home/rodriges/6and2/landing-skill-sozdanie-sayta/node_modules/playwright');
const EXE = '/home/rodriges/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell';
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8152';
const TAG = process.argv[3] || 'before';
const MODE = process.argv[4] || 'all';

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  async function capture(name, viewport, dsf) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: dsf });
    const page = await context.newPage();
    const errors = [], requests = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('request', r => requests.push(r.url()));
    await page.goto(BASE + '/?nogate', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.locator('#bron').scrollIntoViewIfNeeded();
    await page.waitForTimeout(900);

    const stat = await page.evaluate(() => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      const txt = sel => { const el = document.querySelector(sel); return el ? norm(el.innerText) : null; };
      return {
        bronText: txt('#bron'),
        mgridText: txt('#bkMgrid'),
        legend: txt('.b-legend'),
        counters: {
          t: document.getElementById('cntTables')?.textContent,
          c: document.getElementById('cntCabs')?.textContent,
          b: document.getElementById('cntBar')?.textContent
        },
        tableIds: [...document.querySelectorAll('.plan .spot')].map(el => el.dataset.tableId || null),
        configScript: !!document.querySelector('script[type="module"][src*="booking"]'),
        b62config: window.B62 && window.B62.config ? {
          tables: window.B62.config.tables.length,
          cancelFreeHours: window.B62.config.cancelFreeHours,
          primeTime: window.B62.config.primeTime,
          stringsKeys: Object.keys(window.B62.config.strings || {}).length
        } : null
      };
    });

    // взаимодействия в фиксированном порядке: выбор стола, кабинета, даты
    const interact = await page.evaluate(async () => {
      const out = {};
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      const click = sel => { const el = document.querySelector(sel); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); };
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      click('.plan .spot[data-id="t-1"]'); await sleep(350);
      out.pickT1 = norm(document.getElementById('bkPick')?.innerText);
      out.bkV1 = document.getElementById('bkV1')?.textContent;
      click('.plan .spot[data-id="vip-1"]'); await sleep(350);
      out.pickVip1 = norm(document.getElementById('bkPick')?.innerText);
      const dep = window.BOOKING_CFG ? { d: window.BOOKING_CFG.deposits, by: window.BOOKING_CFG.depositBySpot } : null;
      out.bookingCfg = dep;
      const chip = document.querySelector('#bkDates .bk-chip'); if (chip) chip.click(); await sleep(250);
      out.timesText = norm(document.getElementById('bkTimes')?.innerText);
      return out;
    });

    await page.locator('#bron').screenshot({ path: `qa-pr1-${TAG}-${name}-bron.png` });
    // фломастер: что из сети — внешнее
    const external = requests.filter(u => !u.startsWith(BASE) && !u.startsWith('data:'));
    const apiCalls = requests.filter(u => u.includes('/api/'));
    const dump = { name, viewport, stat, interact, network: { total: requests.length, apiCalls, external }, errors };
    fs.writeFileSync(`qa-pr1-${TAG}-${name}.json`, JSON.stringify(dump, null, 2));
    console.log(`[${name}] api: ${JSON.stringify(apiCalls)} external: ${external.length} errors: ${errors.length}`);
    if (errors.length) console.log('ERRORS:', errors.slice(0, 5));
    await context.close();
  }

  if (MODE === 'all' || MODE === 'desktop') await capture('desktop', { width: 1440, height: 900 }, 1);
  if (MODE === 'all' || MODE === 'mobile') await capture('mobile', { width: 360, height: 800 }, 2);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
