// PR4 · POST /api/v1/bookings — приём заявки на бронь (ТЗ §6.2, §6.4, §6.5; контракт §7).
// Цепочка: rate-limit по IP → валидация полей → проверка занятости (DEMO_BUSY) →
// идемпотентность (KV, ключ = Idempotency-Key, TTL 48 ч; повтор отдаёт тот же ответ
// без дубля заявки и без второго сообщения в Telegram) → запись заявки в KV →
// сообщение администратору в Telegram → 201.
//
// KV-биндинг: BOOKINGS_KV (Pages → Settings → Functions → KV namespace bindings).
// Без биндинга эндпоинт честно отвечает 503 storage_unavailable — молча заявку
// не «принимаем».
//
// ENV: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — без них заявка пишется в KV,
// сообщение пропускается с warning в логе (токены ждём от заказчика, ТЗ §13).
// TELEGRAM_API_BASE — опциональный оверрайд api.telegram.org для локальных
// тестов (mock-сервер); в проде не ставится.
//
// CORS наружу не открываем: заголовки Access-Control-* не добавляются (§6.5).

const RATE_LIMIT_PER_HOUR = 10; // ≥10 заявок/час с IP → 429 (§6.5, гейт G9: 11-я блокируется)
const IDEM_TTL_SEC = 48 * 3600; // TTL идемпотентности — 48 ч (§6.2)
const RL_TTL_SEC = 2 * 3600;    // счётчик rate-limit живёт 2 ч (окно — 1 ч)

const json = (status, obj, extraHeaders) => new Response(JSON.stringify(obj), {
  status,
  headers: Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store' // заявки не кэшируем нигде
  }, extraHeaders || {})
});

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
  }
  try {
    return await handleBooking(context);
  } catch (e) {
    // неожиданное — не раскрываем внутренности наружу
    console.error('[b62] bookings: необработанная ошибка:', e && e.message);
    return json(500, { error: 'internal' });
  }
}

async function handleBooking(context) {
  const { request, env } = context;
  const kv = env.BOOKINGS_KV;
  if (!kv) {
    console.error('[b62] bookings: нет биндинга BOOKINGS_KV');
    return json(503, { error: 'storage_unavailable' });
  }

  // --- rate-limit: не более RATE_LIMIT_PER_HOUR заявок в час с одного IP (§6.5) ---
  const ip = request.headers.get('cf-connecting-ip');
  if (ip && await isRateLimited(kv, ip)) {
    return json(429, { error: 'rate_limited' });
  }

  // --- валидация (не доверяем фронту, §6.5) ---
  let body;
  try { body = await request.json(); } catch (e) {
    return json(422, { error: 'validation', fields: { body: 'bad_json' } });
  }
  const cfg = await loadConfig(context);
  const { value, fields } = validatePayload(body, cfg);
  if (fields) return json(422, { error: 'validation', fields });

  const idemKey = request.headers.get('idempotency-key') || '';
  if (!/^[A-Za-z0-9-]{8,128}$/.test(idemKey)) {
    return json(422, { error: 'validation', fields: { 'Idempotency-Key': 'required' } });
  }

  // --- идемпотентность: повтор с тем же ключом → тот же ответ, без дубля (§6.2) ---
  const idemHit = await kv.get('idem:' + idemKey, 'json');
  if (idemHit && idemHit.body) {
    return json(idemHit.status || 201, idemHit.body, { 'x-idempotent-replay': 'true' });
  }

  // --- занятость: конфликт с DEMO_BUSY → 409 по контракту §7 ---
  const conflict = findConflict(env, cfg, value);
  if (conflict) {
    return json(409, {
      error: 'table_taken',
      nearestFreeAt: conflict.nearestFreeAt,
      alternatives: conflict.alternatives
    });
  }

  // --- запись заявки в KV (Фаза 0: KV — журнал заявок; TTL не ставим,
  //     срок хранения и выгрузка — вопрос к заказчику, §13) ---
  const bookingId = 'b_' + randomHex(6);
  const record = Object.assign({}, value, {
    id: bookingId,
    status: 'request', // Фаза 0: всегда request (§7); hold/paymentUrl — позже
    createdAt: new Date().toISOString()
  });
  await kv.put('bk:' + bookingId, JSON.stringify(record));

  // --- сообщение администратору в Telegram (§6.4) ---
  const tg = await sendTelegram(env, telegramText(cfg, record));
  if (tg.error) {
    // Администратор не уведомлен — честная 502, заявка остаётся в KV.
    // Идемпотентный ответ ещё не записан: повтор с тем же Idempotency-Key
    // пройдёт цепочку заново и дождётся Telegram.
    console.error('[b62] telegram недоступен:', tg.error);
    return json(502, { error: 'notify_failed' });
  }

  const responseBody = { bookingId, status: 'request', paymentUrl: null }; // §7, Фаза 0
  await kv.put('idem:' + idemKey, JSON.stringify({ status: 201, body: responseBody }), { expirationTtl: IDEM_TTL_SEC });
  return json(201, responseBody);
}

