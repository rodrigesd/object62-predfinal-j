// PR2 · slot-first (ТЗ §3, §5, §7, приложение А): блок брони «Место и время».
// Слот-бар над схемой, бизнес-дата с ролловером 08:00, дефолтный слот по §3.4,
// счётчик от слота, статусы free/busy/selected/dimmed, кликабельный занятый
// стол (тултип/bottom-sheet), шаги 01 Когда → 02 Стол → 03 Кто → 04 Подтверждение.
// PR3 (ТЗ §8): hit-подложки мест на схеме, клавиатурный доступ к шагам,
// слот-бар рисуется до загрузки занятости (ноль лишних сдвигов).
// Единственная точка данных: api.js (ТЗ §6.1), внешних вызовов с фронта нет.
import { getConfig, getAvailability, createBooking } from './api.js';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const fmt = (tpl, vars) => String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const pad = n => (n < 10 ? '0' : '') + n;

// Установить текст элементу с учётом вложенных узлов (иконки/свотчи)
function setText(el, text, mode) {
  if (mode === 'first' || mode === 'last') {
    const nodes = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE && n.nodeValue.trim());
    const node = mode === 'first' ? nodes[0] : nodes[nodes.length - 1];
    if (node) { node.nodeValue = text; return; }
  }
  el.textContent = text;
}

function init() {
  const section = document.getElementById('bron');
  if (!section) return;
  start(section).catch(e => console.warn('[b62] блок брони не поднялся:', e));
}

