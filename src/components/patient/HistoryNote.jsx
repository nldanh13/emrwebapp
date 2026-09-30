// src/components/patient/HistoryNote.jsx — 1 dòng lịch sử từ Kho người bệnh cho 1 người bệnh đang xem
// (Phòng khám: lượt này là tái khám đúng hẹn / trễ / trước hẹn; Hành chánh: tái nhập viện ≤ 30 ngày).
import { C, FS } from '../../tokens.js';
import { formatDmy } from '../DateField.jsx';

const day = v => formatDmy(String(v || '').slice(0, 10));
const LOAI = { kham: 'khám', noi_tru: 'nằm viện' };

export function historyTitle(ls) {
  if (!ls) return '';
  const parts = [];
  if (ls.lan_truoc) {
    const l = ls.lan_truoc;
    parts.push(`Lần trước: ${LOAI[l.loai] || l.loai} ${day(l.gio_vao)}${l.chan_doan_chinh ? ` — ${l.chan_doan_chinh}` : ''}`);
  }
  if (ls.hen) parts.push(`Hẹn tái khám ${day(ls.hen.ngay_hen)} (từ lần ${LOAI[ls.hen.tu_luot?.loai] || ''} ${day(ls.hen.tu_luot?.gio_vao)})`);
  if (ls.ra_vien_gan_nhat) parts.push(`Ra viện gần nhất ${day(ls.ra_vien_gan_nhat.gio_ra)}, cách ${ls.ra_vien_gan_nhat.so_ngay} ngày`);
  parts.push(`Trước đó: ${ls.so_luot_kham} lượt khám, ${ls.so_dot_noi_tru} đợt nằm viện`);
  return parts.join('\n');
}

/** mode 'clinic' ưu tiên thông tin hẹn tái khám; 'inpatient' ưu tiên tái nhập viện. */
export default function HistoryNote({ lichSu, mode = 'clinic' }) {
  const ls = lichSu;
  if (!ls) return null;
  const items = [];
  const hen = ls.hen;
  const rv = ls.ra_vien_gan_nhat;
  if (mode === 'inpatient' && rv?.trong_30_ngay) {
    items.push({ color: C.amber, text: `Tái nhập viện: ra viện ${day(rv.gio_ra)}, sau ${rv.so_ngay} ngày` });
  }
  if (mode === 'clinic' && hen) {
    if (hen.trang_thai === 'dung_hen') items.push({ color: C.green, text: `Tái khám đúng hẹn (${day(hen.ngay_hen)})` });
    else if (hen.trang_thai === 'tre_hen') items.push({ color: C.amber, text: `Tái khám trễ ${hen.lech_hen} ngày (hẹn ${day(hen.ngay_hen)})` });
    else items.push({ color: C.text2, text: `Khám trước hẹn (hẹn ${day(hen.ngay_hen)})` });
  }
  if (mode === 'clinic' && rv?.trong_30_ngay) {
    items.push({ color: C.amber, text: `Ra viện ${day(rv.gio_ra)} (${rv.so_ngay} ngày trước)` });
  }
  if (!items.length && ls.lan_truoc) {
    const n = ls.so_luot_kham + ls.so_dot_noi_tru;
    items.push({ color: C.text3, text: `Đã đến ${n} lần · gần nhất ${day(ls.lan_truoc.gio_vao)}` });
  }
  return (
    <span title={historyTitle(ls)} style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', fontSize: FS.xs }}>
      {items.map(i => <span key={i.text} style={{ color: i.color, fontWeight: i.color === C.text3 ? 500 : 600 }}>{i.text}</span>)}
    </span>
  );
}