/* ---------- rate-limit (§6.5): счётчик в KV по IP за текущий час ---------- */
async function isRateLimited(kv, ip) {
  const hourBucket = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)
  const key = 'rl:' + ip + ':' + hourBucket;
  const current = parseInt(await kv.get(key) || '0', 10) + 1;
  await kv.put(key, String(current), { expirationTtl: RL_TTL_SEC });
  return current > RATE_LIMIT_PER_HOUR;
}

/* ---------- конфиг из статики Pages (тот же приём, что в /api/v1/config) ---------- */
async function loadConfig(context) {
  const assetUrl = new URL('/config.json', context.request.url);
  const res = await context.env.ASSETS.fetch(new Request(assetUrl.toString()));
  if (!res.ok) throw new Error('config.json: HTTP ' + res.status);
  return res.json();
}

/* ---------- валидация тела заявки (§6.5, §7) ---------- */
function validatePayload(body, cfg) {
  const fields = {};
  const b = (body && typeof body === 'object') ? body : {};

  // businessDate: YYYY-MM-DD, реальная дата
  const businessDate = typeof b.businessDate === 'string' ? b.businessDate : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate) || isNaN(Date.parse(businessDate + 'T00:00:00Z'))) {
    fields.businessDate = 'bad_date';
  }

  // slot: HH:MM из сетки слотов этой бизнес-даты (ночные — «02:30», §3.5)
  const slot = typeof b.slot === 'string' ? b.slot : '';
  if (!fields.businessDate) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(slot) || !slotInGrid(cfg, businessDate, slot)) {
      fields.slot = 'bad_slot';
    }
  } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(slot)) {
    fields.slot = 'bad_slot';
  }

  // tableId: только инвентарь из конфига (§4)
  const tables = Array.isArray(cfg.tables) ? cfg.tables : [];
  const table = tables.find(t => t.id === b.tableId) || null;
  if (!table) fields.tableId = 'unknown_table';

  // guests: целое 1..12 (степпер слот-бара), не больше вместимости стола
  const guests = Number(b.guests);
  if (!Number.isInteger(guests) || guests < 1 || guests > 12) {
    fields.guests = 'bad_guests';
  } else if (table && guests > table.capacityMax) {
    fields.guests = 'over_capacity';
  }

  // name: 2..60 после trim
  const name = stripCtl(typeof b.name === 'string' ? b.name : '').trim();
  if (name.length < 2 || name.length > 60) fields.name = 'bad_name';

  // phone: +7 и 10 цифр (нормализуем к +7xxxxxxxxxx)
  const digits = String(b.phone == null ? '' : b.phone).replace(/\D/g, '');
  const phone = /^7\d{10}$/.test(digits) ? '+' + digits : null;
  if (!phone) fields.phone = 'bad_phone';

  // comment: ≤500, без управляющих символов
  const comment = stripCtl(typeof b.comment === 'string' ? b.comment : '').trim();
  if (comment.length > 500) fields.comment = 'too_long';

  // source: опционально, короткая строка
  const source = typeof b.source === 'string' && b.source.length <= 32 ? b.source : 'site';

  if (Object.keys(fields).length) return { fields };
  return { value: { businessDate, slot, tableId: table.id, guests, name, phone, comment, source } };
}

// управляющие символы из пользовательского ввода убираем (§6.4)
const stripCtl = s => s.replace(/[\u0000-\u001F\u007F]+/g, ' ');

/* ---------- минуты бизнес-даты (§3.5): время < rolloverHour — после полуночи ---------- */
const bizMin = (hhmm, rolloverHour) => {
  const h = parseInt(hhmm.slice(0, 2), 10), m = parseInt(hhmm.slice(3, 5), 10);
  return h * 60 + m + (h < rolloverHour ? 1440 : 0);
};
const bizLabel = min => {
  const v = min % 1440;
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
};

// часы бизнес-даты: день недели считается по самой бизнес-дате (§3.5)
function businessHours(cfg, businessDate) {
  const wd = new Date(businessDate + 'T00:00:00Z').getUTCDay(); // 0=вс … 6=сб
  const weekend = (wd === 0 || wd === 5 || wd === 6);
  return weekend ? cfg.hours['fri-sun'] : cfg.hours['mon-thu'];
}

