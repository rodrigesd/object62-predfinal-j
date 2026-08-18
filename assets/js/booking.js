// PR1 · Каркас данных (ТЗ §10): блок брони рендерит инвентарь и тексты
// из /api/v1/config. UX не меняется: строки конфига повторяют текущие
// тексты страницы, разметка остаётся той же. Если конфиг недоступен —
// страница продолжает работать на статическом HTML.
import { getConfig } from './api.js';

// fmt: подстановка {ключ} в шаблон
const fmt = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

// Установить текст элементу с учётом вложенной разметки (иконки, свотчи):
// mode first — меняем первый текстовый узел, last — последний, иначе textContent.
function setText(el, text, mode) {
  if (mode === 'first' || mode === 'last') {
    const nodes = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE && n.nodeValue.trim());
    const node = mode === 'first' ? nodes[0] : nodes[nodes.length - 1];
    if (node) { node.nodeValue = text; return; }
  }
  el.textContent = text;
}

function countByZone(tables) {
  // kind по контракту зон: hall + vip — это «столы» счётчика, bar — отдельно
  const z = { hall: 0, vip: 0, bar: 0, big: 0 };
  tables.forEach(t => {
    if (t.zone === 'hall') {
      z.hall++;
      if (t.capacityMax >= 10) z.big++; // большие столы Б-1/Б-2
    }
    else if (t.zone === 'vip') z.vip++;
    else if (t.zone === 'bar') z.bar++;
  });
  return { tables: z.hall - z.big, big: z.big, vip: z.vip, bar: z.bar, tablesAll: z.hall + z.vip };
}

async function init() {
  const section = document.getElementById('bron');
  if (!section) return;

  let config;
  try {
    config = await getConfig();
  } catch (e) {
    console.warn('[b62] конфиг не загружен, блок работает на статике:', e.message);
    return;
  }
  window.B62 = { config };

  const S = config.strings || {};
  const inv = countByZone(config.tables || []);

  // --- инвентарь: сверка контракта data-table-id (ТЗ §4) со схемой ---
  (config.tables || []).forEach(t => {
    if (!section.querySelector('.spot[data-table-id="' + t.id + '"]'))
      console.warn('[b62] на схеме нет стола из конфига:', t.id);
  });

  // --- счётчики: итоги из конфига, свободные — из текущей разметки (busy) ---
  const freeOf = sel => [...section.querySelectorAll(sel)].filter(el => !el.classList.contains('busy')).length;
  const setCnt = (id, free, total) => {
    const el = document.getElementById(id);
    if (el) el.textContent = fmt(S['count.of'] || '{free} из {total}', { free, total });
  };
  setCnt('cntTables', freeOf('.plan .spot.table, .plan .spot.cab'), inv.tablesAll);
  setCnt('cntCabs',   freeOf('.plan .spot.cab'),  inv.vip);
  setCnt('cntBar',    freeOf('.plan .spot.seat'), inv.bar);

  // --- гидратация статических текстов блока из config.strings ---
  section.querySelectorAll('[data-str]').forEach(el => {
    const key = el.dataset.str;
    let tpl = S[key];
    if (tpl == null) { console.warn('[b62] в config.strings нет ключа:', key); return; }
    if (el.dataset.vars === 'inv') tpl = fmt(tpl, inv); // шаблон с цифрами инвентаря
    setText(el, tpl, el.dataset.strMode);
  });
  section.querySelectorAll('[data-str-ph]').forEach(el => {
    const tpl = S[el.dataset.strPh];
    if (tpl != null) el.setAttribute('placeholder', tpl);
  });

  // --- депозиты из конфига в legacy-конфиг мастера (значения совпадают 1:1) ---
  // TODO PR2+: после решения заказчика по депозитам (ТЗ §13) рендерить depositText,
  // поле depositRub снять.
  if (window.BOOKING_CFG) {
    const bySpot = {};
    (config.tables || []).forEach(t => {
      const el = section.querySelector('.spot[data-table-id="' + t.id + '"]');
      if (el && typeof t.depositRub === 'number') bySpot[el.dataset.id] = t.depositRub;
    });
    window.BOOKING_CFG.depositBySpot = bySpot;
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
