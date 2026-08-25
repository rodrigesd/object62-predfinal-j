// PR1 (WP-порт) · CORS для поддомена WordPress: виджет брони на сайте
// 6and2.skalkindmitriy.ru ходит в этот API кросс-оригином, пока API живёт
// на Cloudflare Pages (решение владельца, до переезда на VPS).
// Открываем строго один origin, звёздочка запрещена (ТЗ WP-порта, PR1).
const ALLOWED_ORIGIN = 'https://6and2.skalkindmitriy.ru';

const isAllowed = request => request.headers.get('origin') === ALLOWED_ORIGIN;

// Заголовки для ответов, собираемых с нуля: ACAO только при точном
// совпадении Origin, Vary: Origin ставится всегда (кэши не должны
// смешивать ответы для разных origin).
export function corsHeaders(request) {
  const headers = {};
  if (isAllowed(request)) {
    headers['access-control-allow-origin'] = ALLOWED_ORIGIN;
  }
  headers['vary'] = 'Origin';
  return headers;
}

// Применяет CORS к существующему Headers (ответ ASSETS может нести свой
// ACAO: * — для чужого origin его надо явно удалить, а не оставить).
export function applyCors(request, headers) {
  if (isAllowed(request)) {
    headers.set('access-control-allow-origin', ALLOWED_ORIGIN);
  } else {
    headers.delete('access-control-allow-origin');
  }
  headers.set('vary', 'Origin');
  return headers;
}

// Preflight OPTIONS: 204 без тела. Разрешения отдаём только разрешённому
// origin; чужой preflight получает пустой 204 без ACAO.
export function corsPreflight(request) {
  const headers = new Headers(corsHeaders(request));
  if (headers.has('access-control-allow-origin')) {
    headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
    headers.set('access-control-allow-headers', 'Content-Type, Idempotency-Key');
    headers.set('access-control-max-age', '86400');
  }
  return new Response(null, { status: 204, headers });
}

// Добавляет CORS-заголовки к готовому Response (тело проксируется).
export function withCors(request, response) {
  return new Response(response.body, {
    status: response.status,
    headers: applyCors(request, new Headers(response.headers))
  });
}
