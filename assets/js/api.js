// Единственная точка данных фронта (ТЗ §6.1). Весь блок брони ходит сюда —
// никаких fetch в обход. Внешние API (iiko, Telegram, банк) с фронта
// не вызываются никогда — только свой origin.
const API_BASE = window.B62_API_BASE || '/api/v1'; // при переезде на WP: /wp-json/b62/v1
// Статический фолбэк config: на WP-поддомене указывает на копию в корне сайта
// (window.B62_CONFIG_STATIC), по умолчанию поведение прежнее.
const CONFIG_STATIC = window.B62_CONFIG_STATIC || '/config.json';

async function request(path, options) {
  const res = await fetch(API_BASE + path, options);
  if (!res.ok) {
    const err = new Error('B62 API ' + path + ': HTTP ' + res.status);
    err.status = res.status;
    err.body = await res.json().catch(() => null);
    throw err;
  }
  return res.json();
}

// GET {API_BASE}/config
export async function getConfig() {
  try {
    return await request('/config');
  } catch (e) {
    // Pages Functions недоступны (статическое превью, python http.server) —
    // читаем тот же файл как статику. Тот же origin, тот же контракт.
    console.warn('[b62] /api/v1/config недоступен, читаю /config.json:', e.message);
    const res = await fetch(CONFIG_STATIC);
    if (!res.ok) throw new Error('B62: не загрузить config.json (HTTP ' + res.status + ')');
    return res.json();
  }
}

// GET {API_BASE}/availability?date=YYYY-MM-DD
// ТЗ §7: при недоступности эндпоинта фронт обязан показать все столы свободными
// и честный source: "fallback".
export async function getAvailability(businessDate) {
  try {
    return await request('/availability?date=' + encodeURIComponent(businessDate));
  } catch (e) {
    console.warn('[b62] availability недоступен, отдаю fallback:', e.message);
    return {
      source: 'fallback',
      businessDate: businessDate,
      generatedAt: new Date().toISOString(),
      tables: {} // пусто = все столы свободны
    };
  }
}

// POST {API_BASE}/bookings + заголовок Idempotency-Key (ТЗ §6.1, §7).
// TODO PR4: эндпоинт появится в Фазе 0-бэка; до этого вызов завершится 404.
export async function createBooking(payload, idemKey) {
  return request('/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey },
    body: JSON.stringify(payload)
  });
}
