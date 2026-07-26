/**
 * /api/pay/notify — webhook Т-Банк (статусы платежа).
 * На CONFIRMED создаём бронь в iiko. Ответ строго 'OK' (иначе ретраи).
 */
const express = require('express');
const crypto = require('crypto');
const { createReserve } = require('./iiko.example.js');

const PASSWORD = process.env.TINKOFF_PASSWORD;

function checkToken(body) {
  const { Token, ...rest } = body;
  delete rest.Receipt; delete rest.DATA;          // объекты в подпись не входят
  const src = { ...rest, Password: PASSWORD };
  const str = Object.keys(src).sort().map(k =>
    typeof src[k] === 'boolean' ? String(src[k]) : src[k]).join('');
  return crypto.createHash('sha256').update(str).digest('hex') === Token;
}

const app = express();
app.use(express.json());

app.post('/api/pay/notify', async (req, res) => {
  if (!checkToken(req.body)) return res.status(403).send('bad token');
  const { Status, PaymentId, OrderId } = req.body;
  if (Status === 'CONFIRMED') {
    const draft = await loadDraft(PaymentId);      // сохранён в init
    if (draft) {
      await createReserve(draft.booking, draft.customer, draft.amount, OrderId);
      // + уведомление хостес в Telegram-бот, если нужно
    }
  }
  res.send('OK');
});

async function loadDraft(paymentId) { /* Redis / БД */ return null; }

app.listen(process.env.PORT || 3001);
