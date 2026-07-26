# Бронь → оплата Т-Банк → iiko: серверная часть

Фронтенд готов полностью (мастер 01–04, экран ожидания, обработка возврата
`?payment=success|fail`, модалки результата). Демо-режим включён флагом
`BOOKING_CFG.mode='demo'` в конце `index.html`. Для боевого режима:

## Схема

```
Гость → [сайт: мастер брони] → POST /api/pay/init ─────────────┐
                                                               ▼
                      сервер: Init (securepay.tinkoff.ru/v2/Init, Token=SHA-256)
                                                               │ PaymentURL
Гость ← редирект на страницу оплаты Т-Банк  ◄──────────────────┘
   │  успех → SuccessURL = сайт?payment=success  (модалка «ПОДТВЕРЖДЕНО»)
   │  отказ → FailURL    = сайт?payment=fail     (модалка «НЕ ПРОШЛО» + повтор)
   ▼
Т-Банк → POST NotificationURL (webhook, статус CONFIRMED)
   └── сервер: создать бронь в iiko (reserves/create) + уведомить хостес
```

## Переключение сайта в боевой режим
В `index.html` в самом низу:
```js
var BOOKING_CFG = {
  mode: 'live',                 // ← вместо 'demo'
  payInitUrl: '/api/pay/init',  // ваш endpoint (пример: tinkoff-init.example.js)
  deposits: { table: 2000, big: 4000, cab: 5000, seat: 1000 },  // ₽, согласовать
  durationMinutes: 180
};
```

## Файлы
- `tinkoff-init.example.js` — endpoint `/api/pay/init`: собирает Token, вызывает Init,
  возвращает `{ paymentUrl }`. Фронт сам делает редирект.
- `tinkoff-notify.example.js` — webhook `/api/pay/notify`: проверяет Token,
  на `CONFIRMED` дергает iiko и (опционально) шлёт в Telegram хостес.
- `iiko.example.js` — обёртка iikoCloud API: `access_token` по `apiLogin`,
  создание резерва `/api/1/reserves/create`.

## Переменные окружения
```
TINKOFF_TERMINAL_KEY=...      # из ЛК Т-Банк Эквайринг
TINKOFF_PASSWORD=...          # пароль терминала (для Token)
IIKO_API_LOGIN=...            # apiLogin из iikoWeb → API
IIKO_ORGANIZATION_ID=...
IIKO_TERMINAL_GROUP_ID=...
SITE_ORIGIN=https://kp-sayt-6and2.surge.sh
```

## Маппинг столов сайта → iiko
`data-id` на схеме зала ↔ id столов в iiko (Настройки зала → столы).
Заполнить в `iiko.example.js`:
```js
const TABLE_MAP = {
  't-1': 'uuid-стола-1', 't-2': '...', 't-3': '...', 't-4': '...',
  't-5': '...', 't-6': '...', 't-7': '...',
  'big-1': '...', 'big-2': '...',
  'vip-1': '...', 'vip-2': '...', 'vip-3': '...',
  'bar-1': '...', 'bar-2': '...', 'bar-3': '...', 'bar-4': '...', 'bar-5': '...'
};
```

## Что уходит в iiko (собирается фронтом, поле `booking` в payload)
spotId → стол по TABLE_MAP · dateISO+time → `estimatedStartTime` ·
durationMinutes · guests → `guestsCount` · имя+телефон → `customer` ·
comment + сумма депозита → `comment` резерва.
