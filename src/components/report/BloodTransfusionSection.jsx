import { useEffect, useMemo, useState } from 'react';
import { IconCopy, IconPrinter } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { Btn, Segmented } from '../shared.jsx';
import {
  DURATION_MINUTES, buildCareText, buildTransfusionPrintHtml, buildTransfusionTimeline, durationText, endTimeOf,
  SAVED_EVENT, groupTransfusions, readTransfusionForms, statusOf, seedBaseOf, slotNoteText, slotValues, writeTransfusionForms,
} from './bloodTransfusion.js';

function printHtml(html) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
  frame.contentWindow.focus();
  frame.contentWindow.print();
  setTimeout(() => frame.remove(), 60000);
}

const inputStyle = {
  height: 30, padding: '0 8px', border: `1px solid ${C.border}`, borderRadius: 5, fontSize: FS.md,
  color: C.text, background: C.surface, fontFamily: 'inherit', minWidth: 0,
};
const cellInput = { ...inputStyle, width: '100%', height: 28, padding: '0 6px', boxSizing: 'border-box' };
const th = { padding: '6px 6px', fontSize: FS.xs, fontWeight: 600, color: C.text2, textAlign: 'left', borderBottom: `1px solid ${C.border2}`, background: C.surface2, verticalAlign: 'bottom' };
const td = { padding: '4px 6px', borderTop: `1px solid ${C.border2}`, verticalAlign: 'top' };

function Field({ label, children, width }) {
  return (
    <label style={{ display: 'grid', gap: 3, fontSize: FS.xs, color: C.text2, width }}>
      {label}
      {children}
    </label>
  );
}

const VITALS = [
  { key: 'rate', label: 'Tốc độ (giọt/ph)', width: 70 },
  { key: 'skin', label: 'Màu sắc da, niêm mạc', width: 110 },
  { key: 'resp', label: 'Nhịp thở (l/ph)', width: 64 },
  { key: 'pulse', label: 'Mạch (l/ph)', width: 64 },
  { key: 'bp', label: 'Huyết áp (mmHg)', width: 86 },
  { key: 'temp', label: 'Thân nhiệt (°C)', width: 64 },
];

