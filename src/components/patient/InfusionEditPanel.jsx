import { useEffect, useState } from 'react';
import { IconAlertTriangle, IconClock, IconInfoCircle } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import * as api from '../../api.js';
import { normalizeGio } from './patientDetailUtils.js';
import { groupInfusionRows } from '../../utils/infusionReview.js';

function infusionMatchOf(item = {}) {
  return {
    ten_thuoc: item.ten_thuoc || '',
    bac_si: item.bac_si || '',
    tg_bat_dau: item.tg_bat_dau || item.gio_dung || '',
    tg_ket_thuc: item.tg_ket_thuc || '',
    the_tich: item.the_tich ?? '',
    toc_do: item.toc_do ?? '',
  };
}

function nextDayDmy(dmy) {
  const m = String(dmy || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return '';
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]) + 1);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

const validPositive = value => /^\d+(?:[.,]\d+)?$/.test(String(value ?? '').trim())
  && Number(String(value).trim().replace(',', '.')) > 0;

function InfusionEditRow({ item, review, patientId, ngayLam, toast, onSaved }) {
  const [theTich, setTheTich] = useState(item.the_tich ?? '');
  const [tocDo, setTocDo] = useState(item.toc_do ?? '');
  const [startTime, setStartTime] = useState('');
  const [startDate, setStartDate] = useState(ngayLam || '');
  const [saving, setSaving] = useState(false);
  const [localNotice, setLocalNotice] = useState('');
  // Chỉ dòng chưa có giờ bắt đầu mới cho bổ sung giờ (y lệnh không ghi giờ dùng).
  const canAddStart = review.missingTime;
  const nextDay = nextDayDmy(ngayLam);

  const valuesDirty = String(theTich ?? '').trim() !== String(item.the_tich ?? '').trim()
    || String(tocDo ?? '').trim() !== String(item.toc_do ?? '').trim();
  const startDirty = canAddStart && !!startTime;
  const dirty = valuesDirty || startDirty;
  // Server refreshes should update unmodified inputs, but never overwrite a
  // field the user is in the middle of correcting.
  useEffect(() => {
    if (!dirty && !saving) {
      setTheTich(item.the_tich ?? '');
      setTocDo(item.toc_do ?? '');
    }
  }, [item.the_tich, item.toc_do, dirty, saving]);

  const invalid = dirty && (!validPositive(theTich) || !validPositive(tocDo)
    || (startDirty && !/^\d{2}:\d{2}$/.test(startTime)));
  const handleSave = async () => {
    if (!dirty || saving || invalid) return;
    setSaving(true);
    setLocalNotice('');
    try {
      const updates = {};
      if (String(theTich ?? '').trim() !== String(item.the_tich ?? '').trim()) updates.the_tich = theTich;
      if (String(tocDo ?? '').trim() !== String(item.toc_do ?? '').trim()) updates.toc_do = tocDo;
      if (startDirty) updates.tg_bat_dau = `${startTime} ${startDate || ngayLam}`;
      const r = await api.updateInfusionItem(patientId, ngayLam, infusionMatchOf(item), updates);
      if (r?.status === 'ok' && r.schedule) {
        setLocalNotice(r.message);
        setStartTime('');
        toast?.(r.message, 'success');
        await onSaved?.();
      } else if (r?.status === 'ok') {
        setLocalNotice(r.message || 'Đã lưu cục bộ; cần đối chiếu và tính lại lịch truyền.');
        toast?.('Đã lưu cục bộ. Cần kiểm tra lại lịch truyền trước khi nhập EMR.', 'warn');
        await onSaved?.();
      } else {
        toast?.(r?.message || 'Không lưu được thay đổi.', 'error');
      }
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      background: C.surface, border: `1px solid ${review.needsReview ? C.amberBorder : C.border2}`,
      borderRadius: 7, padding: '10px 12px', display: 'grid', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: FS.md, fontWeight: 700,
          color: review.missingTime ? C.amber : C.blue, minWidth: 44 }}>
          {review.scheduled ? normalizeGio(review.scheduled) : 'Chưa rõ'}
        </span>
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <div style={{ fontSize: FS.md, color: C.text, fontWeight: 600 }}>
            {item.ten_hien_thi || item.ten_thuoc || 'Không rõ tên thuốc'}
          </div>
          <div style={{ fontSize: FS.xs, color: C.text2, lineHeight: 1.6, marginTop: 3 }}>
            <div>Giờ dùng ghi trong dữ liệu y lệnh: <b>{review.orderTime || 'Chưa có'}</b></div>
            <div>Lịch truyền phần mềm tính: <b>{review.scheduled || 'Chưa xác định'}</b>
              {review.end ? ` → ${review.end}` : ''}</div>
            {review.otherDay && <div style={{ color: C.amber }}>
              Mốc này thuộc ngày {review.scheduledDate}, khác ngày đang chọn {ngayLam}.
            </div>}
            {review.source && <div>Thể tích pha: nguồn `{review.source}` — cần kiểm tra lại với y lệnh/quy trình.</div>}
          </div>
        </div>
      </div>

      {review.needsReview && (
        <div role="alert" style={{ display: 'flex', alignItems: 'flex-start', gap: 6,
          padding: '6px 8px', background: C.amberBg, color: C.amber,
          border: `1px solid ${C.amberBorder}`, borderRadius: 5,
          fontSize: FS.sm, lineHeight: 1.5 }}>
          <IconAlertTriangle size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{review.concerns.join('. ')}. Đối chiếu Y lệnh gốc; không nhập EMR khi chưa xử lý.</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'grid', gap: 3 }}>
          <span style={{ fontSize: FS.xs, color: C.text2, fontWeight: 600 }}>Thể tích truyền (ml)</span>
          <input type="text" inputMode="decimal" aria-label="Thể tích truyền (ml)"
            value={theTich} onChange={e => setTheTich(e.target.value)}
            style={{ width: 98, padding: '6px 8px', borderRadius: 5,
              border: `1px solid ${C.border}`, fontSize: FS.md,
              fontVariantNumeric: 'tabular-nums', color: C.text, background: C.surface }} />
        </label>
        <label style={{ display: 'grid', gap: 3 }}>
          <span style={{ fontSize: FS.xs, color: C.text2, fontWeight: 600 }}>Tốc độ (giọt/phút)</span>
          <input type="text" inputMode="decimal" aria-label="Tốc độ (giọt/phút)"
            value={tocDo} onChange={e => setTocDo(e.target.value)}
            style={{ width: 98, padding: '6px 8px', borderRadius: 5,
              border: `1px solid ${C.border}`, fontSize: FS.md,
              fontVariantNumeric: 'tabular-nums', color: C.text, background: C.surface }} />
        </label>
        {canAddStart && (
          <label style={{ display: 'grid', gap: 3 }}>
            <span style={{ fontSize: FS.xs, color: C.text2, fontWeight: 600 }}>Giờ bắt đầu theo y lệnh</span>
            <span style={{ display: 'flex', gap: 6 }}>
              <input type="time" aria-label="Giờ bắt đầu truyền"
                value={startTime} onChange={e => setStartTime(e.target.value)}
                style={{ padding: '5px 8px', borderRadius: 5, border: `1px solid ${C.border}`,
                  fontSize: FS.md, fontVariantNumeric: 'tabular-nums', color: C.text, background: C.surface }} />
              <select aria-label="Ngày bắt đầu truyền" value={startDate}
                onChange={e => setStartDate(e.target.value)}
                style={{ padding: '5px 6px', borderRadius: 5, border: `1px solid ${C.border}`,
                  fontSize: FS.sm, color: C.text, background: C.surface }}>
                <option value={ngayLam}>{ngayLam}</option>
                {nextDay && <option value={nextDay}>{nextDay} (hôm sau)</option>}
              </select>
            </span>
          </label>
        )}
        <Btn variant="primary" disabled={!dirty || invalid || saving} onClick={handleSave}>
          {saving ? <><Spinner size={13} /> Đang lưu</> : (startDirty ? 'Bổ sung giờ' : 'Lưu cục bộ')}
        </Btn>
        {dirty && <span style={{ fontSize: FS.xs, color: invalid ? C.red : C.amber }}>
          {invalid ? 'Cần nhập số dương cho thể tích, tốc độ và giờ bắt đầu hợp lệ.' : 'Chưa lưu thay đổi'}
        </span>}
      </div>
      {localNotice && <div role="status" style={{ fontSize: FS.sm, color: C.amber }}>{localNotice}</div>}
    </div>
  );
}