function slotInGrid(cfg, businessDate, slot) {
  const roll = cfg.businessDayRolloverHour || 8;
  const [open, close] = businessHours(cfg, businessDate);
  const openMin = bizMin(open, roll);
  const lastMin = bizMin(close, roll) - (cfg.lastSlotOffsetMin || 30);
  const s = bizMin(slot, roll);
  return s >= openMin && s <= lastMin && (s - openMin) % (cfg.slotStepMin || 30) === 0;
}

/* ---------- занятость (Фаза 0): конфликты только из DEMO_BUSY (§7) ---------- */
// Формула §5: стол занят для слота T ⇔ [T, T+defaultDurationMin) пересекается
// с [from, to+bufferMin) — всё в минутах бизнес-даты.
function findConflict(env, cfg, value) {
  const roll = cfg.businessDayRolloverHour || 8;
  const dur = cfg.defaultDurationMin || 120;
  const buffer = cfg.bufferMin || 15;
  const step = cfg.slotStepMin || 30;

  let busyByTable = {};
  if ((env.BOOKING_SOURCE || 'demo') === 'demo' && env.DEMO_BUSY) {
    try {
      const demo = JSON.parse(env.DEMO_BUSY);
      if (Array.isArray(demo)) {
        demo.forEach(iv => iv && iv.tableId && (busyByTable[iv.tableId] = busyByTable[iv.tableId] || []).push(iv));
      } else if (demo && typeof demo === 'object') {
        Object.keys(demo).forEach(id => (demo[id] || []).forEach(iv => (busyByTable[id] = busyByTable[id] || []).push(iv)));
      }
    } catch (e) {
      console.warn('[b62] DEMO_BUSY не распарсился:', e.message);
    }
  }

  const slotMin = bizMin(value.slot, roll);
  const isBusy = (tableId) => (busyByTable[tableId] || []).some(iv => {
    const from = bizMin(iv.from, roll), to = bizMin(iv.to, roll);
    return slotMin < to + buffer && slotMin + dur > from;
  });

  if (!isBusy(value.tableId)) return null;

  // ближайшее свободное: конец занятости + буфер, вверх к шагу сетки (§3.6)
  const iv = (busyByTable[value.tableId] || []).find(iv => {
    const from = bizMin(iv.from, roll), to = bizMin(iv.to, roll);
    return slotMin < to + buffer && slotMin + dur > from;
  });
  const freeFrom = bizMin(iv.to, roll) + buffer;
  const nearestFreeAt = bizLabel(Math.ceil(freeFrom / step) * step);
  const alternatives = (cfg.tables || [])
    .filter(t => t.id !== value.tableId && t.capacityMax >= value.guests && !isBusy(t.id))
    .slice(0, 3)
    .map(t => t.id);
  return { nearestFreeAt, alternatives };
}

/* ---------- Telegram (§6.4) ---------- */
const ZONE_WORD = { hall: 'зал', bar: 'бар', vip: 'VIP' };
const WD_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function telegramText(cfg, r) {
  const table = (cfg.tables || []).find(t => t.id === r.tableId) || { label: r.tableId, zone: '' };
  const d = new Date(r.businessDate + 'T00:00:00Z');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const lines = [
    '🆕 Заявка на бронь — объект 6/2',
    'Стол: ' + table.label + ' (' + (ZONE_WORD[table.zone] || table.zone) + ') · гостей: ' + r.guests,
    'Когда: ' + WD_SHORT[d.getUTCDay()] + ' ' + dd + '.' + mm + ' · ' + r.slot,
    'Имя: ' + r.name + ' · Тел: ' + r.phone
  ];
  if (r.comment) lines.push('Комментарий: ' + r.comment);
  lines.push('id: ' + r.id);
  return lines.join('\n');
}

async function sendTelegram(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN, chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    // токены ждём от заказчика (§13): заявка не теряется — она в KV,
    // сообщение честно фиксируем в логе
    console.warn('[b62] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы — сообщение пропущено. Текст:\n' + text);
    return { skipped: true };
  }
  const apiBase = env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  try {
    // parse_mode не передаём: текст уходит как plain text, разметка из
    // пользовательского ввода не интерпретируется (§6.4)
    const res = await fetch(apiBase + '/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok !== true) {
      return { error: 'HTTP ' + res.status + (data && data.description ? ' · ' + data.description : '') };
    }
    return { sent: true };
  } catch (e) {
    return { error: e.message };
  }
}

/* ---------- misc ---------- */
function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}
