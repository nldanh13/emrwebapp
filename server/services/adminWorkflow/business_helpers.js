'use strict';

const { normText, safeArray, toNumber, parseVNDate } = require('./common');

function textOf(value, keys = []) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value || '');
  return keys.map(k => value[k]).filter(v => v !== undefined && v !== null && String(v).trim() !== '').join(' ');
}

function orderText(order) {
  return textOf(order, [
    'name', 'label', 'ten_thuoc', 'ten_hien_thi', 'ten_dich_vu', 'ten', 'noi_dung',
    'routeLabel', 'duong_dung', 'duong_dung_goc', 'cach_dung', 'lieu_dung', 'tan_suat',
    'gio_dung', 'time', 'tg_bat_dau', 'status', 'ghi_chu', 'note', 'source', 'raw_text', 'raw',
  ]);
}

function orderNorm(order) {
  return normText(orderText(order));
}

function containsAny(text, matchers) {
  const t = normText(text);
  const ms = safeArray(matchers).map(normText).filter(Boolean);
  return ms.length ? ms.some(m => t.includes(m)) : false;
}

function firstMatcher(text, matchers) {
  const t = normText(text);
  return safeArray(matchers).map(normText).filter(Boolean).find(m => t.includes(m)) || '';
}

function routeNorm(order) {
  return normText(textOf(order, ['routeLabel', 'duong_dung', 'duong_dung_goc', 'cach_dung', 'source']));
}

function isInjectionRoute(order) {
  const t = normText([orderText(order), routeNorm(order)].join(' '));
  return /tmc|tiem tinh mach|tiem mach|iv|truyen|infusion|tiem bap|tb|tiem duoi da|duoi da|sc\b/.test(t);
}

function isInfusionRoute(order) {
  return /truyen|infusion|dich truyen|natri clorid|ringer|glucose|mannitol/.test(orderNorm(order));
}

function stoppedOrder(order) {
  return /\b(ngung|dung|stop|huy|tam ngung|hoan tra|tra kho)\b/.test(orderNorm(order));
}

function extractClockTimes(value) {
  const raw = normText(value).replace(/(\d{1,2})\s*h\s*(\d{1,2})/g, '$1:$2');
  const out = [];
  for (const m of raw.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)) {
    const h = Number(m[1]);
    const mm = Number(m[2]);
    out.push(`${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
  }
  for (const m of raw.matchAll(/\b([01]?\d|2[0-3])\s*(?:h|gio)\s*([0-5]?\d)?\b/g)) {
    const h = Number(m[1]);
    const mm = Number(m[2] || 0);
    out.push(`${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
  }
  return [...new Set(out)];
}

function frequencyPerDay(order, fallback = 1) {
  const direct = [order?.so_lan, order?.lan, order?.times, order?.frequency_per_day, order?.freqPerDay]
    .map(v => toNumber(v, NaN))
    .find(n => Number.isFinite(n) && n > 0);
  if (direct) return direct;

  const t = orderNorm(order);
  const patterns = [
    /(?:x|×)\s*(\d+(?:\.\d+)?)\s*(?:lan|lần)?\s*\/\s*ngay/,
    /(\d+(?:\.\d+)?)\s*(?:lan|lần)\s*(?:\/|moi|trong)?\s*(?:ngay|24h)/,
    /ngay\s*(\d+(?:\.\d+)?)\s*(?:lan|lần)/,
    /moi\s*(\d{1,2})\s*(?:gio|h)/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    if (re.source.includes('moi')) {
      const hours = Number(m[1]);
      if (hours > 0 && hours <= 24) return Math.round(24 / hours);
    }
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const times = extractClockTimes([order?.gio_dung, order?.time, order?.tg_bat_dau, order?.raw_text, order?.raw, order?.cach_dung].join(' '));
  if (times.length > 1) return times.length;
  return fallback;
}

function quantityPerDose(order, fallback = 1) {
  const direct = [order?.qty_per_dose, order?.doseQty, order?.dose_qty, order?.so_luong_moi_lan]
    .map(v => toNumber(v, NaN))
    .find(n => Number.isFinite(n) && n > 0);
  if (direct) return direct;
  const t = orderNorm(order);
  const m = t.match(/(\d+(?:\.\d+)?)\s*(?:vien|ong|lo|chai|goi|tube|ml|mg|g)\s*(?:\/\s*lan|moi lan)?/);
  return m ? Number(m[1]) : fallback;
}

function dailyQuantity(order, fallback = 1) {
  const direct = [order?.dailyQty, order?.daily_qty, order?.so_luong_ngay]
    .map(v => toNumber(v, NaN))
    .find(n => Number.isFinite(n) && n > 0);
  if (direct) return direct;
  return Number((quantityPerDose(order, 1) * frequencyPerDay(order, fallback)).toFixed(2));
}

function orderDate(order) {
  return String(order?.date || order?.ngay || order?.ngay_lam || order?.order_date || order?.ngay_y_lenh || '').trim();
}

function daysBetweenInclusive(start, end) {
  const a = parseVNDate(start);
  const b = parseVNDate(end);
  if (!a || !b) return null;
  const startDay = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const endDay = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  if (endDay < startDay) return null;
  return Math.floor((endDay - startDay) / 86400000) + 1;
}

function extractNumber(value) {
  const m = String(value || '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function moneyNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const compact = raw.replace(/[^0-9,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = Number(compact);
  return Number.isFinite(n) ? n : 0;
}

module.exports = {
  textOf,
  orderText,
  orderNorm,
  containsAny,
  firstMatcher,
  routeNorm,
  isInjectionRoute,
  isInfusionRoute,
  stoppedOrder,
  extractClockTimes,
  frequencyPerDay,
  quantityPerDose,
  dailyQuantity,
  orderDate,
  daysBetweenInclusive,
  extractNumber,
  moneyNumber,
};