export default function InfusionEditPanel({ patientDay, patientId, ngayLam, toast, onSaved }) {
  const items = Array.isArray(patientDay?.thuoc?.dich_truyen) ? patientDay.thuoc.dich_truyen : [];
  const { scheduled, unresolved } = groupInfusionRows(items, ngayLam);
  const inferredCount = items.filter(x => x.toc_do_inferred).length;
  const staleCount = items.filter(x => x.infusion_schedule_stale).length;

  if (!items.length) {
    return <div style={{ fontSize: FS.sm, color: C.text3 }}>Ngày này không có dịch truyền để sửa.</div>;
  }

  const render = ({ item, review }, i) => (
    <InfusionEditRow key={`${item.tg_bat_dau || item.gio_dung || 'no-time'}-${item.ten_thuoc || ''}-${i}`}
      item={item} review={review} patientId={patientId} ngayLam={ngayLam}
      toast={toast} onSaved={onSaved} />
  );

  return (
    <section aria-label="Đối chiếu và sửa dữ liệu dịch truyền" style={{ display: 'grid', gap: 14 }}>
      <div style={{ border: `1px solid ${C.amberBorder}`, borderRadius: 7,
        padding: '10px 12px', background: C.amberBg, color: C.text, fontSize: FS.sm, lineHeight: 1.6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700 }}>
          <IconInfoCircle size={16} aria-hidden="true" /> Kiểm tra trước khi nhập EMR
        </div>
        <div>Đây là dữ liệu đã xử lý cục bộ, <b>không phải lịch truyền đã xác nhận</b>.
          Giờ bắt đầu có thể được phần mềm xếp lại theo thời lượng; giờ gần nửa đêm có thể sang ngày hôm sau.
          Sửa thể tích/tốc độ sẽ không tự tính lại toàn bộ lịch truyền liên quan.
          Dòng chưa có giờ (y lệnh không ghi giờ dùng): nhập giờ bắt đầu theo y lệnh rồi bấm <b>Bổ sung giờ</b>,
          phần mềm tự tính giờ kết thúc, không cần lấy lại dữ liệu.
          Cần đối chiếu <b>Y lệnh gốc</b> và chạy xử lý lại trước khi nhập EMR.</div>
        <div style={{ marginTop: 4 }}>
          {items.length} dòng · {unresolved.length} chưa có giờ bắt đầu · {inferredCount} tốc độ phần mềm tự gán
          {staleCount ? ` · ${staleCount} lịch cần tính lại` : ''}
        </div>
      </div>

      {!!unresolved.length && (
        <div style={{ display: 'grid', gap: 8 }}>
          <h3 style={{ fontSize: FS.md, color: C.amber, display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
            <IconAlertTriangle size={16} aria-hidden="true" />
            Chưa xác định giờ truyền ({unresolved.length}) — không cho nhập EMR
          </h3>
          {unresolved.map(render)}
        </div>
      )}

      {!!scheduled.length && (
        <div style={{ display: 'grid', gap: 8 }}>
          <h3 style={{ fontSize: FS.md, color: C.text, display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
            <IconClock size={16} aria-hidden="true" />
            Các mốc truyền đã tính ({scheduled.length})
          </h3>
          {scheduled.map(render)}
        </div>
      )}
    </section>
  );
}
