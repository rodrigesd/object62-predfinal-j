// GET /api/v1/config — конфиг блока брони (ТЗ §6.2, контракт §7).
// Источник — статический /config.json из ассетов Pages: один файл правды
// и для продакшена, и для локального статического превью. Кэш — 5 минут.
// BOOKING_DEBUG=1 (env Pages) включает ?debug_now=ISO для теста ночной
// логики (ТЗ §6.3, гейт G4); в проде переменная не ставится.
export async function onRequestGet(context) {
  const assetUrl = new URL('/config.json', context.request.url);
  const res = await context.env.ASSETS.fetch(new Request(assetUrl.toString()));
  const headers = new Headers(res.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'public, max-age=300');
  let body = res.body;
  if (context.env.BOOKING_DEBUG === '1') {
    const cfg = await res.json();
    cfg.debug = true;
    body = JSON.stringify(cfg);
  }
  return new Response(body, { status: res.status, headers });
}
