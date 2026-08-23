// Фаза 0 · демо-занятость: детерминированный генератор от бизнес-даты.
// Один модуль используют и /api/v1/availability (показ занятости на схеме),
// и /api/v1/bookings (409-конфликт): фронт и бэк всегда видят одну картину,
// «свободно» на схеме не может ответить 409.
//
// Правила генерации (ТЗ «Фиксы по итогам тестирования», пункт П2):
//   прайм 20:00-23:30: занято 30-50% мест;
//   день (от открытия до прайма): 10-20%;
//   ночь (после 00:00): 1-3 интервала;
//   набор зависит только от даты: два прогона одной даты дают один результат,
//   две разные даты дают разные наборы.
//
// env DEMO_BUSY (JSON) добавляется поверх засеянного, оба формата:
//   массив:    [{"tableId":"s3","from":"19:30","to":"21:30","kind":"reserve"}]
//   по столам: {"s3":[{"from":"19:30","to":"21:30"}]}
// Так в любой день можно гарантировать конкретный занятый стол для демо/тестов.

// FNV-1a: детерминированный хеш строки (одинаков на любой машине и воркере)
function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// mulberry32: маленький детерминированный PRNG
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const toMin = hhmm => parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3, 5), 10);
const toLabel = min => {
  const v = min % 1440;
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
};
// минуты бизнес-даты: часы до ролловера относятся к следующим суткам
const bizMin = (hhmm, roll) => {
  const h = parseInt(hhmm.slice(0, 2), 10);
  return toMin(hhmm) + (h < roll ? 1440 : 0);
};

// часы бизнес-даты: день недели считается по самой дате (как в bookings.js)
function businessHours(cfg, date) {
  const wd = new Date(date + 'T00:00:00Z').getUTCDay(); // 0=вс … 6=сб
  const weekend = (wd === 0 || wd === 5 || wd === 6);
  return weekend ? cfg.hours['fri-sun'] : cfg.hours['mon-thu'];
}

// k случайных разных элементов массива (детерминированно при том же rand)
function pickSome(rand, arr, k) {
  const pool = arr.slice();
  const out = [];
  while (pool.length && out.length < k) {
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  return out;
}

// env, cfg (config.json), date (YYYY-MM-DD) → { tableId: [{from,to,kind}] }
export function getDemoBusy(env, cfg, date) {
  const source = env.BOOKING_SOURCE || 'demo';
  if (source !== 'demo') return {};

  const busy = {};
  const put = (id, iv) => {
    (busy[id] = busy[id] || []).push({ from: iv.from, to: iv.to, kind: iv.kind || 'reserve' });
  };

  const tables = Array.isArray(cfg && cfg.tables) ? cfg.tables : [];
  const ids = tables.map(t => t.id);
  if (ids.length) {
    const step = cfg.slotStepMin || 30;
    const dur = cfg.defaultDurationMin || 120;
    const roll = cfg.businessDayRolloverHour || 8;
    const rand = makeRng(hashSeed('b62:' + date));
    const [open, close] = businessHours(cfg, date);
    const openMin = toMin(open);
    const closeMin = bizMin(close, roll);
    const primeFrom = toMin(cfg.primeTime || '20:00');
    const primeTo = toMin('23:30');

    // сетка стартов интервала: по шагу слотов, интервал целиком внутри окна
    const startsIn = (fromMin, toMinExcl) => {
      const out = [];
      for (let s = fromMin; s + dur <= toMinExcl; s += step) out.push(s);
      return out;
    };
    const scatter = (count, starts) => {
      if (!count || !starts.length) return;
      pickSome(rand, ids, Math.min(count, ids.length)).forEach(id => {
        const s = starts[Math.floor(rand() * starts.length)];
        put(id, { from: toLabel(s), to: toLabel(s + dur) });
      });
    };

    scatter(Math.round(ids.length * (0.3 + rand() * 0.2)), startsIn(primeFrom, primeTo + step));
    scatter(Math.round(ids.length * (0.1 + rand() * 0.1)), startsIn(openMin, primeFrom));
    scatter(1 + Math.floor(rand() * 3), startsIn(1440, closeMin));
  }

  // DEMO_BUSY поверх засеянного; битый JSON не роняет генерацию
  if (env.DEMO_BUSY) {
    try {
      const demo = JSON.parse(env.DEMO_BUSY);
      if (Array.isArray(demo)) {
        demo.forEach(iv => { if (iv && iv.tableId && iv.from && iv.to) put(iv.tableId, iv); });
      } else if (demo && typeof demo === 'object') {
        Object.keys(demo).forEach(id =>
          (demo[id] || []).forEach(iv => { if (iv && iv.from && iv.to) put(id, iv); }));
      }
    } catch (e) {
      console.warn('[b62] DEMO_BUSY не распарсился:', e.message);
    }
  }

  return busy;
}