function TransfusionCard({ group, form, onChange, date }) {
  const [copied, setCopied] = useState('');
  const slots = useMemo(() => buildTransfusionTimeline(form.start), [form.start]);
  const cells = form.cells || {};
  const seedBase = seedBaseOf(date, group.patientId || group.patientName, form.start);
  const endTime = endTimeOf(form.start);
  const status = statusOf(form);
  const set = (field, value) => onChange({ ...form, [field]: value });
  const setCell = (slotKey, field, value) => onChange({ ...form, cells: { ...cells, [slotKey]: { ...(cells[slotKey] || {}), [field]: value } } });

  const copyCare = async () => {
    try {
      await navigator.clipboard.writeText(buildCareText(slots, cells));
      setCopied('Đã sao chép phần chăm sóc.');
    } catch {
      setCopied('Trình duyệt không cho sao chép. Chọn chữ trong bảng rồi bấm Ctrl+C.');
    }
  };
  const print = () => {
    try { printHtml(buildTransfusionPrintHtml(group, form, date)); } catch (e) { setCopied(`Không mở được hộp thoại in: ${e.message || e}`); }
  };

  return (
    <div style={{ borderTop: `1px solid ${C.border2}`, padding: '10px 12px', display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: '4px 12px', flexWrap: 'wrap', alignItems: 'baseline' }}>
        <b style={{ fontSize: FS.md }}>{group.room}</b>
        <b style={{ fontSize: FS.md }}>{group.patientName}</b>
        <span style={{ fontSize: FS.md, color: C.text }}>
          {group.products.map(r => r.drugName).join('; ') || (group.reserved
            ? 'Dự trù khối hồng cầu (theo y lệnh)'
            : <span style={{ color: C.amber }}>Chưa có y lệnh chế phẩm máu</span>)}
        </span>
        {group.tests.length > 0 && <span style={{ fontSize: FS.xs, color: C.text2 }}>Xét nghiệm: {group.tests.map(r => r.drugName).join('; ')}</span>}
      </div>

      <Segmented
        label={`Trạng thái truyền máu của ${group.patientName}`}
        value={status}
        onChange={value => onChange({ ...form, status: value })}
        options={[{ value: 'reserve', label: 'Dự trù máu, chưa truyền' }, { value: 'transfuse', label: 'Truyền máu' }]}
      />

      {status === 'reserve' && (
        <div style={{ fontSize: FS.sm, color: C.text2, lineHeight: 1.5 }}>
          Mới dự trù máu: chưa có bảng theo dõi, và Nhập chăm sóc sẽ không hỏi giờ hay tạo phiếu truyền máu cho người bệnh này.
          Khi bắt đầu truyền, chọn <b style={{ color: C.text }}>Truyền máu</b> rồi nhập giờ bắt đầu.
        </div>
      )}

      {status === 'transfuse' && <>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
          <Field label="Bắt đầu truyền"><input type="time" aria-label="Giờ bắt đầu truyền máu" value={form.start || ''} onChange={e => set('start', e.target.value)} style={inputStyle} /></Field>
          <Field label={`Ngừng truyền (tự tính, ${durationText(DURATION_MINUTES)})`}>
            <output aria-label="Giờ ngừng truyền máu" style={{ ...inputStyle, display: 'inline-flex', alignItems: 'center', background: C.surface2, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{endTime || '—'}</output>
          </Field>
          <Field label="Lần truyền thứ" width={90}><input value={form.lanThu || ''} onChange={e => set('lanThu', e.target.value)} style={inputStyle} /></Field>
          <Field label="Nhóm đơn vị máu, chế phẩm" width={150}><input value={form.nhomDonVi || ''} onChange={e => set('nhomDonVi', e.target.value)} style={inputStyle} /></Field>
          <Field label="Nhóm người nhận" width={110}><input value={form.nhomNguoiNhan || ''} onChange={e => set('nhomNguoiNhan', e.target.value)} style={inputStyle} /></Field>
          <Field label="Phản ứng chéo tại giường" width={150}><input value={form.phanUngCheo || ''} onChange={e => set('phanUngCheo', e.target.value)} style={inputStyle} /></Field>
          <Field label="Số lượng đã truyền (ml)" width={140}><input inputMode="numeric" value={form.soLuongMl || ''} onChange={e => set('soLuongMl', e.target.value)} style={inputStyle} /></Field>
        </div>

        {!slots.length ? (
          <div style={{ fontSize: FS.sm, color: C.text2 }}>Nhập giờ bắt đầu truyền (ví dụ 14:00) để tạo các mốc chăm sóc.</div>
        ) : (
          <>
            <div style={{ overflowX: 'auto', border: `1px solid ${C.border2}`, borderRadius: 5 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
                <thead>
                  <tr>
                    <th style={{ ...th, width: 62 }}>Thời gian</th>
                    {VITALS.map(v => <th key={v.key} style={{ ...th, width: v.width }}>{v.label}</th>)}
                    <th style={th}>Những diễn biến khác</th>
                  </tr>
                </thead>
                <tbody>
                  {slots.map(slot => {
                    const c = cells[slot.key] || {};
                    const values = slotValues(slot, cells, seedBase);
                    return (
                      <tr key={slot.key}>
                        <td style={{ ...td, fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', paddingTop: 9 }}>
                          {slot.time}{slot.dayOffset > 0 && <span style={{ fontSize: FS.xs, color: C.text2, fontWeight: 400 }}> hôm sau</span>}
                        </td>
                        {VITALS.map(v => (
                          <td key={v.key} style={td}>
                            <input aria-label={`${v.label} lúc ${slot.time}`} value={values[v.key] ?? ''} onChange={e => setCell(slot.key, v.key, e.target.value)} style={cellInput} />
                          </td>
                        ))}
                        <td style={td}>
                          <textarea
                            aria-label={`Diễn biến lúc ${slot.time}`}
                            value={c.note ?? slotNoteText(slot)}
                            onChange={e => setCell(slot.key, 'note', e.target.value)}
                            rows={slot.kind === 'pre' ? 2 : 1}
                            style={{ ...cellInput, height: 'auto', minHeight: 28, padding: '4px 6px', resize: 'vertical', lineHeight: 1.35 }}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: FS.xs, color: C.text2 }}>
              Sinh hiệu điền sẵn là đúng số sẽ nhập vào phiếu chăm sóc EMR khi chạy Nhập chăm sóc. Đo thật khác thì sửa ô trong bảng trước khi nhập.
            </div>
          </>
        )}

        <Field label="Nhận xét quá trình truyền máu">
          <input value={form.nhanXet || ''} onChange={e => set('nhanXet', e.target.value)} style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} />
        </Field>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Btn icon={IconCopy} onClick={copyCare} disabled={!slots.length}>Sao chép chăm sóc</Btn>
          <Btn icon={IconPrinter} onClick={print}>In phiếu theo dõi</Btn>
          {copied && <span role="status" style={{ fontSize: FS.xs, color: C.text2 }}>{copied}</span>}
        </div>
      </>}
    </div>
  );
}

export function BloodTransfusionSection({ rows, date, flagged = [], empty = null }) {
  const groups = useMemo(() => groupTransfusions(rows, date, flagged), [rows, date, flagged]);
  const [forms, setForms] = useState(readTransfusionForms);
  const [saveError, setSaveError] = useState(false);
  // Nhập chăm sóc lưu giờ bắt đầu truyền → đọc lại để bảng hiện đúng giờ đó.
  useEffect(() => {
    const reload = () => setForms(readTransfusionForms());
    window.addEventListener(SAVED_EVENT, reload);
    return () => window.removeEventListener(SAVED_EVENT, reload);
  }, []);
  if (!groups.length) return empty;

  const update = (key, form) => setForms(prev => {
    const next = { ...prev, [key]: form };
    setSaveError(!writeTransfusionForms(next));
    return next;
  });

  return (
    <section style={{ border: `1px solid ${C.border}`, background: C.surface, borderRadius: 7, overflow: 'hidden', minWidth: 0 }}>
      <header style={{ padding: '10px 12px', background: C.surface }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: FS.lg, fontWeight: 700, color: C.text }}>Truyền máu</h3>
          <span style={{ fontSize: FS.sm, color: C.text2 }}>{groups.length} người bệnh</span>
        </div>
        <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 2 }}>
          Người làm tự theo dõi đến khi kết thúc, không bàn giao. Mặc định là dự trù máu; khi truyền, chọn Truyền máu và nhập giờ bắt đầu: giờ ngừng và các mốc chăm sóc tự tính, Nhập chăm sóc dùng đúng các mốc này.
          {saveError
            ? <span style={{ color: C.red, fontWeight: 600 }}> Không lưu được trên máy này (trình duyệt chặn bộ nhớ): in hoặc sao chép trước khi tải lại trang.</span>
            : ' Nội dung đã nhập tự lưu trên máy này.'}
        </div>
      </header>
      {groups.map(group => (
        <TransfusionCard key={group.key} group={group} date={date} form={forms[group.key] || {}} onChange={form => update(group.key, form)} />
      ))}
    </section>
  );
}
