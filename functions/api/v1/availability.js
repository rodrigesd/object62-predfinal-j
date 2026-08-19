// PR2/Ф4 · GET /api/v1/availability?date=YYYY-MM-DD — занятость столов (ТЗ §6.2, §7).
// Фаза 0 — генератор: BOOKING_SOURCE=demo → все столы свободны, плюс интервалы
// из env DEMO_BUSY (JSON) для теста занятости. source в ответе — честный.
//
// DEMO_BUSY принимает два вида JSON:
//   массив:    [{"tableId":"s3","from":"19:30","to":"21:30","kind":"reserve"}]
//   по столам: {"s3":[{"from":"19:30","to":"21:30"}]}
// Времена — «HH:MM» в координатах бизнес-даты (ночные — «02:30»).
export async function onRequestGet(context) {
  const { request, env } = context;
  const json = (status, obj) => new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // занятость меняется часто: кэш короткий
      'cache-control': 'no-cache'
    }
  });

  const date = new URL(request.url).searchParams.get('date') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { error: 'bad_date' });

  const tables = {};
  const source = env.BOOKING_SOURCE || 'demo';
  if (source === 'demo' && env.DEMO_BUSY) {
    try {
      const demo = JSON.parse(env.DEMO_BUSY);
      const add = (id, iv) => {
        (tables[id] = tables[id] || { busy: [] }).busy.push({
          from: iv.from,
          to: iv.to,
          kind: iv.kind || 'reserve'
        });
      };
      if (Array.isArray(demo)) {
        demo.forEach(iv => iv && iv.tableId && add(iv.tableId, iv));
      } else if (demo && typeof demo === 'object') {
        Object.keys(demo).forEach(id => (demo[id] || []).forEach(iv => add(id, iv)));
      }
    } catch (e) {
      // битый DEMO_BUSY не роняет эндпоинт: просто отдаём пустую занятость
      console.warn('[b62] DEMO_BUSY не распарсился:', e.message);
    }
  }

  return json(200, {
    source,
    businessDate: date,
    generatedAt: new Date().toISOString(),
    tables
  });
}
