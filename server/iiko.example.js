/**
 * iikoCloud API: токен по apiLogin + создание резерва стола.
 * Документация: https://api-ru.iiko.services/  (Reserves)
 */
const API = 'https://api-ru.iiko.services';
const TABLE_MAP = {
  't-1': '', 't-2': '', 't-3': '', 't-4': '', 't-5': '', 't-6': '', 't-7': '',
  'big-1': '', 'big-2': '',
  'vip-1': '', 'vip-2': '', 'vip-3': '',
  'bar-1': '', 'bar-2': '', 'bar-3': '', 'bar-4': '', 'bar-5': '',
};

async function token() {
  const r = await fetch(API + '/api/1/access_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiLogin: process.env.IIKO_API_LOGIN }),
  });
  return (await r.json()).token;
}

/** booking: { spotId, spotLabel, dateISO, time, durationMinutes, guests, comment } */
async function createReserve(booking, customer, amountKopecks, orderId) {
  const t = await token();
  const body = {
    organizationId: process.env.IIKO_ORGANIZATION_ID,
    terminalGroupId: process.env.IIKO_TERMINAL_GROUP_ID,
    customer: { name: customer.name, phone: customer.phone },
    phone: customer.phone,
    guestsCount: booking.guests,
    tableIds: [TABLE_MAP[booking.spotId]].filter(Boolean),
    estimatedStartTime: booking.dateISO + ' ' + booking.time + ':00.000',
    durationInMinutes: booking.durationMinutes,
    shouldRemind: true,
    comment: [
      'Бронь с сайта, заказ ' + orderId,
      'Место: ' + booking.spotLabel,
      'Депозит оплачен: ' + (amountKopecks / 100) + ' ₽ (Т-Банк)',
      booking.comment,
    ].filter(Boolean).join(' · '),
  };
  const r = await fetch(API + '/api/1/reserves/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (data.errorDescription) throw new Error('iiko: ' + data.errorDescription);
  return data;
}

module.exports = { createReserve };
