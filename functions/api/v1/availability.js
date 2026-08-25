// PR2/Ф4 · GET /api/v1/availability?date=YYYY-MM-DD: занятость столов (ТЗ §6.2, §7).
// Фаза 0, BOOKING_SOURCE=demo: занятость генерирует functions/lib/demo-busy.js,
// детерминированно от даты (прайм 30-50% мест, день 10-20%, ночь 1-3 интервала),
// плюс интервалы из env DEMO_BUSY поверх. Тот же модуль считает 409-конфликт
// в /api/v1/bookings: показанное занятым и отклоняемое бэком совпадает.
// source в ответе: честный.
// PR1 (WP-порт): CORS для поддомена WordPress (functions/lib/cors.js).
import { getDemoBusy } from '../../lib/demo-busy.js';
import { corsHeaders, corsPreflight } from '../../lib/cors.js';

export async function onRequestOptions(context) {
  return corsPreflight(context.request);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const json = (status, obj) => new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // занятость меняется часто: кэш короткий
      'cache-control': 'no-cache',
      ...corsHeaders(request)
    }
  });

  const date = new URL(request.url).searchParams.get('date') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { error: 'bad_date' });

  // инвентарь столов генератор берёт из статики Pages (тот же приём, что в bookings)
  let cfg = null;
  try {
    const assetUrl = new URL('/config.json', request.url);
    const res = await env.ASSETS.fetch(new Request(assetUrl.toString()));
    if (res.ok) cfg = await res.json();
  } catch (e) {
    console.warn('[b62] availability: config.json не загружен:', e.message);
  }
  if (!cfg) console.warn('[b62] availability: config.json HTTP-ошибка, занятость пустая');

  const busyByTable = cfg ? getDemoBusy(env, cfg, date) : {};
  const tables = {};
  Object.keys(busyByTable).forEach(id => { tables[id] = { busy: busyByTable[id] }; });

  return json(200, {
    source: env.BOOKING_SOURCE || 'demo',
    businessDate: date,
    generatedAt: new Date().toISOString(),
    tables
  });
}