async function start(section) {
  let config;
  try {
    config = await getConfig();
  } catch (e) {
    console.warn('[b62] конфиг не загружен, блок работает на статике:', e.message);
    return;
  }
  window.B62 = { config };

  const S = config.strings || {};
  const RM = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)').matches : false;
  const TABLES = config.tables || [];
  const byId = {}; TABLES.forEach(t => byId[t.id] = t);
  const inv = countByZone(TABLES);
  const RO = config.businessDayRolloverHour || 8;
  // «HH:MM» → минуты от полуночи бизнес-даты; часы до ролловера считаем «завтра»
  const toBizMin = hhmm => {
    const [h, m] = String(hhmm).split(':').map(Number);
    const v = h * 60 + m;
    return h < RO ? v + 1440 : v;
  };
  const C = {
    step: config.slotStepMin || 30,
    lead: config.minLeadMin || 90,
    prime: toBizMin(config.primeTime || '20:00'),
    lastOffset: config.lastSlotOffsetMin || 30,
    duration: config.defaultDurationMin || 120,
    buffer: config.bufferMin || 15,
    rollover: RO,
    cancelHours: config.cancelFreeHours || 24
  };

  // «сейчас»: может быть подменено параметром ?debug_now=ISO (ТЗ §6.3, гейт G4).
  // В проде флаг отключается в конфиге (config.debug); до этого стенд считаем девом.
  let NOW = new Date();
  const dbg = new URLSearchParams(location.search).get('debug_now');
  if (dbg && config.debug) {
    const d = new Date(dbg);
    if (!isNaN(d)) NOW = d;
  }

  /* ---------- время в координатах бизнес-даты (ТЗ §3.5) ---------- */
  // до 08:00 утра относимся к предыдущему дню
  function businessDate(date) {
    const bd = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (date.getHours() < C.rollover) bd.setDate(bd.getDate() - 1);
    return bd;
  }
  const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  // минуты бизнес-даты → подпись «HH:MM» (ночные часы возвращаются в 00–08)
  const minLabel = m => pad(Math.floor((m % 1440) / 60)) + ':' + pad(m % 60);
  // день недели бизнес-даты определяет часы закрытия (ТЗ §3.5)
  function closeMin(bd) {
    const dow = bd.getDay(); // 5..0 → пт-вс
    const pair = dow >= 5 || dow === 0 ? config.hours['fri-sun'] : config.hours['mon-thu'];
    return toBizMin(pair[1]);
  }
  function slotsOf(bd) {
    const open = 16 * 60, last = closeMin(bd) - C.lastOffset, out = [];
    for (let m = open; m <= last; m += C.step) out.push(m);
    return out;
  }
  const roundUp = (v, s) => Math.ceil(v / s) * s;
  const dayKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const monthKey = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  /* ---------- состояние выбора ---------- */
  const BD0 = businessDate(NOW); // бизнес-дата «Сегодня»
  const B = {
    bd: null,          // Date-полночь бизнес-даты
    slot: null,        // минуты бизнес-даты
    guests: 2,
    tableId: null,
    name: '', phone: '', comment: '',
    agree: false,
    idemKey: null,
    pendingSubmit: false
  };

  // дефолтный слот по ТЗ §3.4 (в координатах бизнес-даты)
  function defaultSlot(bd) {
    const nowMin = Math.round((NOW - bd.getTime()) / 60000);
    const slots = slotsOf(bd);
    const last = slots[slots.length - 1];
    const cand = roundUp(nowMin + C.lead, C.step);
    if (cand < 16 * 60 || cand > last) return { bd: addDays(bd, 1), slot: C.prime };
    return { bd, slot: Math.max(cand, C.prime) };
  }
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

  /* ---------- availability (ТЗ §7): только через api.js ---------- */
  let AVAIL = { source: 'fallback', tables: {} };
  async function loadAvailability(bd) {
    AVAIL = await getAvailability(iso(bd));
    const fb = $('#sbFallback');
    if (fb) fb.classList.toggle('show', AVAIL.source === 'fallback');
  }
  // занят ли стол на слоте T: интервалы занятости берутся с буфером (ТЗ §5)
  function busyIntervalAt(tableId, T) {
    const busy = (AVAIL.tables[tableId] || {}).busy || [];
    let hit = null;
    for (const b of busy) {
      const from = toBizMin(b.from), to = toBizMin(b.to) + C.buffer;
      if (T < to && T + C.duration > from) {
        if (!hit || toBizMin(b.to) > toBizMin(hit.to)) hit = b;
      }
    }
    return hit;
  }
  // предложенное время брони: конец занятости + буфер уборки, вверх к сетке слотов
  // (ТЗ §3.6: округление к шагу 30); если сразу за ним следующая занятость, идём дальше
  function nextOffer(tableId, iv) {
    let t = roundUp(toBizMin(iv.to) + C.buffer, C.step);
    for (let i = 0; i < 48; i++) {
      const nx = busyIntervalAt(tableId, t);
      if (!nx) break;
      t = roundUp(toBizMin(nx.to) + C.buffer, C.step);
    }
    return t;
  }
  function statusOf(t) {
    if (busyIntervalAt(t.id, B.slot)) return 'busy';
    if (t.capacityMax < B.guests) return 'dimmed';
    return 'free';
  }
  const freeAt = (list, T) => list.filter(t => !busyIntervalAt(t.id, T)).length;

  /* ---------- строки и тексты ---------- */
  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  };
  const sget = k => S[k] != null ? S[k] : k;
  const guestsWord = n => plural(n, sget('guests.word1'), sget('guests.word2'), sget('guests.word5'));
  const cancelText = tpl => fmt(tpl, { n: C.cancelHours, unit: plural(C.cancelHours, sget('cancel.unit.one'), sget('cancel.unit.few'), sget('cancel.unit.many')) });
  const money = v => v.toLocaleString('ru-RU').replace(/\u00a0/g, ' ') + ' ₽';
  function dateHuman(bd) {
    if (bd.getTime() === BD0.getTime()) return sget('day.today');
    if (bd.getTime() === addDays(BD0, 1).getTime()) return sget('day.tomorrow');
    return sget('day.' + dayKey[bd.getDay()]) + ' ' + bd.getDate() + ' ' + sget('month.' + monthKey[bd.getMonth()]);
  }
  // «пт 21.08»: формат success-экрана и сводок
  const dateShort = bd => sget('day.' + dayKey[bd.getDay()]) + ' ' + pad(bd.getDate()) + '.' + pad(bd.getMonth() + 1);

  function countByZone(tables) {
    const z = { hall: 0, vip: 0, bar: 0, big: 0 };
    tables.forEach(t => {
      if (t.zone === 'hall') { z.hall++; if (t.capacityMax >= 10) z.big++; }
      else if (t.zone === 'vip') z.vip++;
      else if (t.zone === 'bar') z.bar++;
    });
    return { tables: z.hall - z.big, big: z.big, vip: z.vip, bar: z.bar, tablesAll: z.hall + z.vip };
  }
  function tableKind(t) {
    if (t.zone === 'vip') return 'cab';
    if (t.zone === 'bar') return 'seat';
    return t.capacityMax >= 10 ? 'big' : 'table';
  }
  function depositLine(t) {
    return t.depositText ? t.depositText : fmt(sget('deposit.line'), { sum: money(t.depositRub || 0) });
  }

  /* ---------- гидратация статических текстов из config.strings (ТЗ §0.4) ---------- */
  // берём весь документ: строки брони в #bron, строка FAQ снаружи секции
  document.querySelectorAll('[data-str]').forEach(el => {
    const tpl = S[el.dataset.str];
    if (tpl == null) { console.warn('[b62] в config.strings нет ключа:', el.dataset.str); return; }
    let out = tpl;
    if (el.dataset.vars === 'inv') out = fmt(out, inv);
    if (el.dataset.vars === 'cancel') out = cancelText(out);
    setText(el, out, el.dataset.strMode);
  });
  document.querySelectorAll('[data-str-ph]').forEach(el => {
    const tpl = S[el.dataset.strPh];
    if (tpl != null) el.setAttribute('placeholder', tpl);
  });
  // aria-атрибуты тоже из конфига (ТЗ §0.4)
  document.querySelectorAll('[data-str-aria]').forEach(el => {
    const tpl = S[el.dataset.strAria];
    if (tpl != null) el.setAttribute('aria-label', tpl);
  });
  // title-атрибуты (подсказка степпера гостей): из того же конфига
  document.querySelectorAll('[data-str-title]').forEach(el => {
    const tpl = S[el.dataset.strTitle];
    if (tpl != null) el.setAttribute('title', tpl);
  });

  /* ---------- слот-бар (ТЗ §3.2) ---------- */
  const sb = $('#slotbar');
  function renderDates(box, chipCls) {
    box.innerHTML = '';
    for (let i = 0; i < 14; i++) {
      const bd = addDays(BD0, i);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = chipCls + (bd.getTime() === B.bd.getTime() ? ' on' : '');
      b.dataset.days = String(i);
      b.setAttribute('aria-pressed', bd.getTime() === B.bd.getTime() ? 'true' : 'false');
      if (i === 0) b.textContent = sget('day.today');
      else if (i === 1) b.textContent = sget('day.tomorrow');
      else b.textContent = sget('day.' + dayKey[bd.getDay()]) + ' ' + bd.getDate() + ' ' + sget('month.' + monthKey[bd.getMonth()]);
      b.addEventListener('click', () => setDate(addDays(BD0, i)));
      box.appendChild(b);
    }
  }
  function renderTimes(box, chipCls) {
    box.innerHTML = '';
    const isToday = B.bd.getTime() === BD0.getTime();
    const nowMin = Math.round((NOW - BD0.getTime()) / 60000);
    let firstFreeMarked = false; // ближайший доступный слот (вариант B)
    for (const m of slotsOf(B.bd)) {
      const b = document.createElement('button');
      b.type = 'button';
      const night = m >= 1440; // бизнес-минуты следующих суток: отделяем визуально
      const past = isToday && m < nowMin + C.lead;
      b.className = chipCls + (m === B.slot ? ' on' : '') + (night ? ' night' : '');
      if (!past && !firstFreeMarked && m !== B.slot) { b.classList.add('near'); firstFreeMarked = true; }
      if (!past && !firstFreeMarked && m === B.slot) firstFreeMarked = true;
      b.textContent = minLabel(m);
      b.dataset.m = String(m);
      b.setAttribute('aria-pressed', m === B.slot ? 'true' : 'false');
      // минимальное плечо до визита действует только для сегодняшней бизнес-даты
      b.disabled = past;
      b.addEventListener('click', () => setSlot(Number(b.dataset.m)));
      box.appendChild(b);
    }
  }
  // текст выбранного слота: один факт во всех местах сразу ([data-sum] в пульте и в шаге «Стол»)
  function renderSummaryEls() {
    const text = fmt(sget('slotbar.summary'), { date: dateHuman(B.bd), slot: minLabel(B.slot), guests: B.guests, guestsWord: guestsWord(B.guests) });
    document.querySelectorAll('[data-sum]').forEach(el => { el.textContent = text; });
  }
  function renderSlotbar() {
    if (!sb) return;
    renderDates($('#sbDates'), 'bk-chip');
    renderTimes($('#sbTimes'), 'bk-chip');
    renderGuestUI();
    renderSummaryEls();
    refreshLanes();
  }
  function renderGuestUI() {
    [['#sbGval', '#sbGminus', '#sbGplus'], ['#bkwGval', '#bkwGminus', '#bkwGplus']].forEach(([v, mi, pl]) => {
      const val = $(v); if (val) val.textContent = String(B.guests);
      const minus = $(mi); if (minus) minus.disabled = B.guests <= 1;
      const plus = $(pl); if (plus) plus.disabled = B.guests >= 12;
    });
  }
  function setGuests(n) {
    B.guests = Math.max(1, Math.min(12, n));
    renderGuestUI();
    renderSummaryEls();       // саммери слота обновляется сразу, без лишнего клика
    applyStatuses();          // dimmed зависит от числа гостей
    renderWizardList(wizFilter);
    updateCounters();
    syncStepVals();
  }
  async function setDate(bd, keepSlot) {
    B.bd = bd;
    if (!keepSlot) {
      // перенос слота на другую бизнес-дату держим в пределах её сетки
      const slots = slotsOf(bd);
      if (!slots.includes(B.slot)) {
        const d = defaultSlot(bd);
        B.slot = d.slot;
      }
    }
    await loadAvailability(bd);
    renderSlotbar();
    applyStatuses();
    renderWizardList(wizFilter);
    updateCounters();
    syncStepVals();
  }
  // лёгкое обновление слот-бара: без пересоздания чипов (плавность ≤ 200 мс, ТЗ §11 G1)
  function refreshSlotbar() {
    if (!sb) return;
    sb.querySelectorAll('#sbTimes .bk-chip').forEach(b => {
      const on = Number(b.dataset.m) === B.slot;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    renderSummaryEls();
    refreshLanes();
  }
  function setSlot(m) {
    B.slot = m;
    refreshSlotbar();
    applyStatuses();
    refreshWizardList();
    updateCounters();
    syncStepVals();
  }

  /* ---------- пульт: свёртка на мобиле и «Изменить время» из шага «Стол» ---------- */
  const csToggle = $('#csToggle');
  if (csToggle && sb) csToggle.addEventListener('click', () => {
    const open = sb.classList.toggle('open');
    csToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  // проскроллить к пульту и сфокусировать активный чип
  $$('[data-focus-slot]').forEach(btn => btn.addEventListener('click', () => {
    if (!sb) return;
    sb.scrollIntoView({ behavior: RM ? 'auto' : 'smooth', block: 'center' });
    const on = sb.querySelector('.bk-chip.on') || sb.querySelector('.bk-chip:not(:disabled)');
    if (on) on.focus();
  }));

  /* ---------- клавиатура в лентах чипов: roving tabindex + стрелки ---------- */
  function laneKeys(lane) {
    if (lane.dataset.keys) return;
    lane.dataset.keys = '1';
    lane.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const chips = [...lane.querySelectorAll('.bk-chip:not(:disabled)')];
      if (!chips.length) return;
      const idx = chips.indexOf(document.activeElement);
      let ni = 0;
      if (e.key === 'ArrowLeft') ni = idx > 0 ? idx - 1 : chips.length - 1;
      else if (e.key === 'ArrowRight') ni = idx < chips.length - 1 ? idx + 1 : 0;
      else if (e.key === 'Home') ni = 0;
      else ni = chips.length - 1;
      chips.forEach(c => c.setAttribute('tabindex', c === chips[ni] ? '0' : '-1'));
      chips[ni].focus();
      e.preventDefault();
    });
  }
  function initLane(lane) {
    laneKeys(lane);
    const chips = [...lane.querySelectorAll('.bk-chip')];
    if (!chips.length) return;
    const on = lane.querySelector('.bk-chip.on') || lane.querySelector('.bk-chip:not(:disabled)');
    chips.forEach(c => c.setAttribute('tabindex', c === on ? '0' : '-1'));
  }
  function refreshLanes() { $$('.bk-chips').forEach(initLane); }
  // колесо мыши над лентой чипов крутит её горизонтально (десктоп);
  // на краю ленты событие уходит странице, вертикальный скролл не ломается
  function initWheel() {
    $$('.bk-chips').forEach(lane => {
      if (lane.dataset.wheel) return;
      lane.dataset.wheel = '1';
      lane.addEventListener('wheel', e => {
        if (!e.deltaY) return;
        const canL = lane.scrollLeft > 0;
        const canR = lane.scrollLeft + lane.clientWidth < lane.scrollWidth - 1;
        if ((e.deltaY < 0 && canL) || (e.deltaY > 0 && canR)) {
          lane.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      }, { passive: false });
    });
  }
  // статусы карточек мастера без пересоздания DOM
  function refreshWizardList() {
    $$('#bkwList .bkw-card').forEach(card => {
      const t = byId[card.dataset.tableId];
      if (!t) return;
      const st = statusOf(t);
      card.classList.toggle('busy', st === 'busy');
      card.classList.toggle('dimmed', st === 'dimmed');
      card.classList.toggle('sel', B.tableId === t.id && st !== 'busy');
      const mark = card.querySelector('.bkw-card-mark');
      if (mark) {
        mark.className = 'bkw-card-mark ' + (st === 'busy' ? 'busy' : 'free');
        mark.textContent = st === 'busy' ? sget('busy.word') : sget('free.word');
      }
    });
    updateWizardGo();
  }

  /* ---------- счётчики: от выбранного слота (ТЗ §3.3) ---------- */
  function updateCounters() {
    const at = $('#cntAt');
    if (at) at.textContent = fmt(sget('count.atSlot'), { slot: minLabel(B.slot) });
    const tables = TABLES.filter(t => t.zone !== 'bar');
    const cabs = TABLES.filter(t => t.zone === 'vip');
    const bar = TABLES.filter(t => t.zone === 'bar');
    const set = (id, free, total) => {
      const el = document.getElementById(id);
      if (el) el.textContent = fmt(sget('count.of'), { free, total });
    };
    set('cntTables', freeAt(tables, B.slot), tables.length);
    set('cntCabs', freeAt(cabs, B.slot), cabs.length);
    set('cntBar', freeAt(bar, B.slot), bar.length);
  }

  // дисплей пульта (вариант B): сколько мест свободно и вмещают текущую компанию
  function fitCount() {
    let n = 0;
    for (const t of TABLES) {
      if (busyIntervalAt(t.id, B.slot)) continue; // занят на текущий слот
      if ((t.capacityMax || 1) < B.guests) continue; // не вмещает компанию
      n++;
    }
    return n;
  }

  /* ---------- статусы столов: схема, витрина, список мастера (ТЗ §5) ---------- */
  let selMark = null; // галка выбранного места (доступность без цвета)
  function makeSelMark() {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.innerHTML = '<circle class="sel-mark-bg" r="11"/><text class="sel-mark" y="4.5" text-anchor="middle">✓</text>';
    g.style.display = 'none';
    g.style.pointerEvents = 'none'; // галка не должна перехватывать тапы (ТЗ §8)
    return g;
  }
  // PR3 · ТЗ §8: тап-таргеты мест ≥ 44px. Мелкие места (места у бара, столики)
  // получают прозрачную hit-подложку в SVG-единицах: визуал не меняется.
  // Точный минимум считается от реального масштаба рендера (юниты = 44 CSS px),
  // но не больше, чем позволяет соседство мест (места у бара идут через 74u,
  // обычные столики в колонках по вертикали через 96u), без наложений.
  function addHitAreas() {
    const svg = document.querySelector('svg.plan');
    if (!svg) return;
    const wpx = svg.getBoundingClientRect().width;
    if (!wpx) return;
    const perPx = 1000 / wpx;                       // SVG-юнитов в 1 CSS px
    const minUnit = 44 * perPx;                     // 44px в юнитах
    const minGap = Math.max(2, 4 * perPx);          // зазор между соседями ~4px
    $$('.plan .spot').forEach(g => {
      const shape = g.querySelector('.shape');
      if (!shape) return;
      g.querySelector('.hit')?.remove();
      const bb = shape.getBBox();
      const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
      let hit;
      if (g.classList.contains('seat')) {
        hit = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        hit.setAttribute('cx', String(cx));
        hit.setAttribute('cy', String(cy));
        hit.setAttribute('r', String(Math.min(Math.max(bb.width / 2 + 7, minUnit / 2), (74 - minGap) / 2)));
      } else {
        const isCab = g.classList.contains('cab'), isBig = g.classList.contains('big');
        // соседние столики в колонке идут с шагом 96u: ограничиваем высоту подложки
        const maxH = isCab || isBig ? Infinity : 96 - minGap;
        const w = Math.max(bb.width, Math.min(minUnit, 96 - minGap));
        const h = Math.max(bb.height, Math.min(minUnit, maxH));
        hit = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        hit.setAttribute('x', String(cx - w / 2));
        hit.setAttribute('y', String(cy - h / 2));
        hit.setAttribute('width', String(w));
        hit.setAttribute('height', String(h));
        hit.setAttribute('rx', '4');
      }
      hit.setAttribute('class', 'hit');
      hit.setAttribute('aria-hidden', 'true');
      g.insertBefore(hit, g.firstChild);
    });
  }
  function applyStatuses() {
    const sel = B.tableId ? TABLES.find(t => t.id === B.tableId) : null;
    $$('.plan .spot').forEach(el => {
      const t = byId[el.dataset.tableId];
      if (!t) return;
      const st = statusOf(t);
      el.classList.toggle('busy', st === 'busy');
      el.classList.toggle('dimmed', st === 'dimmed');
      el.classList.toggle('sel', !!sel && t.id === sel.id && st !== 'busy');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label',
        (el.dataset.title || t.label) + ', ' + (el.dataset.cap || '') + ', ' +
        (st === 'busy' ? sget('busy.word') : st === 'dimmed' ? fmt(sget('dimmed.tip'), { n: t.capacityMax }) : sget('free.word')));
    });
    // галка выбранного места рисуется один раз после обхода (иначе перетирается)
    if (!selMark) { selMark = makeSelMark(); $('svg.plan').appendChild(selMark); }
    const selEl = sel ? $('.plan .spot.sel') : null;
    if (selEl) {
      const bb = selEl.querySelector('.shape').getBBox();
      selMark.setAttribute('transform', 'translate(' + (bb.x + bb.width - 4) + ',' + (bb.y + 8) + ')');
      selMark.style.display = '';
    } else {
      selMark.style.display = 'none';
    }
    $$('#bkMgrid .bk-mcard').forEach(card => {
      const t = byId[card.dataset.tableId];
      if (!t) return;
      const st = statusOf(t);
      card.classList.toggle('busy', st === 'busy');
      card.classList.toggle('dimmed', st === 'dimmed');
      card.classList.toggle('sel', !!sel && t.id === sel.id && st !== 'busy');
      const mark = card.querySelector('.bk-mstatus');
      if (mark) {
        mark.className = 'bk-mstatus ' + (st === 'busy' ? 'busy' : 'free');
        mark.textContent = st === 'busy' ? sget('busy.word') : sget('free.word');
      }
    });
    // дисплей пульта: крупное число подходящих свободных мест
    $$('[data-fit-num]').forEach(el => { el.textContent = String(fitCount()); });
    // выбранное место перестало подходить (занято после смены слота/даты или мало мест
    // после смены гостей): выбор сбрасывается, дальше по шагам с ним идти нельзя
    if (B.tableId) {
      const selT = byId[B.tableId];
      if (selT && statusOf(selT) !== 'free') {
        B.tableId = null;
        clearPick();
        syncGridSel(null);
        renderWizardList(wizFilter);
        syncStepVals();
        // если гость уже ушёл дальше по шагам, возвращаем к выбору места
        const cur = wiz && wiz.querySelector('.bk-step.on');
        if (cur && Number(cur.dataset.bk) > 1) { maxReached = 1; goto(1); }
      }
    }
  }

  /* ---------- тултип занятого/неподходящего стола (ТЗ §3.6) ---------- */
  const tip = $('#bkTip');
  const veil = $('.bk-tip-veil');
  let tipTarget = null;
  function openTip(el, t) {
    if (!tip) return;
    tipTarget = el;
    const st = statusOf(t);
    const txt = tip.querySelector('.bk-tip-txt');
    const act = tip.querySelector('.btn');
    if (st === 'busy') {
      const iv = busyIntervalAt(t.id, B.slot);
      const offer = nextOffer(t.id, iv);
      txt.textContent = fmt(sget('busy.tip'), { until: minLabel(toBizMin(iv.to)), from: minLabel(offer) });
      act.hidden = false;
      act.textContent = fmt(sget('busy.action'), { time: minLabel(offer) });
      act.dataset.m = String(offer);
      act.dataset.table = t.id;
    } else if (st === 'dimmed') {
      txt.textContent = fmt(sget('dimmed.tip'), { n: t.capacityMax });
      act.hidden = true;
    } else {
      closeTip();
      return;
    }
    const mobile = matchMedia('(max-width: 900px)').matches;
    tip.hidden = false;
    if (!mobile) {
      // тултип fixed: координаты страницы от позиции места на схеме
      const rb = el.getBoundingClientRect();
      const left = Math.max(10, Math.min(rb.left + scrollX - 110, innerWidth - 280));
      let top = rb.top + scrollY - tip.offsetHeight - 10;
      if (top < scrollY + 8) top = rb.bottom + scrollY + 10;
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    } else {
      tip.removeAttribute('style');
      if (veil) veil.classList.add('show');
    }
  }
  function closeTip() {
    if (tip) tip.hidden = true;
    if (veil) veil.classList.remove('show');
    tipTarget = null;
  }
  if (tip) {
    tip.querySelector('.bk-tip-x')?.addEventListener('click', closeTip);
    tip.querySelector('.btn')?.addEventListener('click', () => {
      const m = Number(tip.querySelector('.btn').dataset.m);
      const tableId = tip.querySelector('.btn').dataset.table;
      closeTip();
      // переключаем слот-бар на предложенное время и выбираем стол (ТЗ §3.6)
      selectTable(tableId, () => setSlot(m));
    });
    veil?.addEventListener('click', closeTip);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTip(); });
  }

  /* ---------- выбор стола ---------- */
  function selectTable(tableId, after) {
    const t = byId[tableId];
    if (!t) return;
    B.tableId = tableId;
    if (typeof after === 'function') after();
    applyStatuses();
    renderWizardList(wizFilter);
    fillPick(t);
    syncGridSel(tableId);
    syncStepVals();
  }
  function syncGridSel(id) {
    $$('#bkMgrid .bk-mcard').forEach(c => c.classList.toggle('sel', !!id && c.dataset.tableId === id));
    $$('#bkwList .bkw-card').forEach(c => c.classList.toggle('sel', !!id && c.dataset.tableId === id));
  }

  const plan = $('svg.plan');
  if (plan) {
    plan.addEventListener('click', e => {
      const g = e.target.closest('.spot');
      if (!g) return;
      const t = byId[g.dataset.tableId];
      if (!t) return;
      const st = statusOf(t);
      if (st === 'busy' || st === 'dimmed') { openTip(g, t); return; }
      if (B.tableId === t.id) { // повторный клик: снять выбор
        B.tableId = null;
        applyStatuses(); renderWizardList(wizFilter); syncGridSel(null); syncStepVals();
        return;
      }
      selectTable(t.id, () => { if (wiz) goto(1); });
    });
    plan.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const g = e.target.closest('.spot');
      if (!g) return;
      e.preventDefault();
      g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  /* ---------- карточка выбранного места (шаг 02 · Стол) ---------- */
  function fillPick(t) {
    const pickBox = $('#bkPick');
    if (!pickBox) return;
    const el = $('.plan .spot[data-table-id="' + t.id + '"]');
    const ph = el ? (el.dataset.photo || '') : '';
    const img = $('#bkPickPh');
    if (img) {
      if (ph) { img.src = ph; img.alt = el.dataset.title || t.label; img.hidden = false; }
      else { img.removeAttribute('src'); img.hidden = true; }
    }
    setText($('#bkPickTtl'), el ? (el.dataset.title || t.label) : t.label);
    setText($('#bkPickCap'), el ? (el.dataset.cap || '') : '');
    setText($('#bkPickNote'), el ? (el.dataset.note || '') : '');
    setText($('#bkPickDep'), depositLine(t));
    pickBox.hidden = false;
    pickBox.classList.remove('is-empty');
  }
  function clearPick() {
    const pickBox = $('#bkPick');
    if (!pickBox) return;
    pickBox.classList.add('is-empty');
    const img = $('#bkPickPh');
    if (img) { img.removeAttribute('src'); img.hidden = true; }
  }
  $('#bkPickX')?.addEventListener('click', () => {
    B.tableId = null;
    applyStatuses(); renderWizardList(wizFilter); syncGridSel(null); syncStepVals();
    maxReached = 1; goto(1);
    if (!matchMedia('(max-width: 900px)').matches)
      $('.plan-card')?.scrollIntoView({ behavior: RM ? 'auto' : 'smooth', block: 'center' });
  });
  // зум фото выбранного места (общий лайтбокс страницы)
  $('#bkPickPh')?.addEventListener('click', function () {
    if (!B.tableId || this.hidden) return;
    const t = byId[B.tableId];
    const el = $('.plan .spot[data-table-id="' + B.tableId + '"]');
    window.shots = [{ dataset: { full: this.currentSrc || this.src, cap: el ? (el.dataset.title || t.label) : t.label } }];
    window.showShot(0);
    document.getElementById('lightbox')?.classList.add('open');
  });

  /* ---------- витрина мест на мобильном (карточки из схемы) ---------- */
  (function buildMobileGrid() {
    const grid = $('#bkMgrid');
    if (!grid) return;
    $$('.plan .spot').forEach(el => {
      const t = byId[el.dataset.tableId];
      if (!t) return;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'bk-mcard';
      card.dataset.tableId = t.id;
      card.dataset.id = el.dataset.id;
      card.setAttribute('aria-label', el.getAttribute('aria-label') || '');
      card.innerHTML =
        '<span class="bk-mstatus free">' + sget('free.word') + '</span>' +
        '<img src="' + (el.dataset.photo || '') + '" alt="" loading="lazy" decoding="async">' +
        '<span class="bk-mbody">' +
          '<span class="bk-mttl">' + (el.dataset.title || t.label) + '</span>' +
          '<span class="bk-mcap">' + (el.dataset.cap || '') + '</span>' +
          '<span class="bk-mdep">' + depositLine(t) + '</span>' +
        '</span>';
      card.addEventListener('click', () => {
        const st = statusOf(t);
        if (st === 'busy' || st === 'dimmed') { openTip(card, t); return; }
        if (matchMedia('(max-width: 900px)').matches) openWizard(t.id);
        else selectTable(t.id, () => { maxReached = Math.max(maxReached, 2); goto(2); });
      });
      grid.appendChild(card);
    });
  })();

  /* ---------- десктопный аккордеон: шаги ---------- */
  const wiz = $('#bkWizard');
  let maxReached = 1; // вариант B: сразу доступен только шаг 01 «Стол» (слот всегда выбран в пульте)
  let steps = wiz ? [...wiz.querySelectorAll('.bk-step')] : [];
  function goto(n) {
    if (!wiz || n > maxReached) return;
    steps.forEach(s => {
      const k = Number(s.dataset.bk);
      s.classList.toggle('on', k === n);
      s.classList.toggle('done', k !== n && k <= maxReached);
      // PR3 (ТЗ §8): пройденные шаги доступны с клавиатуры
      const h = s.querySelector('.bk-head');
      if (h) h.tabIndex = (k !== n && k <= maxReached) ? 0 : -1;
    });
    const cur = wiz.querySelector('.bk-step.on');
    if (cur) cur.scrollIntoView({ behavior: RM ? 'auto' : 'smooth', block: 'nearest' });
  }
  wiz?.addEventListener('click', e => {
    const t = e.target.closest('[data-goto]');
    if (t) goto(Number(t.dataset.goto));
  });
  // Enter/Space на заголовке пройденного шага: возврат к нему (ТЗ §8)
  wiz?.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const h = e.target.closest('[data-goto]');
    if (!h) return;
    e.preventDefault();
    goto(Number(h.dataset.goto));
  });
  function syncStepVals() {
    // вариант B: bkV1: выбранное место (шаг 01 «Стол»), bkV2: гость (шаг 02 «Кто»)
    const v1 = $('#bkV1');
    if (v1) {
      const t = B.tableId ? byId[B.tableId] : null;
      const el = t ? $('.plan .spot[data-table-id="' + t.id + '"]') : null;
      v1.textContent = t ? (el ? (el.dataset.title || t.label) : t.label) : sget('step2.valueEmpty');
    }
    const v2 = $('#bkV2');
    if (v2 && B.name) v2.textContent = B.name + ' · ' + B.phone;
  }
  // вариант B: три шага 01 Стол → 02 Кто → 03 Подтверждение («Когда» живёт в пульте)
  $('#bkTo2')?.addEventListener('click', () => {
    if (!B.tableId) return; // без выбранного места дальше не идём
    maxReached = Math.max(maxReached, 2); goto(2);
  });
  $('#bkTo3')?.addEventListener('click', () => {
    if (!validateWho()) { $('#bkE3')?.classList.add('show'); return; }
    $('#bkE3')?.classList.remove('show');
    maxReached = Math.max(maxReached, 3);
    fillSummary();
    if (!B.idemKey) B.idemKey = uuid();
    goto(3);
  });

  /* ---------- шаг 03: контакты (маска +7, 10 цифр, ТЗ §3.7) ---------- */
  function phoneMask(inp) {
    inp.addEventListener('input', () => {
      let d = inp.value.replace(/\D/g, '');
      if (d.startsWith('8')) d = '7' + d.slice(1);
      if (!d.startsWith('7')) d = d ? '7' + d : '';
      d = d.slice(0, 11);
      let out = '';
      if (d.length) out = '+7';
      if (d.length > 1) out += ' ' + d.slice(1, 4);
      if (d.length > 4) out += ' ' + d.slice(4, 7);
      if (d.length > 7) out += '-' + d.slice(7, 9);
      if (d.length > 9) out += '-' + d.slice(9, 11);
      inp.value = out;
    });
  }
  phoneMask($('#bkPhone'));
  phoneMask($('#bkwPhone'));
  const phoneOk = v => /^\+7 ?\d{3} ?\d{3}-\d{2}-\d{2}$/.test(v.trim());

  function validateWho() {
    readWho();
    const nameOk = B.name.length >= 2;
    $('#bkName')?.classList.toggle('err', !nameOk);
    $('#bkwName')?.classList.toggle('err', !nameOk);
    const okPhone = phoneOk(B.phone);
    $('#bkPhone')?.classList.toggle('err', !okPhone);
    $('#bkwPhone')?.classList.toggle('err', !okPhone);
    return nameOk && okPhone;
  }
  function readWho() {
    const name = $('#bkwName')?.value.trim() || $('#bkName')?.value.trim() || '';
    const phone = $('#bkwPhone')?.value.trim() || $('#bkPhone')?.value.trim() || '';
    const comment = $('#bkwComment')?.value.trim() || $('#bkComment')?.value.trim() || '';
    B.name = name; B.phone = phone; B.comment = comment;
  }
  // синхронизация полей между десктопным аккордеоном и мобильным мастером
  [['bkName', 'bkwName'], ['bkPhone', 'bkwPhone'], ['bkComment', 'bkwComment']].forEach(([a, b]) => {
    const ea = $('#' + a), eb = $('#' + b);
    if (!ea || !eb) return;
    ea.addEventListener('input', () => { if (eb.value !== ea.value) eb.value = ea.value; });
    eb.addEventListener('input', () => { if (ea.value !== eb.value) ea.value = eb.value; });
  });

  /* ---------- шаг 04: подтверждение, заявка (Фаза 0, без оплаты) ---------- */
  function fillSummary() {
    const t = B.tableId ? byId[B.tableId] : null;
    const el = t ? $('.plan .spot[data-table-id="' + t.id + '"]') : null;
    const spotLabel = t ? (el ? (el.dataset.title || t.label) : t.label) : sget('summary.noSpot');
    const rows = {
      1: spotLabel + (el && el.dataset.cap ? ' (' + el.dataset.cap + ')' : ''),
      2: dateShort(B.bd) + ', ' + minLabel(B.slot),
      3: B.name + ' · ' + B.phone,
      4: String(B.guests),
      5: t ? depositLine(t) : ''
    };
    ['bkS1', 'bkS2', 'bkS3', 'bkS4', 'bkS5'].forEach((id, i) => setText($('#' + id), rows[i + 1]));
    ['bkwS1', 'bkwS2', 'bkwS3', 'bkwS4', 'bkwS5'].forEach((id, i) => setText($('#' + id), rows[i + 1]));
  }
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }));
  async function submit() {
    if (B.pendingSubmit || !B.tableId) return;
    const agree = $('#bkAgree')?.checked || $('#bkwAgree')?.checked;
    if (!agree) {
      $('#bkE4')?.classList.add('show');
      $('#bkwE4')?.classList.add('show');
      return;
    }
    $('#bkE4')?.classList.remove('show');
    $('#bkwE4')?.classList.remove('show');
    if (!B.idemKey) B.idemKey = uuid();
    B.pendingSubmit = true;
    setSubmitUI(true);
    const payload = {
      businessDate: iso(B.bd),
      slot: minLabel(B.slot),
      tableId: B.tableId,
      guests: B.guests,
      name: B.name,
      phone: '+7' + B.phone.replace(/\D/g, '').slice(1),
      comment: B.comment,
      source: 'site'
    };
    let bookingId = null, paymentUrl = null;
    try {
      const res = await createBooking(payload, B.idemKey);
      bookingId = res.bookingId;
      paymentUrl = res.paymentUrl || null;
    } catch (e) {
      setSubmitUI(false);
      B.pendingSubmit = false;
      if (e.status === 409) {
        if (e.body && e.body.nearestFreeAt) setSlot(toBizMin(e.body.nearestFreeAt));
        alertTableTaken(e.body && e.body.nearestFreeAt);
        return;
      }
      if (e.status === 429) { showError(sget('error.429')); return; }
      if (e.status === 422) { showError(sget('error.422')); goto(2); return; }
      // прочие ошибки (сеть, 5xx): честно говорим об ошибке, заявку
      // «принятой» не показываем, гость может повторить с тем же Idempotency-Key
      showError(sget('error.generic'));
      return;
    }
    if (paymentUrl) { location.href = paymentUrl; return; } // задел под оплату (ТЗ §3.7)
    const t = byId[B.tableId];
    const spotLabel = $('.plan .spot[data-table-id="' + t.id + '"]')?.dataset.title || t.label;
    const summary = {
      id: bookingId,
      spot: spotLabel,
      date: dateShort(B.bd),
      time: minLabel(B.slot),
      guests: B.guests,
      ts: Date.now()
    };
    try { localStorage.setItem('o62booking', JSON.stringify(summary)); } catch (e) {}
    B.pendingSubmit = false;
    setSubmitUI(false); // сброс кнопки/спиннера: после success-экрана форма должна быть живой
    showSuccess(summary);
  }
  function setSubmitUI(wait) {
    [['#bkSubmit', '#bkWait'], ['#bkwGo', null]].forEach(([btnSel]) => {
      const btn = $(btnSel);
      if (!btn) return;
      btn.disabled = wait;
    });
    $('#bkWait')?.classList.toggle('show', wait);
  }
  function showError(text) {
    const box = $('#bkErrBox');
    if (box) { box.textContent = text; box.classList.add('show'); }
    const wbox = $('#bkwErrBox');
    if (wbox) { wbox.textContent = text; wbox.classList.add('show'); }
  }
  function hideErrors() {
    $('#bkErrBox')?.classList.remove('show');
    $('#bkwErrBox')?.classList.remove('show');
  }
  function alertTableTaken(nearestFreeAt) {
    showError(sget('tableTaken') + (nearestFreeAt ? ' · ' + fmt(sget('busy.action'), { time: nearestFreeAt }) : ''));
  }
  ['#bkSubmit', '#bkwGo'].forEach(sel => $(sel)?.addEventListener('click', () => {
    // шаг 04 в аккордеоне и кнопка мастера отправляют заявку; в шагах 1-3 мастер просто листает
    if (sel === '#bkwGo' && wstep !== 4) { wizardGo(); return; }
    if (sel === '#bkwGo' && wstep === 4) { submit(); return; }
    submit();
  }));

  /* ---------- success-экран и плашка «У вас есть заявка» (ТЗ §3.7) ---------- */
  const successBox = $('#bkSuccess');
  function showSuccess(s) {
    if (!successBox) return;
    setText($('#bkSuccessTitle'), sget('success.title'));
    setText($('#bkSuccessLine'), fmt(sget('success.line'), { spot: s.spot, date: s.date, time: s.time }));
    setText($('#bkSuccessBtn'), sget('success.close'));
    if (wiz) wiz.hidden = true;
    if (sb) sb.hidden = true;
    closeTip();
    if (bkw && !bkw.hidden) closeWizard();
    successBox.hidden = false;
    successBox.scrollIntoView({ behavior: RM ? 'auto' : 'smooth', block: 'center' });
    B.idemKey = null;
  }
  $('#bkSuccessBtn')?.addEventListener('click', () => {
    successBox.hidden = true;
    if (wiz) wiz.hidden = false;
    if (sb) sb.hidden = false;
  });
  function renderPending() {
    const box = $('#bkPending');
    if (!box) return;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('o62booking') || 'null'); } catch (e) {}
    if (!saved || !saved.spot) { box.classList.remove('show'); box.hidden = true; return; }
    setText($('#bkPendingLabel'), sget('pending.exists'));
    setText($('#bkPendingLine'), fmt(sget('pending.line'), { spot: saved.spot, date: saved.date, time: saved.time }));
    setText($('#bkPendingReset'), sget('pending.reset'));
    box.hidden = false;
    requestAnimationFrame(() => box.classList.add('show'));
  }
  $('#bkPendingReset')?.addEventListener('click', () => {
    try { localStorage.removeItem('o62booking'); } catch (e) {}
    renderPending();
  });

  /* ---------- мобильный полноэкранный мастер ---------- */
  const bkw = $('#bkw');
  let wstep = 1;
  let wLastFocus = null;
  let wizFilter = 'all';
  const wizMeta = {
    1: { name: sget('wizard.stepName1'), title: sget('wizard.step1Title'), go: sget('wizard.go') },
    2: { name: sget('wizard.stepName2'), title: sget('wizard.step2Title'), go: sget('wizard.go') },
    3: { name: sget('wizard.stepName3'), title: sget('wizard.step3Title'), go: sget('wizard.go') },
    4: { name: sget('wizard.stepName4'), title: sget('wizard.step4Title'), go: sget('phase0.submit') }
  };
  let bkwListBuilt = false;
  function renderWizardList(filter) {
    wizFilter = filter || wizFilter;
    const list = $('#bkwList');
    if (!list || !bkwListBuilt) return;
    list.innerHTML = '';
    TABLES.forEach(t => {
      const kind = tableKind(t);
      if (wizFilter !== 'all' && kind !== wizFilter) return;
      const el = $('.plan .spot[data-table-id="' + t.id + '"]');
      const st = statusOf(t);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'bkw-card' + (st !== 'free' ? ' ' + st : '') + (B.tableId === t.id ? ' sel' : '');
      card.dataset.tableId = t.id;
      card.setAttribute('aria-label', (el ? el.getAttribute('aria-label') : t.label) || '');
      card.innerHTML =
        '<img src="' + (el ? el.dataset.photo || '' : '') + '" alt="" loading="lazy" decoding="async">' +
        '<span class="bkw-card-txt">' +
          '<b>' + (el ? el.dataset.title || t.label : t.label) + '</b>' +
          '<span class="bkw-card-cap">' + (el ? el.dataset.cap || '' : '') + '</span>' +
          '<span class="bkw-card-dep">' + depositLine(t) + '</span>' +
        '</span>' +
        '<span class="bkw-card-mark ' + (st === 'busy' ? 'busy' : 'free') + '">' + (st === 'busy' ? sget('busy.word') : sget('free.word')) + '</span>';
      card.addEventListener('click', () => {
        if (st === 'busy' || st === 'dimmed') { openTip(card, t); return; }
        selectTable(t.id);
        setTimeout(() => gotoWizardStep(3), 220);
      });
      list.appendChild(card);
    });
    updateWizardGo();
  }
  $('#bkwFilters')?.addEventListener('click', e => {
    const f = e.target.closest('.bkw-filter');
    if (!f) return;
    $$('.bkw-filter').forEach(x => x.classList.toggle('on', x === f));
    renderWizardList(f.dataset.f);
    // фильтр по вместимости: «Столы» и т.п. учитывают число гостей через статусы выше
    void B.guests;
  });
  $('#bkwGminus')?.addEventListener('click', () => setGuests(B.guests - 1));
  $('#bkwGplus')?.addEventListener('click', () => setGuests(B.guests + 1));
  $('#sbGminus')?.addEventListener('click', () => setGuests(B.guests - 1));
  $('#sbGplus')?.addEventListener('click', () => setGuests(B.guests + 1));

  function fillSelchips() {
    const t = B.tableId ? byId[B.tableId] : null;
    const el = t ? $('.plan .spot[data-table-id="' + t.id + '"]') : null;
    [['bkwSelchip3', 'bkwSelPh3', 'bkwSelTtl3', 'bkwSelSub3']].forEach(ids => {
      const chip = $('#' + ids[0]);
      if (!chip) return;
      if (!t) { chip.hidden = true; return; }
      chip.hidden = false;
      $('#' + ids[1]).src = el ? el.dataset.photo || '' : '';
      $('#' + ids[2]).textContent = el ? el.dataset.title || t.label : t.label;
      $('#' + ids[3]).textContent = (el ? el.dataset.cap || '' : '') + ' · ' + depositLine(t);
    });
  }
  $('#bkwSelX3')?.addEventListener('click', () => gotoWizardStep(2));
  $('#bkwChangeWhen')?.addEventListener('click', () => gotoWizardStep(1));

  function updateWizardGo() {
    const go = $('#bkwGo');
    const hint = $('#bkwFootHint');
    if (!go) return;
    let disabled = false, label = wizMeta[wstep].go, hintText = '';
    if (wstep === 1) {
      hintText = dateHuman(B.bd) + ' · ' + minLabel(B.slot) + ' · ' + B.guests + ' ' + guestsWord(B.guests);
    } else if (wstep === 2) {
      disabled = !B.tableId;
      hintText = disabled ? sget('wizard.hintSelectSpot') : fmt(sget('wizard.hintSelected'), { spot: byId[B.tableId]?.label });
    } else if (wstep === 3) {
      hintText = sget('wizard.hintContacts');
    } else if (wstep === 4) {
      hintText = sget('phase0.note');
    }
    if (B.pendingSubmit) { go.disabled = true; return; }
    go.disabled = disabled;
    go.textContent = label;
    if (hint) { hint.hidden = !hintText; hint.textContent = hintText; }
  }
  function wizardGo() {
    if (wstep === 1) { gotoWizardStep(2); return; }
    if (wstep === 2) {
      if (!B.tableId) return;
      gotoWizardStep(3); return;
    }
    if (wstep === 3) {
      if (!validateWho()) { $('#bkwE3')?.classList.add('show'); return; }
      $('#bkwE3')?.classList.remove('show');
      if (!B.idemKey) B.idemKey = uuid();
      fillSummary();
      gotoWizardStep(4); return;
    }
  }
  function gotoWizardStep(n) {
    if (!bkw) return;
    wstep = Math.max(1, Math.min(4, n));
    $$('#bkw .bkw-step').forEach(s => s.classList.toggle('on', Number(s.dataset.bkw) === wstep));
    $$('#bkw .bkw-prog i').forEach((seg, i) => seg.classList.toggle('on', i < wstep));
    setText($('#bkwKicker'), fmt(sget('wizard.kicker'), { n: pad(wstep), name: wizMeta[wstep].name }));
    setText($('#bkwTitle'), wizMeta[wstep].title);
    if (wstep === 1) { renderDates($('#bkwDates'), 'bkw-date'); renderTimes($('#bkwTimes'), 'bkw-time'); }
    if (wstep === 2) {
      if (!bkwListBuilt) { bkwListBuilt = true; }
      const line = $('#bkwSlotLineText');
      if (line) line.textContent = dateHuman(B.bd) + ' · ' + minLabel(B.slot) + ' · ' + B.guests + ' ' + guestsWord(B.guests);
      renderWizardList(wizFilter);
    }
    if (wstep === 3) { fillSelchips(); renderGuestUI(); }
    if (wstep === 4) { fillSummary(); }
    const body = $('#bkwBody');
    if (body) body.scrollTop = 0;
    updateWizardGo();
  }
  function openWizard(preSlotTableId) {
    if (!bkw) return;
    wLastFocus = document.activeElement;
    bkw.hidden = false;
    requestAnimationFrame(() => bkw.classList.add('open'));
    document.body.classList.add('bkw-open');
    const t = preSlotTableId ? byId[preSlotTableId] : null;
    if (t && statusOf(t) === 'free') {
      selectTable(t.id);
      gotoWizardStep(3);
    } else {
      gotoWizardStep(1);
    }
  }
  function closeWizard() {
    if (!bkw || bkw.hidden) return;
    bkw.classList.remove('open');
    document.body.classList.remove('bkw-open');
    setTimeout(() => { bkw.hidden = true; }, 300);
    if (wLastFocus && wLastFocus.focus) wLastFocus.focus();
  }
  $('#bkwBack')?.addEventListener('click', () => { if (wstep === 1) closeWizard(); else gotoWizardStep(wstep - 1); });
  $('#bkwX')?.addEventListener('click', closeWizard);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && bkw && !bkw.hidden) closeWizard(); });
  $('#bkOpen')?.addEventListener('click', () => openWizard(B.tableId || null));
  $$('a[href="#bron"]').forEach(a => {
    a.addEventListener('click', e => {
      if (!matchMedia('(max-width: 900px)').matches) return;
      e.preventDefault();
      const holder = a.closest('[data-spot]');
      openWizard(holder ? holder.dataset.spot : (B.tableId || null));
    });
  });

  /* ---------- контракт data-table-id (ТЗ §4): сверка схемы и конфига ---------- */
  TABLES.forEach(t => {
    if (!$('.plan .spot[data-table-id="' + t.id + '"]'))
      console.warn('[b62] на схеме нет стола из конфига:', t.id);
  });

  /* ---------- старт: дефолтный слот подставлен сразу (ТЗ §3.4) ---------- */
  const def = defaultSlot(BD0);
  B.bd = def.bd;
  B.slot = def.slot;
  // слот-бар не зависит от занятости: рисуем до её загрузки, меньше сдвигов (ТЗ §8, G1)
  renderSlotbar();
  initWheel();
  syncStepVals();
  await loadAvailability(B.bd);
  applyStatuses();
  updateCounters();
  syncStepVals();
  renderPending();
  addHitAreas();
  // пересчёт hit-подложек при смене масштаба схемы (ресайз/поворот, ТЗ §8)
  let hitT;
  addEventListener('resize', () => { clearTimeout(hitT); hitT = setTimeout(addHitAreas, 180); }, { passive: true });
  if (wiz) goto(1);
  window.B62.api = { getConfig, getAvailability, createBooking };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
