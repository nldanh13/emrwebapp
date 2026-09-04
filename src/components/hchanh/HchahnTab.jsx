// src/components/hchanh/HchahnTab.jsx
// Tab Hành chánh — dùng Btn và Spinner từ shared.jsx

import React, { useEffect, useState } from 'react';
import { C } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import { useHchanh, SCOPE_LABEL, SCOPE_FILES, getMaBn } from './useHchanh.js';
import { HCHANH_VTYT_ITEMS, HCHANH_BED_SERVICE_ITEMS } from '../../config/hchanhLists.js';
import { printHchanh_Ticket, printHchanh_WardList } from '../../api.js';
import HchanhVtytBatchPanel from './HchanhVtytBatchPanel.jsx';
import { formatPersonName } from '../../utils/personName.js';

// ── Helpers ───────────────────────────────────────────────────────────────────


function txt(v, fb = '—') {
  if (Array.isArray(v)) {
    const parts = v.map(x => {
      if (x && typeof x === 'object') return x.ten || x.name || x.label || Object.values(x).filter(Boolean).join(' - ');
      return x;
    }).map(x => String(x ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    return parts.length ? parts.join(' · ') : fb;
  }
  if (v && typeof v === 'object') {
    const parts = Object.entries(v)
      .filter(([, val]) => val !== undefined && val !== null && String(val).trim() !== '')
      .map(([key, val]) => `${key}: ${String(val).replace(/\s+/g, ' ').trim()}`);
    return parts.length ? parts.join(' · ') : fb;
  }
  return String(v ?? '').replace(/\s+/g, ' ').trim() || fb;
}
function safeArr(v) { return Array.isArray(v) ? v : []; }
function hasDataObject(v) {
  if (!v || typeof v !== 'object') return false;
  return Object.keys(v).some(k => k !== '_meta' && v[k] !== undefined && v[k] !== null && String(v[k]).trim() !== '');
}
function hasListData(v, keys = []) {
  if (!v || typeof v !== 'object') return false;
  if (hasDataObject(v)) return true;
  return keys.some(k => Array.isArray(v?.[k]) && v[k].length > 0);
}
function nonEmpty(v) { return txt(v, '') !== ''; }
function norm(v) {
  return String(v ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
function findVtytRef(item) {
  const code = norm(item?.code || item?.ma || item?.ma_vtyt);
  const name = norm(item?.name || item?.ten || item?.label);
  if (!code && !name) return null;
  return HCHANH_VTYT_ITEMS.find(x => {
    const xCode = norm(x.code);
    const xName = norm(x.name);
    return (code && xCode === code) || (name && (xName.includes(name) || name.includes(xName)));
  }) || null;
}
function findBedServiceRef(textValue) {
  const q = norm(textValue);
  if (!q) return null;
  return HCHANH_BED_SERVICE_ITEMS.find(x => {
    const code = norm(x.code);
    const name = norm(x.name);
    return (code && q.includes(code)) || (name && (q.includes(name) || name.includes(q)));
  }) || null;
}


const TONE = {
  red:   { fg: C.red,   bg: C.redBg,   border: C.redBorder   },
  amber: { fg: C.amber, bg: C.amberBg, border: C.amberBorder  },
  green: { fg: C.green, bg: C.greenBg, border: C.greenBorder  },
  blue:  { fg: C.blue,  bg: C.blueBg,  border: C.blueBorder   },
  gray:  { fg: C.text2, bg: C.surface2, border: C.border      },
};
const tS = t => TONE[t] || TONE.gray;

const SCOPE_TONE  = { discharge: 'red', surgery: 'amber', admission: 'blue', daily: 'gray' };
const FILE_LABELS = { profile:'Thông tin nền', discharge:'Ra viện / ra khoa', billing:'Bảng kê chi phí', bed_days:'Ngày giường', surgery:'Phẫu thuật', order_history:'Lịch sử y lệnh' };


function money(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function moneyText(v) { return `${money(v).toLocaleString('vi-VN')} đ`; }
function hasOwnValue(obj, keys = []) {
  if (!obj || typeof obj !== 'object') return false;
  return keys.some(k => Object.prototype.hasOwnProperty.call(obj, k) && String(obj[k] ?? '').trim() !== '');
}
function moneyValueOrNull(obj, keys = []) {
  if (!hasOwnValue(obj, keys)) return null;
  const key = keys.find(k => Object.prototype.hasOwnProperty.call(obj, k) && String(obj[k] ?? '').trim() !== '');
  return money(obj[key]);
}
function pctText(part, total) {
  const p = money(part), t = money(total);
  if (!t || !p) return '0%';
  return `${Math.round((p / t) * 100)}%`;
}
function cleanBillingGroup(value) { return txt(value, 'Khác').replace(/^\d+\.?\s*/, '').trim() || 'Khác'; }
function sourceKey(value) {
  const n = norm(value);
  if (n.includes('bao hiem') || n === 'bhyt') return 'insurance';
  if (n.includes('vien phi') || n.includes('tu tra') || n.includes('tu tuc') || n.includes('self')) return 'self_pay';
  if (n.includes('trong goi') || n.includes('goi')) return 'package';
  if (n.includes('mien')) return 'exempt';
  return n || 'other';
}
function sourceLabel(key, fallback) {
  return ({ insurance:'Bảo hiểm', self_pay:'Viện phí / tự trả', package:'Trong gói', exempt:'Miễn giảm', other:'Khác' })[key] || txt(fallback, 'Khác');
}
function classifyBilling(row) {
  const amount = money(row?.thanh_tien ?? row?.amount ?? row?.tong_tien);
  const pg = norm(row?.payment_group || row?.doi_tuong || '');
  const sk = sourceKey(row?.doi_tuong || row?.payment_group || 'other');
  const out = { total: amount, bhyt: 0, patient: 0, self_pay: 0, package: 0, exempt: 0, other: 0 };
  if (pg.includes('bhyt') || pg.includes('bao hiem')) out.bhyt = amount;
  else if (pg.includes('self') || pg.includes('tu tra') || pg.includes('tu tuc') || pg.includes('vien phi')) { out.patient = amount; out.self_pay = amount; }
  else if (sk === 'package') out.package = amount;
  else if (sk === 'exempt') out.exempt = amount;
  else if (!pg.includes('zero')) out.other = amount;
  return out;
}
function addMoney(dst, src) { ['total','bhyt','patient','self_pay','package','exempt','other'].forEach(k => { dst[k] = money(dst[k]) + money(src?.[k]); }); }
function sortByMoney(list, key='total') { return safeArr(list).slice().sort((a,b) => money(b?.[key]) - money(a?.[key]) || txt(a?.label || a?.name).localeCompare(txt(b?.label || b?.name), 'vi')); }
function buildClientBillingOverview(billing, issues = []) {
  if (!billing || typeof billing !== 'object') return null;
  const rows = safeArr(billing.rows);
  const sources = new Map();
  const groups = new Map();
  const tops = [];
  rows.forEach(row => {
    const m = classifyBilling(row);
    const sk = sourceKey(row?.doi_tuong || row?.payment_group || 'other');
    const src = sources.get(sk) || { key:sk, label:sourceLabel(sk, row?.doi_tuong), total:0, bhyt:0, patient:0, self_pay:0, package:0, exempt:0, other:0, lines:0 };
    addMoney(src, m); src.lines += 1; sources.set(sk, src);
    const gl = cleanBillingGroup(row?.loai_yc || row?.group || row?.nhom || 'Khác');
    const gk = norm(gl) || 'other';
    const g = groups.get(gk) || { key:gk, label:gl, total:0, bhyt:0, patient:0, self_pay:0, package:0, exempt:0, other:0, lines:0 };
    addMoney(g, m); g.lines += 1; groups.set(gk, g);
    if (m.total || m.patient || m.package) tops.push({ name:txt(row?.name || row?.ten || row?.ma_dv, 'Khoản mục'), group:gl, source:sourceLabel(sk, row?.doi_tuong), department:txt(row?.khoa,''), quantity:row?.sl, unit_price:money(row?.don_gia), total:m.total, bhyt:m.bhyt, patient:m.patient, package:m.package, payment_group:row?.payment_group || '' });
  });
  const advanceValue = moneyValueOrNull(billing, ['tam_ung', 'tien_tam_ung', 'advance']);
  const summary = { total: money(billing.tong_cong) || rows.reduce((sum,r)=>sum+money(r?.thanh_tien),0), bhyt: money(billing.tong_bhyt), patient: money(billing.tong_tu_tuc), exempt: money(billing.tong_mien), package: money(Array.from(sources.values()).find(x => x.key === 'package')?.total), advance: advanceValue, advance_known: advanceValue !== null, rowsCount: rows.length };
  summary.remaining = summary.advance_known ? Math.max(0, summary.patient - money(summary.advance)) : null;
  summary.remaining_estimated = summary.advance_known ? summary.remaining : Math.max(0, summary.patient);
  const attention = safeArr(issues).filter(i => i?.severity !== 'info' && /bảng kê|chi phí|viện phí|ngày giường|y lệnh|sau ra viện|tự trả/i.test(txt([i.title, i.detail, i.action].join(' '), ''))).map(i => ({ severity:i.severity || 'warn', title:txt(i.title || 'Cần kiểm tra'), detail:txt(i.detail || i.action || ''), owner:txt(i.owner || '') }));
  const topPatient = sortByMoney(tops.filter(r => money(r.patient) > 0), 'patient').slice(0, 8);
  return { summary, sources:sortByMoney(Array.from(sources.values())), groups:sortByMoney(Array.from(groups.values())), top_total:sortByMoney(tops).slice(0,10), top_patient_pay:topPatient, attention };
}

// ── Chip nhỏ ─────────────────────────────────────────────────────────────────

function Chip({ tone = 'gray', children, style }) {
  const s = tS(tone);
  return (
    <span style={{ display:'inline-block', padding:'1px 6px', borderRadius:4,
      fontSize:10, fontWeight:600, color:s.fg, background:s.bg,
      border:`1px solid ${s.border}`, ...style }}>
      {children}
    </span>
  );
}

// ── Field row ─────────────────────────────────────────────────────────────────

function FieldRow({ label, value, tone }) {
  const s = tone ? tS(tone) : null;
  return (
    <div style={{ display:'flex', gap:6, fontSize:12, padding:'3px 0', borderBottom:`1px solid ${C.border2}` }}>
      <span style={{ color:C.text2, minWidth:140, flexShrink:0 }}>{label}</span>
      <span style={{ color: s ? s.fg : C.text, fontWeight: s ? 600 : 400 }}>{txt(value)}</span>
    </div>
  );
}

function SectionTitle({ children }) {
  return <div style={{ marginTop:12, marginBottom:5, fontSize:11, fontWeight:700, color:C.text2, letterSpacing:0.2 }}>{children}</div>;
}

function LongField({ label, value, tone }) {
  const s = tone ? tS(tone) : null;
  return (
    <div style={{ fontSize:12, padding:'5px 0', borderBottom:`1px solid ${C.border2}` }}>
      <div style={{ color:C.text2, marginBottom:2 }}>{label}</div>
      <div style={{ color: s ? s.fg : C.text, fontWeight: s ? 600 : 400, whiteSpace:'pre-wrap', lineHeight:1.35 }}>{txt(value)}</div>
    </div>
  );
}

// ── Fetch status badge ────────────────────────────────────────────────────────

function FetchBadge({ fileKey, fetched, onFetch, busy, showAction = true }) {
  const at      = fetched?.[fileKey];
  const tone    = at ? 'green' : 'gray';
  const timeStr = at ? new Date(at).toLocaleTimeString('vi-VN', { hour:'2-digit', minute:'2-digit' }) : null;
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6, padding:'4px 0' }}>
      <span style={{ width:8, height:8, borderRadius:4, flexShrink:0,
        background: at ? C.green : C.text3 }} />
      <span style={{ fontSize:12, color:C.text, flex:1 }}>{FILE_LABELS[fileKey] || fileKey}</span>
      {timeStr && <span style={{ fontSize:10, color:C.text2 }}>{timeStr}</span>}
      {showAction && (
        <Btn variant="default" disabled={busy} onClick={() => onFetch(fileKey)}
             style={{ padding:'1px 8px', fontSize:10, minWidth:0 }}>
          {busy ? <Spinner size={10} /> : at ? 'Lấy lại' : 'Lấy'}
        </Btn>
      )}
    </div>
  );
}


function fileHasData(card, fileKey) {
  const map = {
    profile: 'has_profile',
    discharge: 'has_discharge',
    billing: 'has_billing',
    bed_days: 'has_bed_days',
    surgery: 'has_surgery',
    order_history: 'has_order_history',
  };
  return Boolean(card?.[map[fileKey]] || card?.fetched?.[fileKey]);
}

function fileStatusInfo(card, fileKey) {
  const fromServer = card?.file_statuses?.[fileKey];
  if (fromServer && typeof fromServer === 'object') {
    return {
      tone: fromServer.tone || 'gray',
      symbol: fromServer.symbol || '·',
      label: fromServer.label || '',
      title: fromServer.title || fromServer.label || '',
      state: fromServer.state || '',
    };
  }

  // Fallback cho dashboard cũ nếu browser còn cache API.
  const isMissing = safeArr(card?.missing_files).includes(fileKey);
  if (card?.fetch_error_active && isMissing) return { tone:'red', symbol:'×', label:'Lỗi lấy', title:'Lỗi khi lấy dữ liệu', state:'fetch_error' };
  if (fileHasData(card, fileKey)) return { tone:'green', symbol:'✓', label:'Đạt', title:'Đã có dữ liệu', state:'ok' };
  if (isMissing && card?.data_state !== 'not_started') return { tone:'amber', symbol:'—', label:'Thiếu file', title:'Còn thiếu file dữ liệu', state:'missing' };
  return { tone:'gray', symbol:'·', label:'Chưa lấy', title:'Chưa lấy dữ liệu', state:'not_started' };
}

function FileStatusCell({ card, fileKey, label }) {
  const info = fileStatusInfo(card, fileKey);
  const s = tS(info.tone);
  const title = `${label}: ${info.title || info.label}`;
  return (
    <td title={title} style={{ padding:'7px 8px', textAlign:'center', borderBottom:`1px solid ${C.border2}` }}>
      <span style={{ display:'inline-flex', alignItems:'center', justifyContent:'center', minWidth:22, height:22,
        borderRadius:999, background:s.bg, border:`1px solid ${s.border}`, color:s.fg, fontSize:11, fontWeight:800 }}>
        {info.symbol}
      </span>
    </td>
  );
}

function patientStatus(card) {
  if (card?.status_label || card?.status_tone) {
    return { tone: card.status_tone || card.workflowStatus || 'gray', label: card.status_label || statusFilterLabel(card.workflowStatus || 'gray') };
  }
  const errors = Number(card?.issueCounts?.errors || 0);
  const warnings = Number(card?.issueCounts?.warnings || 0);
  const missing = safeArr(card?.missing_files).length;
  const state = card?.data_state || (card?.data_complete ? 'complete' : card?.has_started_fetch ? 'partial' : 'not_started');
  if (card?.fetch_error_active) return { tone:'red', label:'Lỗi máy' };
  if (state === 'not_started') return { tone:'gray', label:'Chưa lấy' };
  if (errors > 0 || warnings > 0) return { tone:'amber', label:`Cần xử lý ${errors + warnings}` };
  if (card?.data_complete || state === 'complete') return { tone:'green', label:'Đủ dữ liệu' };
  if (missing > 0) return { tone:'amber', label:`Thiếu ${missing}` };
  return { tone:'gray', label:'Chưa xử lý' };
}

function statusFilterLabel(value) {
  return ({ all:'Mọi trạng thái', red:'Lỗi máy', amber:'Cần xử lý', green:'Đủ dữ liệu', gray:'Chưa lấy' })[value] || value;
}

function scopeFilterLabel(value) {
  return ({ all:'Tất cả', discharge:'Ra viện', surgery:'PTTT', admission:'Nhập mới', daily:'Tiếp tục ĐT' })[value] || value;
}

function formatDateTime(value) {
  if (!value) return '—';
  try { return new Date(value).toLocaleString('vi-VN', { hour:'2-digit', minute:'2-digit', day:'2-digit', month:'2-digit', year:'numeric' }); }
  catch (_) { return txt(value); }
}

function PatientTableRow({ card, selected, onSelect, onFetchDischargeFull, fetchingKey }) {
  const ma_bn = getMaBn(card);
  const scope = card?.scope || 'daily';
  const isFetching = fetchingKey === ma_bn;
  const st = patientStatus(card);
  const firstIssue = safeArr(card?.issues).find(i => i?.severity !== 'info');
  const issueText = (card?.fetch_error_active ? card?.fetch_error : '') || firstIssue?.title || '';
  const rowTone = tS(st.tone);
  return (
    <tr onClick={() => onSelect(card)} style={{ cursor:'pointer', background:selected ? C.blueBg : C.surface }}>
      <td style={{ padding:'8px 10px', borderBottom:`1px solid ${C.border2}`, borderLeft:`3px solid ${selected ? C.blue : rowTone.fg}`, minWidth:230 }}>
        <div style={{ display:'flex', alignItems:'center', gap:7, minWidth:0 }}>
          <div style={{ minWidth:0, flex:1 }}>
            <div style={{ fontSize:12, fontWeight:800, color:C.text, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
              {formatPersonName(card?.ho_ten, 'Không rõ tên')}
            </div>
            <div style={{ fontSize:10, color:C.text2, marginTop:1, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
              {txt(ma_bn)}{card?.department ? ` · ${txt(card.department)}` : ''}
            </div>
          </div>
          {selected && <Chip tone="blue" style={{ fontSize:9 }}>Đang xem</Chip>}
        </div>
      </td>
      <td style={{ padding:'8px 8px', borderBottom:`1px solid ${C.border2}`, color:C.text2, fontSize:11, whiteSpace:'nowrap' }}>{txt(card?.phong)}</td>
      <td style={{ padding:'8px 8px', borderBottom:`1px solid ${C.border2}`, textAlign:'center' }}>
        <Chip tone={SCOPE_TONE[scope] || 'gray'} style={{ fontSize:9 }}>{scope.toUpperCase()}</Chip>
      </td>
      <FileStatusCell card={card} fileKey="discharge" label="Ra viện" />
      <FileStatusCell card={card} fileKey="billing" label="Bảng kê" />
      <FileStatusCell card={card} fileKey="bed_days" label="Ngày giường" />
      <FileStatusCell card={card} fileKey="surgery" label="PT/TT" />
      <FileStatusCell card={card} fileKey="order_history" label="Y lệnh" />
      <td style={{ padding:'8px 8px', borderBottom:`1px solid ${C.border2}`, minWidth:140 }}>
        <Chip tone={st.tone} style={{ fontSize:9 }}>{st.label}</Chip>
        {issueText && <div title={issueText} style={{ marginTop:3, color:st.tone === 'red' ? C.red : C.amber, fontSize:10, maxWidth:190, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{issueText}</div>}
      </td>
      <td onClick={e => e.stopPropagation()} style={{ padding:'7px 10px', borderBottom:`1px solid ${C.border2}`, textAlign:'right', whiteSpace:'nowrap' }}>
        <Btn variant="primary" disabled={isFetching} onClick={() => onFetchDischargeFull?.(card)} style={{ fontSize:10, padding:'4px 8px', minWidth:74 }}>
          {isFetching ? <><Spinner size={10} /> Lấy...</> : card?.data_complete ? 'Lấy lại' : 'Cập nhật'}
        </Btn>
      </td>
    </tr>
  );
}


function VTYTPreviewPanel({ preview, onPreview, onProcess, onInput, canRun = true, previewing = false, inputting = false }) {
  const plan = safeArr(preview?.plan);
  const jobs = plan.length ? plan : safeArr(preview?.full_plan);
  const allWarnings = jobs.flatMap(job => safeArr(job?.warnings).map(w => ({ job, text: w })));
  const allDrugs = jobs.flatMap(job => safeArr(job?.drugs).map(x => ({ ...x, ngay_lam: job.ngay_lam, input_time: job.input_time })));
  const allSupplies = jobs.flatMap(job => safeArr(job?.supplies).map(x => ({ ...x, ngay_lam: job.ngay_lam, input_time: job.input_time })));
  const processed = Boolean(preview?.processed);

  return (
    <div>
      <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:10 }}>
        <Btn variant="secondary" disabled={!canRun || previewing || inputting} onClick={onPreview} style={{ fontSize:11, padding:'4px 8px' }}>
          {previewing ? <><Spinner size={10} /> Đang quét...</> : 'Quét y lệnh mai'}
        </Btn>
        <Btn variant="secondary" disabled={!canRun || previewing || inputting || !preview || processed} onClick={onProcess} style={{ fontSize:11, padding:'4px 8px' }}>
          {processed ? 'Đã xử lý' : 'Xử lý VTYT'}
        </Btn>
        <Btn variant="primary" disabled={!canRun || previewing || inputting || !processed} onClick={onInput} style={{ fontSize:11, padding:'4px 8px' }}>
          {inputting ? <><Spinner size={10} /> Đang nhập...</> : 'Nhập VTYT'}
        </Btn>
      </div>

      {!preview ? (
        <div style={{ padding:10, borderRadius:6, background:C.surface2, border:`1px solid ${C.border}`, color:C.text2, fontSize:12, lineHeight:1.45 }}>
          Chưa có dữ liệu y lệnh ngày mai. Bấm <b>Quét y lệnh mai</b> để mở EMR và lấy danh sách thuốc/y lệnh riêng cho tab Hành chánh.
        </div>
      ) : (
        <>
          <div style={{ fontSize:11, color:C.text2, marginBottom:8 }}>
            Ngày quét: {safeArr(preview.dates).join(', ') || txt(jobs.map(j => j.ngay_lam))} · Quét lúc: {preview.createdAt ? new Date(preview.createdAt).toLocaleString('vi-VN') : '—'}{processed && preview.processedAt ? ` · Xử lý lúc: ${new Date(preview.processedAt).toLocaleString('vi-VN')}` : ''}
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:6, marginBottom:10 }}>
            {[
              ['Thuốc', allDrugs.length, 'blue'],
              [processed ? 'VTYT sẽ nhập' : 'VTYT chờ xử lý', processed ? allSupplies.length : '—', processed ? 'green' : 'gray'],
              ['Cảnh báo', allWarnings.length, allWarnings.length ? 'amber' : 'gray'],
            ].map(([label, value, tone]) => {
              const st = tS(tone);
              return <div key={label} style={{ padding:'6px 8px', borderRadius:6, background:st.bg, border:`1px solid ${st.border}` }}>
                <div style={{ fontSize:10, color:C.text2 }}>{label}</div>
                <div style={{ fontSize:18, fontWeight:700, color:st.fg }}>{value}</div>
              </div>;
            })}
          </div>

          {processed && allWarnings.length > 0 && (
            <>
              <SectionTitle>Cần kiểm tra pha/truyền</SectionTitle>
              {allWarnings.map((w, i) => (
                <div key={i} style={{ padding:'6px 8px', borderRadius:6, background:C.amberBg, border:`1px solid ${C.amberBorder}`, color:C.amber, fontSize:11, marginBottom:5 }}>
                  {w.text}
                </div>
              ))}
            </>
          )}

          <SectionTitle>Thuốc/y lệnh đã quét</SectionTitle>
          {allDrugs.length === 0 ? <div style={{ color:C.text2, fontSize:12 }}>Chưa thấy thuốc trong y lệnh đã chọn.</div> : (
            <div style={{ maxHeight:220, overflow:'auto' }}>
              {allDrugs.map((d, i) => (
                <div key={i} style={{ padding:'5px 0', borderBottom:`1px solid ${C.border2}`, fontSize:11 }}>
                  <div style={{ display:'flex', gap:5, alignItems:'baseline', flexWrap:'wrap' }}>
                    <Chip tone="blue" style={{ fontSize:9 }}>{txt(d.order_time || d.input_time || d.ngay_lam)}</Chip>
                    <span style={{ color:C.text, fontWeight:600 }}>{txt(d.name)}</span>
                  </div>
                  <div style={{ color:C.text2, marginTop:2 }}>
                    {txt(d.code, '')} {txt(d.content, '')} · SL {txt(d.quantity)} {txt(d.unit, '')} · {txt(d.route, '')}
                  </div>
                </div>
              ))}
            </div>
          )}

          <SectionTitle>Vật tư sẽ nhập</SectionTitle>
          {!processed ? (
            <div style={{ padding:8, borderRadius:6, background:C.surface2, border:`1px solid ${C.border}`, color:C.text2, fontSize:12, lineHeight:1.45 }}>
              Đã có thuốc/y lệnh. Bấm <b>Xử lý VTYT</b> để gom vật tư, kiểm Natri/Nước cất pha truyền và mở bảng vật tư cho bạn kiểm trước khi nhập.
            </div>
          ) : allSupplies.length === 0 ? <div style={{ color:C.amber, fontSize:12 }}>Chưa có vật tư y tế để nhập.</div> : (
            <div style={{ maxHeight:260, overflow:'auto' }}>
              {allSupplies.map((v, i) => {
                const ref = findVtytRef(v);
                const qty = Number(v.required_quantity ?? v.quantity ?? 0);
                const stock = Number(ref?.stock ?? NaN);
                const stockTone = ref ? (Number.isFinite(stock) && qty > stock ? 'red' : 'green') : 'amber';
                return (
                  <div key={i} style={{ padding:'6px 0', borderBottom:`1px solid ${C.border2}`, fontSize:11 }}>
                    <div style={{ display:'flex', gap:5, alignItems:'baseline', flexWrap:'wrap' }}>
                      <Chip tone="green" style={{ fontSize:9 }}>SL {txt(v.required_quantity ?? v.quantity)}</Chip>
                      {ref?.code && <Chip tone="blue" style={{ fontSize:9 }}>{ref.code}</Chip>}
                      {processed && <Chip tone={stockTone} style={{ fontSize:9 }}>{ref ? `Tồn ${Number(ref.stock || 0).toLocaleString('vi-VN')}` : 'Chưa khớp DS vật tư'}</Chip>}
                      <span style={{ color:C.text, fontWeight:700 }}>{txt(v.name)}</span>
                    </div>
                    <div style={{ color:C.text2, marginTop:2 }}>
                      {txt(v.code || ref?.code, '')} · {txt(v.unit, '')} · {txt(v.searchKeyword || ref?.name, '')}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Issue row ─────────────────────────────────────────────────────────────────

function IssueRow({ issue }) {
  const tone = issue.severity === 'error' ? 'red' : issue.severity === 'warn' ? 'amber' : 'gray';
  const s    = tS(tone);
  return (
    <div style={{ padding:'6px 10px', borderRadius:6, marginBottom:4,
      background:s.bg, border:`1px solid ${s.border}` }}>
      <div style={{ display:'flex', gap:6, alignItems:'baseline', marginBottom:2 }}>
        <Chip tone={tone}>{issue.group}</Chip>
        <span style={{ fontSize:12, fontWeight:600, color:s.fg }}>{txt(issue.title)}</span>
      </div>
      {issue.detail && <div style={{ fontSize:11, color:C.text2 }}>{issue.detail}</div>}
      {issue.action && <div style={{ fontSize:11, color:C.blue, marginTop:2 }}>→ {issue.action}</div>}
      {issue.owner  && <div style={{ fontSize:10, color:C.text3, marginTop:1 }}>Phụ trách: {issue.owner}</div>}
    </div>
  );
}


function IssueSummaryBox({ issues }) {
  const list = safeArr(issues).filter(i => i?.severity !== 'info');
  if (!list.length) return null;
  const errors = list.filter(i => i?.severity === 'error').length;
  const warnings = list.filter(i => i?.severity === 'warn').length;
  return (
    <div style={{ margin:'8px 16px 0', padding:'10px 12px', borderRadius:8,
      background:C.amberBg, border:`1px solid ${C.amberBorder}` }}>
      <div style={{ fontSize:12, fontWeight:800, color:C.amber, marginBottom:6 }}>
        Cần xử lý: {errors} lỗi nội dung{warnings ? ` · ${warnings} cảnh báo` : ''}
      </div>
      <div style={{ display:'grid', gap:4 }}>
        {list.slice(0, 4).map((issue, idx) => (
          <div key={issue.code || idx} style={{ fontSize:11, color:C.text, lineHeight:1.35 }}>
            <b>{txt(issue.group)}</b>: {txt(issue.title)}{issue.action ? ` — ${txt(issue.action)}` : ''}
          </div>
        ))}
        {list.length > 4 && <div style={{ fontSize:11, color:C.text2 }}>+{list.length - 4} vấn đề khác trong mục “Vấn đề”.</div>}
      </div>
    </div>
  );
}


// ── Danh mục tham khảo VTYT / giường ─────────────────────────────────────────

function normalizeForSearch(v) {
  return String(v ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

function ResourceListPanel({ type = 'vtyt', onClose }) {
  const [query, setQuery] = useState('');
  const isBed = type === 'bed';
  const title = isBed ? 'Danh sách giường' : 'Danh sách vật tư';
  const sourceRows = isBed ? HCHANH_BED_SERVICE_ITEMS : HCHANH_VTYT_ITEMS;
  const q = normalizeForSearch(query);
  const rows = sourceRows.filter(item => {
    if (!q) return true;
    return normalizeForSearch(Object.values(item).join(' ')).includes(q);
  });

  const copyCode = async (code) => {
    try { await navigator.clipboard?.writeText(String(code || '')); } catch {}
  };

  return (
    <aside style={{ width:'min(620px, 48vw)', minWidth:520, flexShrink:0, background:C.surface, borderLeft:`1px solid ${C.border}`,
      display:'flex', flexDirection:'column', overflow:'hidden' }}>
      <div style={{ padding:'12px 16px', borderBottom:`1px solid ${C.border}`,
        display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:10 }}>
        <div>
          <div style={{ fontSize:14, fontWeight:700, color:C.text }}>{title}</div>
          <div style={{ fontSize:11, color:C.text2, marginTop:2 }}>
            {rows.length}/{sourceRows.length} dòng · lấy từ danh mục select2 EMR
          </div>
        </div>
        <Btn variant="default" onClick={onClose} style={{ padding:'3px 10px', fontSize:11 }}>Đóng</Btn>
      </div>

      <div style={{ padding:'10px 16px', borderBottom:`1px solid ${C.border}` }}>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={isBed ? 'Tìm mã G..., Nội/Ngoại, loại giường, giá...' : 'Tìm mã VTYT..., tên vật tư, quy cách...'}
          style={{ width:'100%', padding:'7px 10px', borderRadius:6, background:C.surface2,
            border:`1px solid ${C.border}`, color:C.text, fontSize:12 }}
        />
        <div style={{ marginTop:7, display:'flex', gap:6, flexWrap:'wrap' }}>
          <Chip tone="blue">{sourceRows.length} dòng</Chip>
          {isBed ? <Chip tone="green">Dịch vụ giường</Chip> : <Chip tone="green">VTYT</Chip>}
          <Chip tone="gray">Có thể tìm mã hoặc tên</Chip>
        </div>
      </div>

      <div style={{ flex:1, overflow:'auto', padding:'10px 16px' }}>
        {rows.length === 0 ? (
          <div style={{ color:C.text2, fontSize:12, padding:20, textAlign:'center' }}>Không có dòng phù hợp.</div>
        ) : isBed ? rows.map(item => (
          <div key={item.code} style={{ padding:'8px 0', borderBottom:`1px solid ${C.border2}`, fontSize:12 }}>
            <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap' }}>
              <Chip tone="blue" style={{ fontSize:9 }}>{item.code}</Chip>
              <span style={{ color:C.text, fontWeight:700, flex:1 }}>{txt(item.name)}</span>
              <Btn variant="default" onClick={() => copyCode(item.code)} style={{ fontSize:10, padding:'1px 7px' }}>Copy mã</Btn>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:6, marginTop:6, color:C.text2 }}>
              <span>Giá DV: <b style={{ color:C.text }}>{txt(item.gia_dv)}</b></span>
              <span>Giá BH: <b style={{ color:C.text }}>{txt(item.gia_bh)}</b></span>
              <span>YC: <b style={{ color:C.text }}>{txt(item.gia_yc)}</b></span>
              <span>Chênh: <b style={{ color:C.amber }}>{txt(item.chenh_lech)}</b></span>
            </div>
          </div>
        )) : rows.map(item => (
          <div key={item.code} style={{ padding:'8px 0', borderBottom:`1px solid ${C.border2}`, fontSize:12 }}>
            <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap' }}>
              <Chip tone="blue" style={{ fontSize:9 }}>{item.code}</Chip>
              <span style={{ color:C.text, fontWeight:700, flex:1 }}>{txt(item.name)}</span>
              <Chip tone={Number(item.stock || 0) > 0 ? 'green' : 'red'} style={{ fontSize:9 }}>Tồn {Number(item.stock || 0).toLocaleString('vi-VN')}</Chip>
              <Btn variant="default" onClick={() => copyCode(item.code)} style={{ fontSize:10, padding:'1px 7px' }}>Copy mã</Btn>
            </div>
            {item.note && <div style={{ color:C.text2, marginTop:4 }}>{txt(item.note)}</div>}
          </div>
        ))}
      </div>
    </aside>
  );
}

// ── Patient card (worklist) ───────────────────────────────────────────────────

function PatientCard({ card, selected, onSelect, onFetch, onFetchDischargeFull, onFetchFile, onPreviewVTYT, onProcessVTYT, onInputVTYT, onOpenBedEdit, onPrintBilling, onCreateTicket, onRescan, onClear, fetchingKey, fetchingFile, previewVtytKey, inputVtytKey, bedEditKey, printBillingKey, vtytPreview }) {
  const ma_bn     = getMaBn(card);
  const scope     = card?.scope || 'daily';
  const errors    = card?.issueCounts?.errors   || 0;
  const warnings  = card?.issueCounts?.warnings || 0;
  const isFetching = fetchingKey === ma_bn;
  const isPreviewVtyt = previewVtytKey === ma_bn;
  const isInputVtyt = inputVtytKey === ma_bn;
  const isBedEdit = bedEditKey === ma_bn;
  const isPrintBilling = printBillingKey === ma_bn;
  const missing   = safeArr(card?.missing_files);
  const issues    = safeArr(card?.issues).filter(i => i.severity !== 'info');
  const stop      = e => e.stopPropagation();
  const severity  = errors > 0 ? 'red' : warnings > 0 ? 'amber' : card?.data_complete ? 'green' : missing.length ? 'amber' : SCOPE_TONE[scope] || 'gray';
  const sevStyle  = tS(severity);
  const issueTitle = issues[0]?.title || card?.fetch_error || '';

  return (
    <article onClick={() => onSelect(card)} style={{
      padding:'14px 16px', borderRadius: 7, marginBottom:12, cursor:'pointer',
      background: selected ? C.surface2 : (errors ? 'rgba(248,81,73,0.08)' : warnings ? 'rgba(210,153,34,0.07)' : C.surface),
      border:`1px solid ${selected ? C.blue : sevStyle.border}`,
      borderLeft:`4px solid ${sevStyle.fg}`,
      boxShadow: selected ? '0 0 0 1px rgba(88,166,255,0.16)' : 'none',
    }}>
      <div style={{ display:'grid', gridTemplateColumns:'minmax(0, 1fr) auto', gap:10, alignItems:'start' }}>
        <div style={{ minWidth:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:7, minWidth:0 }}>
            <div style={{ fontSize:15, fontWeight:800, color:C.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
              {formatPersonName(card?.ho_ten, 'Không rõ tên')}
            </div>
            {selected && <Chip tone="blue" style={{ fontSize:9 }}>Đang xem</Chip>}
          </div>
          <div style={{ fontSize:11, color:C.text2, marginTop:2 }}>
            {txt(ma_bn)} · Phòng {txt(card?.phong)}
          </div>
        </div>
        <div style={{ display:'flex', gap:4, flexShrink:0, flexWrap:'wrap', justifyContent:'flex-end', maxWidth:230 }}>
          <Chip tone={SCOPE_TONE[scope] || 'gray'} style={{ fontSize:9 }}>{scope.toUpperCase()}</Chip>
          {errors   > 0 && <Chip tone="red" style={{ fontSize:9 }}>{errors} lỗi</Chip>}
          {warnings > 0 && <Chip tone="amber" style={{ fontSize:9 }}>{warnings} cảnh báo</Chip>}
          {card?.data_complete && !errors && !warnings && <Chip tone="green" style={{ fontSize:9 }}>Đủ dữ liệu</Chip>}
          {!card?.data_complete && missing.length > 0 && <Chip tone="gray" style={{ fontSize:9 }}>{missing.length} thiếu</Chip>}
        </div>
      </div>

      {issueTitle && (
        <div style={{
          marginTop:9, padding:'7px 10px', borderRadius:8, fontSize:12,
          color: errors ? C.red : C.amber,
          background: errors ? C.redBg : C.amberBg,
          border:`1px solid ${errors ? C.redBorder : C.amberBorder}`,
          lineHeight:1.35,
        }}>
          {String(issueTitle).slice(0, 130)}{issues.length > 1 ? ` (+${issues.length - 1})` : ''}
        </div>
      )}

      <div style={{ display:'grid', gridTemplateColumns:'minmax(160px, 1fr) auto', gap:10, alignItems:'center', marginTop:12 }}>
        <Btn variant="primary" disabled={isFetching} onClick={e => { stop(e); onFetchDischargeFull?.(card); }}
             style={{ fontSize:12, padding:'7px 12px', minHeight:34, fontWeight:800 }}>
          {isFetching ? <><Spinner size={10} /> Đang lấy...</> : 'Lấy / cập nhật hồ sơ'}
        </Btn>
        <div style={{ fontSize:11, color:C.text2, textAlign:'right', lineHeight:1.35, minWidth:100 }}>
          Bấm vào thẻ<br />để xem chi tiết
        </div>
      </div>
    </article>
  );
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function DetailPanel({ card, onClose, onFetch, onFetchDischargeFull, onFetchFile, onPreviewVTYT, onProcessVTYT, onInputVTYT, onOpenBedEdit, onPrintBilling, onCreateTicket, onRescan, fetchingKey, fetchingFile, previewVtytKey, inputVtytKey, bedEditKey, printBillingKey, vtytPreview }) {
  const [tab, setTab] = useState('fetch');
  const [tabTouched, setTabTouched] = useState(false);
  const [showMoreActions, setShowMoreActions] = useState(false);
  const [showPartialFetch, setShowPartialFetch] = useState(false);
  const [billingView, setBillingView] = useState('overview');
  const ma_bn      = getMaBn(card);
  const scope      = card?.scope || 'daily';
  const isFetching = fetchingKey === ma_bn;
  const isPreviewVtyt = previewVtytKey === ma_bn;
  const isInputVtyt = inputVtytKey === ma_bn;
  const isBedEdit = bedEditKey === ma_bn;
  const isPrintBilling = printBillingKey === ma_bn;
  const hasVtytPreview = Boolean(vtytPreview?.plan?.length);
  const vtytProcessed = Boolean(vtytPreview?.processed);
  const busyAny   = isFetching || isBedEdit || isPrintBilling || Boolean(inputVtytKey) || Boolean(previewVtytKey) || Boolean(fetchingFile) || Boolean(bedEditKey) || Boolean(printBillingKey);
  const fetched    = card?.fetched || {};
  const issues     = safeArr(card?.issues).filter(i => i.severity !== 'info');
  const scopeFiles = SCOPE_FILES.discharge || ['profile'];
  const hasTicket  = card?.ticket && !['VERIFIED','CLOSED','NO_ISSUE'].includes(card?.ticket?.status);

  const profile  = card?.profile   || {};
  const disch    = card?.discharge || {};
  const billing  = card?.billing   || {};
  const billingOverview = billing?.overview || card?.billing_overview || buildClientBillingOverview(billing, issues);
  const bed      = card?.bed_days  || {};
  const surgery  = card?.surgery   || {};
  const orderHistory = card?.order_history || {};
  const bedReview = card?.qa?.bed_days_review || null;
  const bedWarnings = safeArr(bed.warnings).filter(w => !(bedReview?.expected_total && norm(w).includes('thuc te chi nam')));
  const hasProfileData = Boolean(card?.has_profile || fetched.profile || hasDataObject(profile));
  const hasDischargeData = Boolean(card?.has_discharge || fetched.discharge || hasDataObject(disch));
  const hasBillingData = Boolean(card?.has_billing || fetched.billing || hasListData(billing, ['rows']));
  const hasBedDaysData = Boolean(card?.has_bed_days || fetched.bed_days || hasListData(bed, ['rows', 'bed_summary']));
  const hasSurgeryData = Boolean(card?.has_surgery || fetched.surgery || hasListData(surgery, ['surgeries']));
  const hasOrderHistoryData = Boolean(card?.has_order_history || fetched.order_history || hasListData(orderHistory, ['rows', 'incomplete_rows']));
  const followup = disch?.followup || {};
  const phimText = [
    `X-Quang: ${disch.phim_xquang ?? 0}`,
    `CT: ${disch.phim_ct ?? 0}`,
    `Siêu âm: ${disch.phim_sieu_am ?? 0}`,
    `Khác: ${disch.phim_khac ?? 0}`,
  ].join(' · ');

  // Đổi người bệnh: ưu tiên mở mục Vấn đề nếu còn lỗi/cảnh báo.
  // Mục tiêu là người dùng thấy ngay cần sửa gì, thay vì bảng trái hiện ✓ rồi phải tự dò trong Ra viện.
  useEffect(() => {
    setShowMoreActions(false);
    setShowPartialFetch(false);
    setBillingView('overview');
    setTabTouched(false);
    const nextTab = issues.length ? 'issues' : ((card?.scope === 'discharge' && hasDischargeData) ? 'discharge' : 'fetch');
    setTab(nextTab);
  }, [ma_bn]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sau khi fetch xong: nếu còn vấn đề thì tự mở Vấn đề; chỉ khi không còn vấn đề mới mở Ra viện.
  useEffect(() => {
    if (tabTouched) return;
    if (issues.length && tab !== 'issues') setTab('issues');
    else if (!issues.length && card?.scope === 'discharge' && hasDischargeData && tab === 'fetch') setTab('discharge');
  }, [card?.scope, hasDischargeData, issues.length, tab, tabTouched]);

  const TABS = [
    { id:'fetch',     label:'Dữ liệu' },
    { id:'issues',    label:`Vấn đề${issues.length ? ` (${issues.length})` : ''}` },
    { id:'discharge', label:'Ra viện' },
    { id:'billing',   label:'Bảng kê',      hide: scope !== 'discharge' },
    { id:'bed_days',  label:'Ngày giường',  hide: scope !== 'discharge' },
    { id:'surgery',   label:'Phẫu thuật' },
    { id:'order_history', label:'Y lệnh' },
    { id:'vtyt',      label:'VTYT' },
  ].filter(t => !t.hide);

  return (
    <aside style={{ width:'clamp(580px, 46vw, 760px)', minWidth:540, flexShrink:0, background:C.surface, borderLeft:`1px solid ${C.border}`,
      display:'flex', flexDirection:'column', overflow:'hidden' }}>

      {/* Head */}
      <div style={{ padding:'12px 16px', borderBottom:`1px solid ${C.border}`,
        display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:12, background:C.surface }}>
        <div>
          <div style={{ fontSize:14, fontWeight:700, color:C.text }}>{formatPersonName(card?.ho_ten)}</div>
          <div style={{ fontSize:11, color:C.text2, marginTop:2 }}>
            {txt(ma_bn)} · Phòng {txt(card?.phong)} · <Chip tone={SCOPE_TONE[scope]||'gray'} style={{fontSize:9}}>{scope.toUpperCase()}</Chip>
          </div>
        </div>
        <Btn variant="default" onClick={onClose} style={{ padding:'3px 10px', fontSize:11 }}>Đóng</Btn>
      </div>

      {/* Actions */}
      <div style={{ padding:'12px 16px', borderBottom:`1px solid ${C.border}` }}>
        <div style={{ display:'grid', gridTemplateColumns:'minmax(220px, 1fr) auto', gap:8, alignItems:'stretch' }}>
          <Btn variant="primary" disabled={isFetching} onClick={() => onFetchDischargeFull?.(card)}
               style={{ fontSize:13, padding:'9px 12px', minHeight:40, fontWeight:800 }}>
            {isFetching ? <><Spinner size={10} /> Đang lấy...</> : 'Lấy / cập nhật hồ sơ'}
          </Btn>
          <Btn variant="secondary" onClick={() => setShowMoreActions(v => !v)}
               style={{ fontSize:12, padding:'9px 12px', minHeight:40, minWidth:116 }}>
            {showMoreActions ? 'Ẩn tác vụ' : 'Tác vụ khác'}
          </Btn>
        </div>
        <div style={{ marginTop:7, fontSize:11, color:C.text2, lineHeight:1.35 }}>
          Nút chính cập nhật toàn bộ hồ sơ hành chánh. Các thao tác phụ được ẩn để tránh bấm nhầm.
        </div>

        {showMoreActions && (
          <div style={{ marginTop:10, padding:'10px', borderRadius: 6, border:`1px solid ${C.border2}`, background:C.surface2 }}>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(118px, 1fr))', gap:7 }}>
              <Btn variant="secondary" disabled={busyAny} onClick={() => onPrintBilling?.(card)} style={{ fontSize:11, padding:'6px 9px' }}>
                {isPrintBilling ? <><Spinner size={10} /> Đang lưu...</> : 'In bảng kê'}
              </Btn>
              <Btn variant={issues.length > 0 ? 'danger' : 'secondary'} disabled={busyAny && issues.length === 0} onClick={() => onCreateTicket(card)} style={{ fontSize:11, padding:'6px 9px' }}>
                Phiếu sửa
              </Btn>
              <Btn variant="secondary" disabled={busyAny} onClick={() => onOpenBedEdit?.(card)} style={{ fontSize:11, padding:'6px 9px' }}>
                {isBedEdit ? <><Spinner size={10} /> Mở...</> : 'Sửa giường'}
              </Btn>
              <Btn variant="secondary" disabled={busyAny} onClick={() => onPreviewVTYT?.(card)} style={{ fontSize:11, padding:'6px 9px' }}>
                {isPreviewVtyt ? <><Spinner size={10} /> Quét...</> : 'Quét YL mai'}
              </Btn>
              {hasVtytPreview && (
                <Btn variant="secondary" disabled={busyAny || vtytProcessed} onClick={() => onProcessVTYT?.(card)} style={{ fontSize:11, padding:'6px 9px' }}>
                  {vtytProcessed ? 'Đã xử lý VTYT' : 'Xử lý VTYT'}
                </Btn>
              )}
              {vtytProcessed && (
                <Btn variant="secondary" disabled={busyAny} onClick={() => onInputVTYT?.(card)} style={{ fontSize:11, padding:'6px 9px' }}>
                  {isInputVtyt ? <><Spinner size={10} /> Nhập...</> : 'Nhập VTYT'}
                </Btn>
              )}
              {hasTicket && (
                <Btn variant="secondary" disabled={isFetching} onClick={() => onRescan(card)} style={{ fontSize:11, padding:'6px 9px' }}>Nghiệm thu</Btn>
              )}
              {card?.ticket?.ticketId && (
                <Btn variant="default" onClick={() => printHchanh_Ticket(card.ticket.ticketId).catch(err => alert(err.message || err))} style={{ fontSize:11, padding:'6px 9px' }}>In phiếu</Btn>
              )}
            </div>
          </div>
        )}
      </div>

      {/* QA summary */}
      {card?.qa && (
        <div style={{ margin:'8px 16px 0', padding:'8px 12px', borderRadius:6,
          background: card.qa.canPrint ? C.greenBg : C.amberBg,
          border:`1px solid ${card.qa.canPrint ? C.greenBorder : C.amberBorder}`,
          fontSize:12, color: card.qa.canPrint ? C.green : C.amber }}>
          {card.qa.canPrint ? '✓ Đủ điều kiện in/chốt hồ sơ' : card.qa.summary}
        </div>
      )}
      <IssueSummaryBox issues={issues} />

      {/* Section selector */}
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 16px', borderBottom:`1px solid ${C.border}`, marginTop:8, flexShrink:0 }}>
        <span style={{ fontSize:10, color:C.text2, textTransform:'uppercase', letterSpacing:.8, fontWeight:700 }}>Mục xem</span>
        <select value={tab} onChange={e => { setTabTouched(true); setTab(e.target.value); }}
                style={{ flex:1, minWidth:0, padding:'6px 9px', borderRadius:8, background:C.surface2,
                  border:`1px solid ${C.border}`, color:C.text, fontSize:12, fontWeight:700 }}>
          {TABS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </div>

      {/* Tab body */}
      <div style={{ flex:1, overflow:'auto', padding:'14px 18px' }}>


        {tab === 'fetch' && (
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
              <div style={{ fontSize:11, fontWeight:700, color:C.text2, textTransform:'uppercase', letterSpacing:1, flex:1 }}>Trạng thái dữ liệu</div>
              <Btn variant="default" onClick={() => setShowPartialFetch(v => !v)} style={{ fontSize:10, padding:'2px 8px' }}>
                {showPartialFetch ? 'Ẩn lấy từng phần' : 'Lấy từng phần'}
              </Btn>
            </div>
            {scopeFiles.map(fk => (
              <FetchBadge key={fk} fileKey={fk} fetched={fetched}
                onFetch={fk => onFetchFile(card, fk)} busy={fetchingFile === fk} showAction={showPartialFetch} />
            ))}
            <div style={{ marginTop:16, fontSize:11, fontWeight:700, color:C.text2, textTransform:'uppercase', letterSpacing:1, marginBottom:8 }}>Thông tin nền</div>
            <FieldRow label="Họ tên"       value={formatPersonName(profile.ho_ten || card?.ho_ten)} />
            <FieldRow label="Ngày sinh"    value={profile.ngay_sinh} />
            <FieldRow label="Tuổi"         value={profile.tuoi} />
            <FieldRow label="Địa chỉ"      value={profile.dia_chi} />
            <FieldRow label="Phòng/giường" value={profile.phong   || card?.phong} />
            <FieldRow label="Bác sĩ"       value={profile.bac_si} />
            <FieldRow label="Đối tượng"    value={profile.doi_tuong} />
            <FieldRow label="BHYT"         value={profile.bhyt_code} tone={profile.bhyt_code ? 'green' : 'amber'} />
            <FieldRow label="Loại BHYT"    value={profile.bhyt_loai} />
            <FieldRow label="Giá trị BHYT" value={[profile.bhyt_tu_ngay, profile.bhyt_den_ngay].filter(Boolean).join(' → ')} />
            <FieldRow label="Ngày vào viện" value={profile.ngay_vao_vien || profile.ngay_vao} />
            <FieldRow label="Ngày ra viện" value={profile.ngay_ra_vien || profile.ngay_ra} />
            <FieldRow label="Số ngày điều trị" value={profile.so_ngay_dieu_tri} />
            <FieldRow label="Chẩn đoán vào" value={profile.chan_doan_vao || profile.chan_doan} />
            <FieldRow label="Chẩn đoán ra" value={profile.chan_doan_ra} />
          </div>
        )}

        {tab === 'issues' && (
          <div>
            <div style={{ fontSize:11, fontWeight:700, color:C.text2, textTransform:'uppercase', letterSpacing:1, marginBottom:8 }}>Danh sách vấn đề</div>
            {issues.length === 0
              ? <div style={{ color:C.text2, fontSize:12 }}>Không có vấn đề nào.</div>
              : issues.map((i, idx) => <IssueRow key={i.code||idx} issue={i} />)
            }
          </div>
        )}

        {tab === 'discharge' && (
          <div>
            <div style={{ fontSize:11, fontWeight:700, color:C.text2, textTransform:'uppercase', letterSpacing:1, marginBottom:8 }}>Ra viện</div>
            {!hasDischargeData
              ? <div style={{ color:C.amber, fontSize:12 }}>Chưa lấy dữ liệu ra viện.</div>
              : <>
                  <SectionTitle>Xử trí ra khoa</SectionTitle>
                  <FieldRow label="Xử trí" value={disch.xu_tri} tone={disch.xu_tri ? 'green' : 'red'} />
                  <FieldRow label="Loại nội trú" value={disch.loai_noi_tru} />
                  <FieldRow label="Tình trạng ra viện" value={disch.tinh_trang_ra} tone={disch.tinh_trang_ra ? 'green' : 'amber'} />
                  <FieldRow label="Kết quả điều trị" value={disch.ket_qua} tone={disch.ket_qua ? 'green' : 'amber'} />
                  <FieldRow label="Lý do cho về" value={disch.ly_do_cho_ve} />
                  <FieldRow label="Bác sĩ điều trị" value={disch.bac_si} />
                  <FieldRow label="Thời gian ra" value={disch.raw_time || [disch.gio_ra, disch.ngay_ra].filter(Boolean).join(' ')} tone={(disch.raw_time || disch.ngay_ra) ? 'green' : 'red'} />
                  <FieldRow label="Số ngày tại khoa" value={disch.so_ngay_tai_khoa} />
                  <FieldRow label="Tổng số ngày ĐT" value={disch.tong_so_ngay_dt} />
                  <FieldRow label="Số lưu trữ" value={disch.so_luu_tru} />

                  <SectionTitle>Chẩn đoán</SectionTitle>
                  <LongField label="Chẩn đoán vào khoa" value={disch.chan_doan_vao || disch.chan_doan_vao_list} />
                  <LongField label="Chẩn đoán ra viện / ICD10 chính" value={disch.chan_doan_chinh || disch.chan_doan_ra} tone={(disch.chan_doan_chinh || disch.chan_doan_ra) ? 'green' : 'amber'} />
                  <LongField label="Bệnh kèm theo" value={disch.benh_kem} />
                  <FieldRow label="Biến chứng" value={disch.bien_chung} />
                  <FieldRow label="Tai biến" value={disch.tai_bien} />
                  <FieldRow label="Phân loại HSBA" value={disch.phan_loai_hsba} />
                  <FieldRow label="Có KQ trả sau" value={disch.co_kq_tra_sau} />

                  <SectionTitle>Nội dung điều trị</SectionTitle>
                  <LongField label="Lý do vào viện" value={disch.ly_do_vao_vien} />
                  <LongField label="Dấu hiệu lâm sàng" value={disch.dau_hieu_lam_sang} />
                  <LongField label="Kết quả XN/CLS" value={disch.can_lam_sang} />
                  <LongField label="PP/TT/KT/Thuốc đã dùng" value={disch.thuoc_da_su_dung} />
                  <LongField label="Phương pháp điều trị" value={disch.pp_dieu_tri} />
                  <LongField label="Tình trạng BN ra viện" value={disch.tinh_trang_bn_ra} />
                  <LongField label="Hướng điều trị/chế độ tiếp" value={disch.huong_dieu_tri} />
                  <LongField label="Lời dặn" value={disch.loi_dan} tone={disch.loi_dan ? 'green' : 'amber'} />

                  <SectionTitle>Hẹn tái khám</SectionTitle>
                  <FieldRow label="Trạng thái hẹn" value={disch.hen_tai_kham || disch.tai_kham} tone={disch.hen_tai_kham === 'Hẹn khám' ? 'green' : undefined} />
                  <FieldRow label="Thời gian hẹn" value={disch.tg_hen_kham || followup.thoi_gian} tone={(disch.tg_hen_kham || followup.thoi_gian) ? 'green' : (disch.hen_tai_kham === 'Hẹn khám' ? 'red' : undefined)} />
                  <FieldRow label="Phòng khám" value={disch.phong_kham || followup.phong_kham} tone={(disch.phong_kham || followup.phong_kham) ? 'green' : (disch.hen_tai_kham === 'Hẹn khám' ? 'red' : undefined)} />
                  {Object.keys(followup).length > 0 && (
                    <>
                      <FieldRow label="Người liên hệ" value={followup.nguoi_lien_he} />
                      <FieldRow label="Số điện thoại" value={followup.so_dien_thoai} />
                      <FieldRow label="Loại khám" value={followup.loai_kham} />
                      <FieldRow label="Chuyên khoa" value={followup.chuyen_khoa} />
                      <FieldRow label="Bác sĩ hẹn" value={followup.bac_si} />
                      <FieldRow label="Chuẩn bị" value={followup.chuan_bi} />
                      <FieldRow label="Ghi chú hẹn" value={followup.ghi_chu} />
                    </>
                  )}

                  <SectionTitle>Hồ sơ, phim ảnh</SectionTitle>
                  <FieldRow label="Phim ảnh" value={phimText} />
                  <FieldRow label="Toàn bộ hồ sơ" value={disch.toan_bo_ho_so} />
                  <FieldRow label="Người giao HS" value={disch.nguoi_giao_hs} />
                  <FieldRow label="Người nhận HS" value={disch.nguoi_nhan_hs} />
                  <LongField label="Ghi chú" value={disch.ghi_chu} />

                  {(nonEmpty(disch.ngay_bd_nghi_ngt) || nonEmpty(disch.ngay_kt_nghi_ngt) || Number(disch.so_ngay_nghi_ngt || 0) > 0) && (
                    <>
                      <SectionTitle>Nghỉ ngoại trú sau điều trị</SectionTitle>
                      <FieldRow label="Ngày bắt đầu" value={disch.ngay_bd_nghi_ngt} />
                      <FieldRow label="Ngày kết thúc" value={disch.ngay_kt_nghi_ngt} />
                      <FieldRow label="Số ngày" value={disch.so_ngay_nghi_ngt} />
                    </>
                  )}
                </>
            }
          </div>
        )}

        {tab === 'billing' && (
          <div>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginBottom:8 }}>
              <div style={{ fontSize:11, fontWeight:700, color:C.text2, textTransform:'uppercase', letterSpacing:1 }}>Bảng kê thanh toán</div>
              {hasBillingData && <Chip tone="gray">{safeArr(billing.rows).length} dòng</Chip>}
            </div>
            {!hasBillingData
              ? <div style={{ color:C.amber, fontSize:12 }}>Chưa lấy bảng kê.</div>
              : <>
                  {(() => {
                    const overview = billingOverview || buildClientBillingOverview(billing, issues) || {};
                    const summary = overview.summary || {};
                    const patientPay = money(summary.patient ?? billing.tong_tu_tuc);
                    const totalPay = money(summary.total ?? billing.tong_cong);
                    const bhytPay = money(summary.bhyt ?? billing.tong_bhyt);
                    const advanceKnown = Boolean(summary.advance_known ?? summary.advanceKnown ?? hasOwnValue(billing, ['tam_ung', 'tien_tam_ung', 'advance']));
                    const advance = advanceKnown ? money(summary.advance ?? billing.tam_ung ?? billing.tien_tam_ung ?? billing.advance) : null;
                    const remaining = advanceKnown ? Math.max(0, patientPay - money(advance)) : Math.max(0, patientPay);
                    const remainingLabel = advanceKnown ? 'Còn phải thu' : 'Còn phải thu tạm tính';
                    const quickCards = [
                      { label:remainingLabel, value:remaining, tone:remaining ? 'amber' : 'green', note: advanceKnown ? 'Đã trừ tạm ứng' : 'Chưa có dữ liệu tạm ứng' },
                      { label:'NB cần đóng', value:patientPay, tone:patientPay ? 'amber' : 'green', note:'Khoản tự trả / viện phí' },
                      { label:'BHYT thanh toán', value:bhytPay, tone:'green', note:`${pctText(bhytPay, totalPay)} tổng chi phí` },
                      { label:'Tổng chi phí', value:totalPay, tone:'blue', note:`${safeArr(billing.rows).length} dòng chi phí` },
                      { label:'Tạm ứng', value:advance || 0, display:advanceKnown ? moneyText(advance) : 'Chưa có dữ liệu', tone:'gray', note:advanceKnown ? 'Đã ghi nhận từ bảng kê' : 'Không hiện 0đ khi chưa chắc chắn' },
                    ];
                    const viewTabs = [
                      ['overview','Tổng quan'], ['sources','Nguồn chi trả'], ['groups','Nhóm chi phí'], ['attention',`Cần kiểm tra${safeArr(overview.attention).length ? ` (${safeArr(overview.attention).length})` : ''}`], ['details','Chi tiết']
                    ];
                    return (
                      <>
                        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(160px, 1fr))', gap:8, marginBottom:10 }}>
                          {quickCards.map(card => {
                            const s = tS(card.tone);
                            return (
                              <div key={card.label} style={{ padding:'9px 11px', borderRadius: 6, background:s.bg, border:`1px solid ${s.border}` }}>
                                <div style={{ fontSize:10, color:C.text2, marginBottom:2 }}>{card.label}</div>
                                <div style={{ fontSize:18, fontWeight: 850, color:s.fg, lineHeight:1.15 }}>{card.display || moneyText(card.value)}</div>
                                <div style={{ fontSize:10, color:C.text2, marginTop:3 }}>{card.note}</div>
                              </div>
                            );
                          })}
                        </div>

                        <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:10 }}>
                          {viewTabs.map(([id, label]) => (
                            <button key={id} type="button" onClick={() => setBillingView(id)}
                              style={{ border:`1px solid ${billingView === id ? C.blueBorder : C.border}`, background:billingView === id ? C.blueBg : C.surface2,
                                color:billingView === id ? C.blue : C.text2, borderRadius:999, padding:'4px 9px', fontSize:11, fontWeight:700, cursor:'pointer' }}>
                              {label}
                            </button>
                          ))}
                        </div>

                        {billingView === 'overview' && (
                          <div>
                            <SectionTitle>Tổng hợp theo bảng kê in giấy</SectionTitle>
                            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(170px, 1fr))', gap:7, marginBottom:10 }}>
                              {safeArr(overview.sources).map(src => (
                                <div key={src.key} style={{ padding:'8px 10px', borderRadius:8, border:`1px solid ${C.border2}`, background:C.surface2 }}>
                                  <div style={{ display:'flex', justifyContent:'space-between', gap:6, alignItems:'center' }}>
                                    <b style={{ fontSize:12, color:C.text }}>{src.label}</b>
                                    <Chip tone={src.key === 'insurance' ? 'green' : src.key === 'self_pay' ? 'amber' : src.key === 'package' ? 'blue' : 'gray'}>{src.lines} dòng</Chip>
                                  </div>
                                  <div style={{ marginTop:5, fontSize:16, fontWeight: 850, color:C.text }}>{moneyText(src.total)}</div>
                                  <div style={{ marginTop:3, fontSize:10, color:C.text2 }}>
                                    BHYT {moneyText(src.bhyt)} · NB trả {moneyText(src.patient || src.self_pay)}{src.package ? ` · Trong gói ${moneyText(src.package)}` : ''}
                                  </div>
                                </div>
                              ))}
                            </div>

                            <SectionTitle>Khoản người bệnh trả cao nhất</SectionTitle>
                            {safeArr(overview.top_patient_pay).length === 0
                              ? <div style={{ color:C.text2, fontSize:12 }}>Không có khoản tự trả lớn trong dữ liệu hiện tại.</div>
                              : safeArr(overview.top_patient_pay).slice(0,5).map((row, i) => (
                                <div key={`${row.name}-${i}`} style={{ display:'grid', gridTemplateColumns:'1fr auto', gap:8, alignItems:'center', padding:'6px 0', borderBottom:`1px solid ${C.border2}`, fontSize:12 }}>
                                  <div style={{ minWidth:0 }}>
                                    <div style={{ color:C.text, fontWeight:700, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{row.name}</div>
                                    <div style={{ color:C.text2, fontSize:10 }}>{row.group} · {row.source}</div>
                                  </div>
                                  <div style={{ color:C.amber, fontWeight: 850 }}>{moneyText(row.patient)}</div>
                                </div>
                              ))}
                          </div>
                        )}

                        {billingView === 'sources' && (
                          <div>
                            <SectionTitle>Theo nguồn chi trả</SectionTitle>
                            <div style={{ overflow:'auto', border:`1px solid ${C.border2}`, borderRadius:8 }}>
                              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                                <thead><tr style={{ background:C.surface2 }}>{['Nguồn','Số dòng','Tổng','BHYT','Người bệnh','Trong gói'].map(h => <th key={h} style={{ textAlign:h==='Nguồn'?'left':'right', padding:'6px 8px', borderBottom:`1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
                                <tbody>{safeArr(overview.sources).map(src => <tr key={src.key}>
                                  <td style={{ padding:'6px 8px', borderBottom:`1px solid ${C.border2}`, fontWeight:700 }}>{src.label}</td>
                                  <td style={{ padding:'6px 8px', borderBottom:`1px solid ${C.border2}`, textAlign:'right' }}>{src.lines}</td>
                                  <td style={{ padding:'6px 8px', borderBottom:`1px solid ${C.border2}`, textAlign:'right', fontWeight:800 }}>{moneyText(src.total)}</td>
                                  <td style={{ padding:'6px 8px', borderBottom:`1px solid ${C.border2}`, textAlign:'right', color:C.green }}>{moneyText(src.bhyt)}</td>
                                  <td style={{ padding:'6px 8px', borderBottom:`1px solid ${C.border2}`, textAlign:'right', color:C.amber }}>{moneyText(src.patient || src.self_pay)}</td>
                                  <td style={{ padding:'6px 8px', borderBottom:`1px solid ${C.border2}`, textAlign:'right', color:C.blue }}>{moneyText(src.package)}</td>
                                </tr>)}</tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {billingView === 'groups' && (
                          <div>
                            <SectionTitle>Theo nhóm chi phí</SectionTitle>
                            <div style={{ maxHeight:330, overflow:'auto', border:`1px solid ${C.border2}`, borderRadius:8 }}>
                              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                                <thead style={{ position:'sticky', top:0 }}><tr style={{ background:C.surface2 }}>{['Nhóm','Tỷ trọng','Dòng','Tổng','BHYT','NB trả'].map(h => <th key={h} style={{ textAlign:h==='Nhóm'?'left':'right', padding:'6px 8px', borderBottom:`1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
                                <tbody>{safeArr(overview.groups).map(g => {
                                  const pct = totalPay ? Math.min(100, Math.round((money(g.total) / totalPay) * 100)) : 0;
                                  return <tr key={g.key}>
                                    <td style={{ padding:'6px 8px', borderBottom:`1px solid ${C.border2}`, fontWeight:700 }}>{g.label}</td>
                                    <td style={{ padding:'6px 8px', borderBottom:`1px solid ${C.border2}`, textAlign:'right', minWidth:92 }}>
                                      <div style={{ display:'flex', alignItems:'center', gap:6, justifyContent:'flex-end' }}>
                                        <div style={{ width:48, height:5, borderRadius:999, background:C.surface2, border:`1px solid ${C.border2}`, overflow:'hidden' }}>
                                          <div style={{ width:`${pct}%`, height:'100%', background:C.blue }} />
                                        </div>
                                        <span style={{ color:C.text2, fontSize:10, minWidth:30 }}>{pct}%</span>
                                      </div>
                                    </td>
                                    <td style={{ padding:'6px 8px', borderBottom:`1px solid ${C.border2}`, textAlign:'right' }}>{g.lines}</td>
                                    <td style={{ padding:'6px 8px', borderBottom:`1px solid ${C.border2}`, textAlign:'right', fontWeight:800 }}>{moneyText(g.total)}</td>
                                    <td style={{ padding:'6px 8px', borderBottom:`1px solid ${C.border2}`, textAlign:'right', color:C.green }}>{moneyText(g.bhyt)}</td>
                                    <td style={{ padding:'6px 8px', borderBottom:`1px solid ${C.border2}`, textAlign:'right', color:C.amber }}>{moneyText(g.patient || g.self_pay)}</td>
                                  </tr>;
                                })}</tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {billingView === 'attention' && (
                          <div>
                            <SectionTitle>Cần kiểm tra trước khi cho đi đóng tiền</SectionTitle>
                            {safeArr(overview.attention).length === 0
                              ? <div style={{ padding:'10px 12px', borderRadius:8, background:C.greenBg, border:`1px solid ${C.greenBorder}`, color:C.green, fontSize:12 }}>Chưa phát hiện vấn đề liên quan bảng kê.</div>
                              : safeArr(overview.attention).map((a, i) => (
                                <div key={i} style={{ padding:'8px 10px', borderRadius:8, background:a.severity === 'error' ? C.redBg : C.amberBg, border:`1px solid ${a.severity === 'error' ? C.redBorder : C.amberBorder}`, marginBottom:7 }}>
                                  <div style={{ display:'flex', gap:7, alignItems:'center', flexWrap:'wrap' }}>
                                    <Chip tone={a.severity === 'error' ? 'red' : 'amber'}>{a.severity === 'error' ? 'Lỗi' : 'Cảnh báo'}</Chip>
                                    <b style={{ fontSize:12, color:a.severity === 'error' ? C.red : C.amber }}>{a.title}</b>
                                  </div>
                                  {a.detail && <div style={{ fontSize:11, color:C.text, marginTop:4, lineHeight:1.4 }}>{a.detail}</div>}
                                  {a.owner && <div style={{ fontSize:10, color:C.text2, marginTop:3 }}>Phụ trách: {a.owner}</div>}
                                </div>
                              ))}
                          </div>
                        )}

                        {billingView === 'details' && (
                          <div>
                            <SectionTitle>Chi tiết bảng kê</SectionTitle>
                            <div style={{ maxHeight:340, overflow:'auto', border:`1px solid ${C.border2}`, borderRadius:8 }}>
                              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                                <thead style={{ position:'sticky', top:0 }}><tr style={{ background:C.surface2 }}>
                                  {['Khoản mục','Nhóm','Nguồn','SL','Thành tiền'].map(h => <th key={h} style={{ textAlign:h==='Khoản mục'?'left':'right', padding:'6px 8px', borderBottom:`1px solid ${C.border}` }}>{h}</th>)}
                                </tr></thead>
                                <tbody>{safeArr(billing.rows).map((row, i) => {
                                  const t = row.payment_group === 'bhyt' ? 'green' : row.payment_group === 'self_pay' ? 'amber' : sourceKey(row.doi_tuong) === 'package' ? 'blue' : 'gray';
                                  return <tr key={i}>
                                    <td style={{ padding:'6px 8px', borderBottom:`1px solid ${C.border2}`, minWidth:220 }}><div style={{ color:C.text, fontWeight:600 }}>{txt(row.name)}</div><div style={{ color:C.text2, fontSize:10 }}>{txt(row.khoa,'')}</div></td>
                                    <td style={{ padding:'6px 8px', borderBottom:`1px solid ${C.border2}`, textAlign:'right', color:C.text2 }}>{cleanBillingGroup(row.loai_yc)}</td>
                                    <td style={{ padding:'6px 8px', borderBottom:`1px solid ${C.border2}`, textAlign:'right' }}><Chip tone={t} style={{ fontSize:9 }}>{txt(row.doi_tuong || row.payment_group)}</Chip></td>
                                    <td style={{ padding:'6px 8px', borderBottom:`1px solid ${C.border2}`, textAlign:'right', color:C.text2 }}>{row.sl ?? ''}</td>
                                    <td style={{ padding:'6px 8px', borderBottom:`1px solid ${C.border2}`, textAlign:'right', fontWeight:800 }}>{moneyText(row.thanh_tien)}</td>
                                  </tr>;
                                })}</tbody>
                              </table>
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </>
            }
          </div>
        )}

        {tab === 'bed_days' && (
          <div>
            <div style={{ fontSize:11, fontWeight:700, color:C.text2, textTransform:'uppercase', letterSpacing:1, marginBottom:8 }}>Thống kê tất cả lượt kê giường</div>
            {!hasBedDaysData
              ? <div style={{ color:C.amber, fontSize:12 }}>Chưa lấy dữ liệu ngày giường.</div>
              : <>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:8, marginBottom:12 }}>
                    {[
                      ['Lượt kê giường', bed.tong_luot_ke_giuong ?? safeArr(bed.rows).length, 'blue', 'lượt'],
                      ['Giường khác nhau', bed.tong_giuong_khac_nhau ?? safeArr(bed.bed_summary).length, 'green', 'giường'],
                      ['Tổng ngày kê', bed.so_ngay_tinh, 'amber', 'ngày'],
                    ].map(([label, value, tone, unit]) => {
                      const s = tS(tone);
                      return (
                        <div key={label} style={{ padding:'8px 10px', borderRadius:6, background:s.bg, border:`1px solid ${s.border}` }}>
                          <div style={{ fontSize:10, color:C.text2 }}>{label}</div>
                          <div style={{ fontSize:20, fontWeight:700, color:s.fg }}>{value ?? 0}</div>
                          <div style={{ fontSize:10, color:C.text2 }}>{unit}</div>
                        </div>
                      );
                    })}
                  </div>

                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:12 }}>
                    {[
                      ['Tổng ngày kê giường', bed.so_ngay_tinh, 'blue'],
                      ['Thời gian điều trị', bed.so_ngay_thuc, 'green'],
                    ].map(([label, value, tone]) => {
                      const s   = tS(tone);
                      const bad = bed.so_ngay_tinh > 0 && bed.so_ngay_thuc > 0 && bed.so_ngay_tinh !== bed.so_ngay_thuc;
                      return (
                        <div key={label} style={{ padding:'8px 12px', borderRadius:6, background:s.bg,
                          border:`1px solid ${bad ? C.redBorder : s.border}` }}>
                          <div style={{ fontSize:10, color:C.text2 }}>{label}</div>
                          <div style={{ fontSize:22, fontWeight:700, color:s.fg }}>{value ?? '?'}</div>
                          <div style={{ fontSize:10, color:C.text2 }}>ngày</div>
                        </div>
                      );
                    })}
                  </div>

                  {bedReview && bedReview.status !== 'unknown' && (
                    <div style={{ marginBottom:12, padding:'10px 12px', borderRadius:8,
                      background: bedReview.status === 'ok' ? C.greenBg : C.redBg,
                      border:`1px solid ${bedReview.status === 'ok' ? C.greenBorder : C.redBorder}` }}>
                      <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap', marginBottom:6 }}>
                        <Chip tone={bedReview.status === 'ok' ? 'green' : 'red'}>{bedReview.status === 'ok' ? 'Đúng quy tắc' : 'Cần chỉnh ngày giường'}</Chip>
                        <span style={{ fontSize:12, fontWeight:700, color:bedReview.status === 'ok' ? C.green : C.red }}>
                          Dự kiến {bedReview.expected_total ?? '?'} ngày · Hiện {bedReview.actual_total ?? '?'} ngày
                        </span>
                      </div>
                      {bedReview.surgery && (
                        <div style={{ fontSize:11, color:C.text2, marginBottom:6 }}>
                          PT {txt(bedReview.surgery.class_name)} · mốc hậu phẫu {txt(bedReview.surgery.postop_start_datetime || bedReview.surgery.postop_start)} · hết 10 ngày {txt(bedReview.surgery.postop_end_datetime)} · giường sau PT: {txt(bedReview.surgery.surgical_bed)}
                        </div>
                      )}
                      {safeArr(bedReview.exact_intervals).length > 0 && (
                        <div style={{ marginTop:8 }}>
                          <div style={{ fontSize:10, fontWeight:800, color:C.text2, textTransform:'uppercase', letterSpacing:.7, marginBottom:5 }}>
                            Mốc chuẩn theo giờ phút
                          </div>
                          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:6 }}>
                            {safeArr(bedReview.exact_intervals).map((p, i) => (
                              <div key={`exact-${i}`} style={{ padding:'6px 8px', borderRadius:6, background:C.surface, border:`1px solid ${C.border2}`, fontSize:11 }}>
                                <div style={{ fontWeight:700, color:C.text }}>{txt(p.label)}</div>
                                <div style={{ color:C.text2 }}>{txt(p.range_datetime)}</div>
                                {p.reason && <div style={{ color:C.text2, marginTop:2 }}>{txt(p.reason)}</div>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {safeArr(bedReview.mismatch_intervals).length > 0 && (
                        <div style={{ marginTop:8, padding:'8px 10px', borderRadius:7, background:C.redBg, border:`1px solid ${C.redBorder}` }}>
                          <div style={{ fontSize:10, fontWeight:800, color:C.red, textTransform:'uppercase', letterSpacing:.7, marginBottom:5 }}>
                            Khoảng giờ đang lệch
                          </div>
                          {safeArr(bedReview.mismatch_intervals).slice(0, 6).map((m, i) => (
                            <div key={`mismatch-${i}`} style={{ fontSize:11, color:C.text, lineHeight:1.4, padding:'2px 0' }}>
                              <b>{txt(m.range_datetime)}</b>: đang {txt(m.actual)} → nên {txt(m.expected)}
                            </div>
                          ))}
                          {safeArr(bedReview.mismatch_intervals).length > 6 && (
                            <div style={{ fontSize:11, color:C.text2, marginTop:3 }}>+{safeArr(bedReview.mismatch_intervals).length - 6} khoảng khác</div>
                          )}
                        </div>
                      )}
                      {safeArr(bedReview.periods).length > 0 && (
                        <div style={{ marginTop:8 }}>
                          <div style={{ fontSize:10, fontWeight:800, color:C.text2, textTransform:'uppercase', letterSpacing:.7, marginBottom:5 }}>
                            Gợi ý tính tiền theo ngày
                          </div>
                          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(190px, 1fr))', gap:6 }}>
                            {safeArr(bedReview.periods).map((p, i) => (
                              <div key={i} style={{ padding:'6px 8px', borderRadius:6, background:C.surface, border:`1px solid ${C.border2}`, fontSize:11 }}>
                                <div style={{ fontWeight:700, color:C.text }}>{txt(p.label)}</div>
                                <div style={{ color:C.text2 }}>{txt(p.range)} · {p.days} ngày</div>
                                {p.range_datetime && <div style={{ color:C.text2, marginTop:2 }}>Mốc: {txt(p.range_datetime)}</div>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {safeArr(bedReview.suggestions).length > 0 && (
                        <div style={{ marginTop:7, fontSize:11, color:C.text, lineHeight:1.4 }}>
                          {safeArr(bedReview.suggestions).map((x, i) => <div key={i}>• {x}</div>)}
                        </div>
                      )}
                    </div>
                  )}

                  {bedWarnings.map((w, i) => (
                    <div key={i} style={{ padding:'6px 10px', borderRadius:6, background:C.redBg,
                      border:`1px solid ${C.redBorder}`, fontSize:12, color:C.red, marginBottom:6 }}>⚠ {w}</div>
                  ))}

                  <SectionTitle>Tổng hợp theo từng giường</SectionTitle>
                  {safeArr(bed.bed_summary).length === 0
                    ? <div style={{ color:C.text2, fontSize:12 }}>Không có dòng giường hợp lệ.</div>
                    : safeArr(bed.bed_summary).map((g, i) => {
                        const ref = findBedServiceRef([g.dich_vu_giuong, g.mo_ta, g.ten_giuong].filter(Boolean).join(' '));
                        return (
                          <div key={`${g.ten_giuong || 'giuong'}-${i}`} style={{ padding:'7px 0', borderBottom:`1px solid ${C.border2}`, fontSize:12 }}>
                            <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap' }}>
                              <Chip tone="blue" style={{ fontSize:9 }}>{g.so_ngay || 0} ngày</Chip>
                              <Chip tone="gray" style={{ fontSize:9 }}>{g.so_dot || 0} lượt</Chip>
                              {ref?.code && <Chip tone="green" style={{ fontSize:9 }}>{ref.code}</Chip>}
                              <span style={{ color:C.text, fontWeight:700 }}>{txt(g.ten_giuong)}</span>
                            </div>
                            {nonEmpty(g.phong) && <div style={{ color:C.text2, marginTop:2 }}>{txt(g.phong)}</div>}
                            {nonEmpty(g.dich_vu_giuong) && <div style={{ color:C.text2, marginTop:2 }}>{txt(g.dich_vu_giuong)}</div>}
                            {ref && <div style={{ color:C.text2, marginTop:2 }}>Giá BH {txt(ref.gia_bh)} · Giá DV {txt(ref.gia_dv)} · Chênh {txt(ref.chenh_lech)}</div>}
                            {(nonEmpty(g.tu_dau) || nonEmpty(g.den_cuoi)) && (
                              <div style={{ color:C.text2, marginTop:2 }}>Từ {txt(g.tu_dau)} → {txt(g.den_cuoi)}</div>
                            )}
                          </div>
                        );
                      })
                  }

                  <SectionTitle>Chi tiết từng lượt kê</SectionTitle>
                  {safeArr(bed.rows).length === 0
                    ? <div style={{ color:C.text2, fontSize:12 }}>Không có chi tiết lượt kê giường.</div>
                    : safeArr(bed.rows).map((r, i) => {
                        const isCancel = String(r.trang_thai || '').toLowerCase().includes('hủy') || String(r.trang_thai || '').toLowerCase().includes('huy');
                        const isActive = String(r.trang_thai || '').toLowerCase().includes('đang') || String(r.trang_thai || '').toLowerCase().includes('dang');
                        const ref = findBedServiceRef([r.dich_vu_giuong, r.mo_ta, r.ten_giuong, r.giuong].filter(Boolean).join(' '));
                        return (
                          <div key={i} style={{ padding:'7px 0', borderBottom:`1px solid ${C.border2}`, fontSize:12 }}>
                            <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap' }}>
                              <Chip tone={isCancel ? 'red' : isActive ? 'green' : 'gray'} style={{ fontSize:9 }}>{txt(r.trang_thai)}</Chip>
                              <Chip tone="blue" style={{ fontSize:9 }}>{r.so_ngay || 0} ngày</Chip>
                              {ref?.code && <Chip tone="green" style={{ fontSize:9 }}>{ref.code}</Chip>}
                              <span style={{ color:C.text, fontWeight:700 }}>{txt(r.ten_giuong || r.giuong || r.ten_giuong_raw)}</span>
                            </div>
                            {nonEmpty(r.phong) && <div style={{ color:C.text2, marginTop:2 }}>{txt(r.phong)}</div>}
                            {nonEmpty(r.dich_vu_giuong) && <div style={{ color:C.text2, marginTop:2 }}>{txt(r.dich_vu_giuong)}</div>}
                            {ref && <div style={{ color:C.text2, marginTop:2 }}>DS giường: Giá BH {txt(ref.gia_bh)} · Giá DV {txt(ref.gia_dv)} · Chênh {txt(ref.chenh_lech)}</div>}
                            <div style={{ color:C.text2, marginTop:2 }}>Từ {txt(r.tu)} → {txt(r.den)}</div>
                            {(nonEmpty(r.nguoi_chi_dinh) || nonEmpty(r.loai)) && (
                              <div style={{ color:C.text2, marginTop:2 }}>
                                {nonEmpty(r.nguoi_chi_dinh) ? `Người chỉ định: ${txt(r.nguoi_chi_dinh)}` : ''}
                                {nonEmpty(r.loai) ? ` · Loại: ${txt(r.loai)}` : ''}
                              </div>
                            )}
                          </div>
                        );
                      })
                  }
                </>
            }
          </div>
        )}


        {tab === 'surgery' && (
          <div>
            <div style={{ fontSize:11, fontWeight:700, color:C.text2, textTransform:'uppercase', letterSpacing:1, marginBottom:8 }}>
              Phân loại phẫu thuật ({safeArr(surgery.surgeries).length})
            </div>
            {!hasSurgeryData
              ? <div style={{ color:C.amber, fontSize:12 }}>Chưa lấy dữ liệu phẫu thuật. Bấm “Lấy” ở dòng Phân loại phẫu thuật hoặc cập nhật lại dữ liệu.</div>
              : safeArr(surgery.surgeries).length === 0
                ? <div style={{ color:C.text2, fontSize:12 }}>Không thấy phẫu thuật trong khoảng thời gian đã chọn.</div>
                : safeArr(surgery.surgeries).map((pt, i) => {
                    const d = pt.detail || {};
                    return (
                      <div key={pt.phauthuatid || i} style={{ padding:'8px 0', borderBottom:`1px solid ${C.border2}`, fontSize:12 }}>
                        <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap', marginBottom:4 }}>
                          {pt.phan_loai_pt && <Chip tone="amber" style={{ fontSize:9 }}>{txt(pt.phan_loai_pt)}</Chip>}
                          {pt.trang_thai && <Chip tone={String(pt.trang_thai).toLowerCase().includes('hoàn') ? 'green' : 'gray'} style={{ fontSize:9 }}>{txt(pt.trang_thai)}</Chip>}
                          {pt.tinh_trang && <Chip tone="blue" style={{ fontSize:9 }}>{txt(pt.tinh_trang)}</Chip>}
                          <span style={{ color:C.text, fontWeight:700 }}>{txt(pt.noi_dung_phau_thuat || d.dich_vu_phau_thuat)}</span>
                        </div>
                        <FieldRow label="Thời gian danh sách" value={pt.thoi_gian} />
                        <FieldRow label="Bắt đầu PT" value={d.bat_dau || pt.bat_dau} />
                        <FieldRow label="Kết thúc PT" value={d.ket_thuc || pt.ket_thuc} />
                        <FieldRow label="Nhận khoa sau PT" value={d.nhan_khoa_sau_pt || pt.nhan_khoa_sau_pt} tone="blue" />
                        <FieldRow label="Khoa sau PT" value={d.khoa_sau_pt || pt.khoa_sau_pt} />
                        <FieldRow label="Phân loại PT" value={d.phan_loai_pt || pt.phan_loai_pt} tone="amber" />
                        <FieldRow label="Dịch vụ PT" value={d.dich_vu_phau_thuat || pt.dich_vu_phau_thuat || pt.noi_dung_phau_thuat} />
                        <FieldRow label="Phương pháp PT" value={d.phuong_phap_pt || pt.phuong_phap_pt} />
                        <FieldRow label="Phương pháp vô cảm" value={d.pp_vo_cam || pt.pp_vo_cam} />
                        <FieldRow label="ICD 9" value={d.icd9 || pt.icd9} />
                        <FieldRow label="BS mổ chính" value={d.bs_mo_chinh || pt.bs_mo_chinh} />
                        <FieldRow label="Gây mê chính" value={d.gay_me_chinh} />
                        {(nonEmpty(d.chan_doan_truoc_pt) || nonEmpty(d.chan_doan_sau_pt)) && (
                          <>
                            <FieldRow label="CĐ trước PT" value={d.chan_doan_truoc_pt || d.icd10_truoc_pt} />
                            <FieldRow label="CĐ sau PT" value={d.chan_doan_sau_pt || d.icd10_sau_pt} />
                          </>
                        )}
                      </div>
                    );
                  })
            }
            {safeArr(surgery.ward_admissions).length > 0 && (
              <div style={{ marginTop:10, paddingTop:8, borderTop:`1px dashed ${C.border2}` }}>
                <div style={{ fontSize:10, fontWeight:700, color:C.text2, textTransform:'uppercase', letterSpacing:.8, marginBottom:6 }}>
                  Mốc vào khoa từ lịch sử y lệnh
                </div>
                {safeArr(surgery.ward_admissions).map((w, i) => (
                  <div key={w.noitruid || i} style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center', fontSize:11, color:C.text2, padding:'2px 0' }}>
                    {w.thu_tu && <Chip tone="gray" style={{ fontSize:9 }}>Khoa {w.thu_tu}</Chip>}
                    {w.ngay_vao && <Chip tone="blue" style={{ fontSize:9 }}>{txt(w.ngay_vao)}</Chip>}
                    <span>{txt(w.ten_khoa)}</span>
                    {w.trang_thai && <span>· {txt(w.trang_thai)}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}


        {tab === 'order_history' && (
          <div>
            <div style={{ fontSize:11, fontWeight:700, color:C.text2, textTransform:'uppercase', letterSpacing:1, marginBottom:8 }}>Lịch sử y lệnh</div>
            {!hasOrderHistoryData
              ? <div style={{ color:C.amber, fontSize:12 }}>Chưa lấy lịch sử y lệnh.</div>
              : <>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:6, marginBottom:12 }}>
                    {[
                      ['Tổng', orderHistory.total, 'blue'],
                      ['Hoàn tất', orderHistory.completed, 'green'],
                      ['Chưa HT', orderHistory.incomplete, Number(orderHistory.incomplete||0) ? 'red' : 'gray'],
                      ['Sau ra viện', orderHistory.after_discharge, Number(orderHistory.after_discharge||0) ? 'red' : 'gray'],
                    ].map(([label, value, tone]) => {
                      const st = tS(tone);
                      return <div key={label} style={{ padding:'6px 8px', borderRadius:6, background:st.bg, border:`1px solid ${st.border}` }}>
                        <div style={{ fontSize:10, color:C.text2 }}>{label}</div>
                        <div style={{ fontSize:18, fontWeight:700, color:st.fg }}>{value ?? 0}</div>
                      </div>;
                    })}
                  </div>
                  {safeArr(orderHistory.incomplete_rows).length > 0 && (
                    <>
                      <SectionTitle>Y lệnh chưa hoàn tất</SectionTitle>
                      {safeArr(orderHistory.incomplete_rows).map((r, i) => (
                        <div key={i} style={{ padding:'7px 0', borderBottom:`1px solid ${C.border2}`, fontSize:12 }}>
                          <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
                            <Chip tone={r.after_discharge ? 'red' : 'amber'} style={{ fontSize:9 }}>{txt(r.tg_ylenh || r.ngay)}</Chip>
                            <Chip tone="gray" style={{ fontSize:9 }}>Phiếu {txt(r.so_phieu)}</Chip>
                            <span style={{ color:C.text, fontWeight:700 }}>{txt(r.ten_y_lenh || r.dien_bien)}</span>
                          </div>
                          <div style={{ color:C.red, marginTop:3, fontWeight:600 }}>
                            Chưa hoàn tất: {txt(r.incomplete_detail || safeArr(r.incomplete_services).join(' · ') || r.kq_text)}
                          </div>
                          <div style={{ color:C.text2, marginTop:2 }}>
                            BS: {txt(r.bac_si)}{r.khoa ? ` · Khoa: ${txt(r.khoa)}` : ''}
                          </div>
                          {nonEmpty(r.y_lenh_khac) && (
                            <div style={{ color:C.text2, marginTop:2 }}>Y lệnh: {txt(r.y_lenh_khac)}</div>
                          )}
                        </div>
                      ))}
                    </>
                  )}
                  <SectionTitle>Chi tiết gần nhất</SectionTitle>
                  {safeArr(orderHistory.rows).slice(0, 30).map((r, i) => (
                    <div key={i} style={{ padding:'5px 0', borderBottom:`1px solid ${C.border2}`, fontSize:11 }}>
                      <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
                        <Chip tone={r.status === 'completed' ? 'green' : r.status === 'incomplete' ? 'red' : 'gray'} style={{ fontSize:9 }}>{txt(r.tg_ylenh)}</Chip>
                        <span style={{ color:C.text, fontWeight:600 }}>{txt(r.ten_y_lenh || r.dien_bien || r.kq_text)}</span>
                      </div>
                      <div style={{ color:C.text2, marginTop:2 }}>Phiếu {txt(r.so_phieu)} · {txt(r.bac_si)} · {txt(r.incomplete_detail || r.kq_text)}</div>
                    </div>
                  ))}
                </>
            }
          </div>
        )}


        {tab === 'vtyt' && (
          <VTYTPreviewPanel
            preview={vtytPreview}
            onPreview={() => onPreviewVTYT?.(card)}
            onProcess={() => onProcessVTYT?.(card)}
            onInput={() => onInputVTYT?.(card)}
            canRun={!busyAny}
            previewing={isPreviewVtyt}
            inputting={isInputVtyt}
          />
        )}

      </div>
    </aside>
  );
}

// ── Count bar ─────────────────────────────────────────────────────────────────

function CountBar({ counts, dashboard }) {
  const ready = Number(counts.quality_ready ?? counts.data_complete ?? 0);
  const needReview = Number(counts.needs_review ?? 0);
  const notStarted = Number(counts.not_started ?? counts.data_not_started ?? 0);
  const machineError = Number(counts.machine_error ?? counts.fetch_error ?? 0);
  const fetchedCount = Math.max(0, Number(counts.total || 0) - Number(notStarted || 0));
  const items = [
    { label:'Tổng BN',       value:counts.total,      tone:'gray'  },
    { label:'Đã lấy hồ sơ',  value:fetchedCount,      tone:fetchedCount ? 'blue' : 'gray' },
    { label:'Chưa lấy',      value:notStarted,        tone:notStarted ? 'gray' : 'green' },
    { label:'Cần xử lý',     value:needReview,        tone:needReview ? 'amber' : 'green' },
    { label:'Lỗi máy',       value:machineError,      tone:machineError ? 'red' : 'gray' },
    { label:'Đủ hoàn tất',   value:ready,             tone:'green' },
  ];
  const syncInfo = dashboard?.syncInfo || dashboard?.lastSync || {};
  const syncAt = syncInfo.at || dashboard?.generatedAt;
  return (
    <div style={{ display:'flex', gap:10, padding:'9px 16px', alignItems:'center', flexWrap:'wrap', borderBottom:`1px solid ${C.border}`, background:C.bg }}>
      {items.map(({ label, value, tone }) => {
        const s = tS(tone);
        return (
          <div key={label} style={{ padding:'5px 10px', borderRadius:9, minWidth:74, textAlign:'center',
            background:s.bg, border:`1px solid ${s.border}` }}>
            <div style={{ fontSize:18, fontWeight:800, color:s.fg, lineHeight:1.1 }}>{value ?? 0}</div>
            <div style={{ fontSize:9, color:C.text2, marginTop:1 }}>{label}</div>
          </div>
        );
      })}
      <div style={{ marginLeft:'auto', color:C.text2, fontSize:11, lineHeight:1.45, minWidth:260, textAlign:'right' }}>
        Nguồn: phiên quét {syncInfo.active_count ?? counts.total ?? 0} BN
        <br />Đồng bộ: {formatDateTime(syncAt)}
      </div>
    </div>
  );
}


// ── Main ──────────────────────────────────────────────────────────────────────

export default function HchahnTab({ toast, workDateRange }) {
  const hc = useHchanh({ toast, workDateRange });
  const {
    loading, syncing, fetchingKey, fetchingFile, previewVtytKey, inputVtytKey, bedEditKey, printBillingKey,
    selectedCard, setSelectedCard,
    search, setSearch,
    filterScope, setFilterScope,
    filterStatus, setFilterStatus,
    counts, filteredCards, dashboard,
    sync, fetchPatient, fetchDischargeFull, fetchOneFile, previewVTYT, processVTYTPreview, inputVTYT, openBedEdit, printBilling,
    createTicket, rescanPatient, exportIssues, batchFetch, batchProgress,
    clearPatient,
    vtytPreviewByPatient,
    vtytBatchDraft, setVtytBatchDraft, vtytBatchLoading, vtytBatchInputting,
    previewBatchVTYT, inputBatchVTYT, clearBatchVTYTDraft,
  } = hc;
  const [resourceList, setResourceList] = useState('');
  const [showTools, setShowTools] = useState(false);
  const [workspace, setWorkspace] = useState(() => {
    try { return localStorage.getItem('emr_hchanh_workspace_v1') === 'vtyt' ? 'vtyt' : 'discharge'; }
    catch { return 'discharge'; }
  });

  useEffect(() => {
    try { localStorage.setItem('emr_hchanh_workspace_v1', workspace); } catch {}
    setShowTools(false);
    setResourceList('');
  }, [workspace]);

  if (loading && !dashboard) {
    return (
      <div style={{ padding:32, color:C.text2, display:'flex', alignItems:'center', gap:10 }}>
        <Spinner /> Đang tải dữ liệu hành chánh...
      </div>
    );
  }

  const workspaceButton = (key, title, subtitle) => {
    const active = workspace === key;
    return (
      <button
        type="button"
        onClick={() => setWorkspace(key)}
        style={{
          minWidth: 170,
          padding: '7px 10px',
          textAlign: 'left',
          borderRadius: 6,
          cursor: 'pointer',
          fontFamily: 'inherit',
          border: `1px solid ${active ? C.blueBorder : C.border2}`,
          borderBottom: `2px solid ${active ? C.blue : 'transparent'}`,
          background: active ? C.blueBg : C.surface,
          color: active ? C.blue : C.text,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 850 }}>{title}</div>
        <div style={{ marginTop: 2, fontSize: 9, color: active ? C.blue : C.text3 }}>{subtitle}</div>
      </button>
    );
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden', background:C.bg }}>

      {/* Header + khu làm việc */}
      <div style={{ padding:'8px 12px', borderBottom:`1px solid ${C.border2}`, background:C.surface }}>
        <div style={{ display:'flex', gap:12, alignItems:'center', flexWrap:'wrap' }}>
          <div style={{ minWidth:150, marginRight:2 }}>
            <div style={{ fontSize:14, fontWeight: 850, color:C.text }}>Hành chánh</div>
            <div style={{ fontSize:10, color:C.text3, marginTop:1 }}>Ra viện và vật tư</div>
          </div>

          <div role="tablist" aria-label="Khu làm việc hành chánh" style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
            {workspaceButton('discharge', 'Kiểm ra viện', 'Hồ sơ · chi phí · ngày giường · y lệnh')}
            {workspaceButton('vtyt', `Nhập VTYT${vtytBatchDraft?.patients?.length ? ` (${vtytBatchDraft.patients.length})` : ''}`, 'Quét toàn đợt · sửa kế hoạch · nhập hàng loạt')}
          </div>

          <div style={{ marginLeft:'auto', display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
            <Btn variant="primary" disabled={syncing} onClick={sync} style={{ fontSize:11, padding:'6px 11px' }}>
              {syncing ? <><Spinner size={10} /> Đồng bộ...</> : 'Đồng bộ BN'}
            </Btn>
            <input type="text" placeholder="Tìm tên, mã BN, phòng..."
              value={search} onChange={e => setSearch(e.target.value)}
              style={{ width:250, maxWidth:'32vw', padding:'6px 9px', borderRadius:5,
                background:C.surface, border:`1px solid ${C.border}`, color:C.text, fontSize:11.5 }} />
          </div>
        </div>

        {workspace === 'discharge' ? (
          <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', marginTop:10, paddingTop:9, borderTop:`1px solid ${C.border2}` }}>
            <Btn variant="danger" disabled={batchProgress.running} onClick={() => batchFetch('discharge')}
                 style={{ fontSize:11, padding:'5px 12px' }}>
              {batchProgress.running
                ? `Đang lấy ${batchProgress.done}/${batchProgress.total}...`
                : 'Lấy / cập nhật hồ sơ'}
            </Btn>
            <Btn variant="secondary" disabled={batchProgress.running} onClick={() => batchFetch('missing')}
                 style={{ fontSize:11, padding:'5px 12px' }}>
              Lấy tất cả còn thiếu
            </Btn>

            <div style={{ position:'relative' }}>
              <Btn variant="secondary" onClick={() => setShowTools(v => !v)} style={{ fontSize:11, padding:'5px 10px' }}>
                Công cụ
              </Btn>
              {showTools && (
                <div style={{ position:'absolute', top:'calc(100% + 6px)', left:0, zIndex:30, minWidth:190,
                  padding:8, borderRadius: 6, background:C.surface2, border:`1px solid ${C.border}`, boxShadow:C.shadow2 }}>
                  <Btn variant="secondary" onClick={() => { exportIssues('csv'); setShowTools(false); }} style={{ width:'100%', justifyContent:'flex-start', fontSize:11, padding:'6px 8px', marginBottom:6 }}>
                    Xuất danh sách lỗi CSV
                  </Btn>
                  <Btn variant="secondary" onClick={() => { printHchanh_WardList().catch(err => alert(err.message || err)); setShowTools(false); }} style={{ width:'100%', justifyContent:'flex-start', fontSize:11, padding:'6px 8px', marginBottom:6 }}>
                    In danh sách xếp phòng
                  </Btn>
                  <Btn variant="secondary" onClick={() => { setResourceList('vtyt'); setShowTools(false); }} style={{ width:'100%', justifyContent:'flex-start', fontSize:11, padding:'6px 8px', marginBottom:6 }}>
                    Danh mục vật tư
                  </Btn>
                  <Btn variant="secondary" onClick={() => { setResourceList('bed'); setShowTools(false); }} style={{ width:'100%', justifyContent:'flex-start', fontSize:11, padding:'6px 8px' }}>
                    Danh mục giường
                  </Btn>
                </div>
              )}
            </div>

            <div style={{ width:1, height:24, background:C.border, margin:'0 2px' }} />
            <select value={filterScope} onChange={e => setFilterScope(e.target.value)}
                    style={{ padding:'5px 8px', borderRadius:7, background:C.surface2,
                      border:`1px solid ${C.border}`, color:C.text, fontSize:12 }}>
              <option value="all">Tất cả nhóm</option>
              <option value="discharge">Ra viện</option>
              <option value="surgery">PTTT</option>
              <option value="admission">Nhập mới</option>
              <option value="daily">Tiếp tục ĐT</option>
            </select>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
                    style={{ padding:'5px 8px', borderRadius:7, background:C.surface2,
                      border:`1px solid ${C.border}`, color:C.text, fontSize:12 }}>
              <option value="all">Mọi trạng thái</option>
              <option value="red">Lỗi máy</option>
              <option value="amber">Cần xử lý</option>
              <option value="green">Đủ dữ liệu</option>
              <option value="gray">Chưa lấy</option>
            </select>
            <span style={{ marginLeft:'auto', fontSize:11, color:C.text2 }}>
              Hiển thị <b style={{ color:C.text }}>{filteredCards.length}</b>/<b style={{ color:C.text }}>{dashboard?.total || 0}</b> BN
            </span>
          </div>
        ) : (
          <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', marginTop:10, paddingTop:9, borderTop:`1px solid ${C.border2}`, fontSize:11 }}>
            <span style={{ color:C.text2 }}>Danh sách dùng bộ lọc hiện tại:</span>
            <Chip tone="blue">{filteredCards.length} người bệnh</Chip>
            <select value={filterScope} onChange={e => setFilterScope(e.target.value)}
                    style={{ padding:'5px 8px', borderRadius:7, background:C.surface2,
                      border:`1px solid ${C.border}`, color:C.text, fontSize:12 }}>
              <option value="all">Tất cả nhóm</option>
              <option value="discharge">Ra viện</option>
              <option value="surgery">PTTT</option>
              <option value="admission">Nhập mới</option>
              <option value="daily">Tiếp tục ĐT</option>
            </select>
            <span style={{ color:C.text3 }}>Kế hoạch được tự động lưu; tải lại trang không mất phần đã chỉnh.</span>
            {loading && <Spinner size={14} />}
          </div>
        )}
      </div>

      {workspace === 'discharge' && <CountBar counts={counts} dashboard={dashboard} />}

      {/* Nội dung theo quy trình */}
      {workspace === 'vtyt' ? (
        <div style={{ flex:1, minHeight:0, overflow:'hidden', padding:12 }}>
          <HchanhVtytBatchPanel
            embedded
            cards={filteredCards}
            draft={vtytBatchDraft}
            setDraft={setVtytBatchDraft}
            onPreview={previewBatchVTYT}
            onInput={inputBatchVTYT}
            onClear={clearBatchVTYTDraft}
            loading={vtytBatchLoading}
            inputting={vtytBatchInputting}
          />
        </div>
      ) : (
        <div style={{ flex:1, display:'flex', overflow:'hidden', minWidth:0 }}>

          {/* Danh sách kiểm ra viện */}
          <div style={{ flex:1, minWidth:0, overflow:'auto', padding:'12px 14px' }}>
            {filteredCards.length === 0 ? (
              <div style={{ color:C.text2, fontSize:13, padding:24, textAlign:'center' }}>
                {!dashboard?.total
                  ? 'Chưa có người bệnh. Bấm "Đồng bộ BN" để lấy danh sách từ dữ liệu đã quét.'
                  : 'Không có người bệnh phù hợp bộ lọc.'}
              </div>
            ) : (
              <div style={{ border:`1px solid ${C.border}`, borderRadius: 7, overflow:'hidden', background:C.surface, boxShadow:C.shadow }}>
                <table style={{ width:'100%', borderCollapse:'separate', borderSpacing:0, tableLayout:'auto' }}>
                  <thead style={{ position:'sticky', top:0, zIndex:5 }}>
                    <tr style={{ background:C.surface2 }}>
                      {[
                        ['Người bệnh', 'left', 230],
                        ['P', 'left', 46],
                        ['Nhóm', 'center', 74],
                        ['RV', 'center', 44],
                        ['BK', 'center', 44],
                        ['Giường', 'center', 52],
                        ['PT', 'center', 44],
                        ['YL', 'center', 44],
                        ['Vấn đề', 'left', 160],
                        ['Thao tác', 'right', 88],
                      ].map(([label, align, minWidth]) => (
                        <th key={label} style={{ padding:'8px 8px', borderBottom:`1px solid ${C.border}`, color:C.text2, fontSize:10,
                          textAlign:align, textTransform:'uppercase', letterSpacing:0.6, whiteSpace:'nowrap', minWidth }}>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCards.map(card => (
                      <PatientTableRow
                        key={getMaBn(card) || card.key}
                        card={card}
                        selected={getMaBn(selectedCard) === getMaBn(card)}
                        onSelect={card => { setResourceList(''); setSelectedCard(card); }}
                        onFetchDischargeFull={fetchDischargeFull}
                        fetchingKey={fetchingKey}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {resourceList && (
            <ResourceListPanel type={resourceList} onClose={() => setResourceList('')} />
          )}

          {!resourceList && selectedCard && (
            <DetailPanel
              card={selectedCard}
              onClose={() => setSelectedCard(null)}
              onFetch={fetchPatient}
              onFetchDischargeFull={fetchDischargeFull}
              onFetchFile={fetchOneFile}
              onPreviewVTYT={previewVTYT}
              onProcessVTYT={processVTYTPreview}
              onInputVTYT={inputVTYT}
              onOpenBedEdit={openBedEdit}
              onPrintBilling={printBilling}
              onCreateTicket={createTicket}
              onRescan={rescanPatient}
              fetchingKey={fetchingKey}
              fetchingFile={fetchingFile}
              previewVtytKey={previewVtytKey}
              inputVtytKey={inputVtytKey}
              bedEditKey={bedEditKey}
              printBillingKey={printBillingKey}
              vtytPreview={vtytPreviewByPatient[getMaBn(selectedCard)]}
            />
          )}
        </div>
      )}
    </div>
  );
}
