/**
 * /api/pay/init — создание платежа в Т-Банк Эквайринг (API v2).
 * Документация: https://www.tbank.ru/kassa/dev/payments/  (метод Init)
 * Запуск: node tinkoff-init.example.js  (Express, PORT=3000)
 */
const express = require('express');
const crypto = require('crypto');

const TERMINAL_KEY = process.env.TINKOFF_TERMINAL_KEY;
const PASSWORD = process.env.TINKOFF_PASSWORD;
const SITE = process.env.SITE_ORIGIN || 'https://example.com';

/** Token = SHA-256 от конкатенации значений параметров (+Password), отсортированных по ключу */
function sign(params) {
  const src = { ...params, Password: PASSWORD };
  const str = Object.keys(src).sort().map(k => src[k]).join('');
  return crypto.createHash('sha256').update(str).digest('hex');
}

const app = express();
app.use(express.json());

app.post('/api/pay/init', async (req, res) => {
  const { orderId, amount, description, customer, booking, successUrl, failUrl } = req.body;
  const base = {
    TerminalKey: TERMINAL_KEY,
    Amount: amount,                       // копейки
    OrderId: orderId,
    Description: description.slice(0, 250),
    SuccessURL: successUrl || SITE + '?payment=success',
    FailURL: failUrl || SITE + '?payment=fail',
    NotificationURL: SITE.replace(/\/$/, '') + '/api/pay/notify',
  };
  const payload = {
    ...base,
    Token: sign(base),
    DATA: { Phone: customer.phone, Name: customer.name },
    Receipt: {                            // чек 54-ФЗ — согласовать СНО и НДС
      Phone: customer.phone,
      Taxation: 'usn_income',
      Items: [{
        Name: 'Депозит брони: ' + booking.spotLabel,
        Price: amount, Quantity: 1, Amount: amount,
        Tax: 'none', PaymentObject: 'payment',
      }],
    },
  };
  const r = await fetch('https://securepay.tinkoff.ru/v2/Init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!data.Success) return res.status(502).json({ error: data.Message, details: data.Details });
  // Сохранить черновик брони под PaymentId — понадобится в webhook
  await saveDraft(data.PaymentId, { orderId, booking, customer, amount });
  res.json({ paymentUrl: data.PaymentURL, paymentId: data.PaymentId });
});

async function saveDraft(paymentId, draft) {
  // Redis / БД / KV — на ваш стек. Для теста:
  console.log('draft', paymentId, JSON.stringify(draft));
}

app.listen(process.env.PORT || 3000);
