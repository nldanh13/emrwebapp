import React, { useEffect, useMemo, useState } from 'react';
import { C } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import { HCHANH_VTYT_ITEMS } from '../../config/hchanhLists.js';

function safeArray(value) { return Array.isArray(value) ? value : []; }
function patientId(card = {}) { return String(card.ma_bn || card.patient_id || card.id || '').trim(); }
function norm(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim();
}
function num(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }

const inputStyle = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 7,
  background: C.surface2, border: `1px solid ${C.border}`, color: C.text, fontSize: 11,
};

function updateJob(draft, jobIndex, updater) {
  const jobs = safeArray(draft?.jobs).map((job, index) => index === jobIndex ? updater({ ...job }) : job);
  const changedPatient = jobs[jobIndex]?.ma_bn;
  const patients = safeArray(draft?.patients).map(patient => String(patient.ma_bn) === String(changedPatient) ? { ...patient, reviewed: false } : patient);
  return { ...draft, jobs, patients, updated_at: new Date().toISOString() };
}

function SupplyEditor({ item, onChange, onRemove }) {
  const warning = safeArray(item.warnings).join(' ');
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '28px minmax(220px, 1fr) 72px 72px 90px 34px', gap: 7, alignItems: 'center', padding: '7px 8px', borderBottom: `1px solid ${C.border2}` }}>
      <input type="checkbox" checked={item.selected !== false} onChange={e => onChange({ ...item, selected: e.target.checked })} title="Chọn vật tư này để nhập" />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name || item.code}</div>
        <div style={{ fontSize: 9, color: C.text3 }}>{item.code || 'Vật tư thủ công'}{item.manual ? ' · thêm thủ công' : ''}</div>
        {safeArray(item.reasons).length > 0 && <div title={safeArray(item.reasons).join('\n')} style={{ fontSize: 9, color: C.text2, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{safeArray(item.reasons).join(' · ')}</div>}
        {warning && <div style={{ fontSize: 9, color: C.red, marginTop: 2 }}>{warning}</div>}
      </div>
      <div style={{ textAlign: 'center' }}><div style={{ fontSize: 9, color: C.text3 }}>Cần</div><b style={{ fontSize: 11 }}>{num(item.required_quantity)}</b></div>
      <div style={{ textAlign: 'center' }}><div style={{ fontSize: 9, color: C.text3 }}>Đã có</div><b style={{ fontSize: 11, color: num(item.existing_quantity) > num(item.required_quantity) + 2 ? C.red : C.text }}>{num(item.existing_quantity)}</b></div>
      <div>
        <div style={{ fontSize: 9, color: C.text3, marginBottom: 2 }}>Sẽ nhập</div>
        <input type="number" min="0" step="1" value={item.input_quantity ?? 0} onChange={e => onChange({ ...item, input_quantity: Math.max(0, Number(e.target.value || 0)), selected: Number(e.target.value || 0) > 0 })} style={{ ...inputStyle, padding: '4px 6px', textAlign: 'center' }} />
      </div>
      <button type="button" onClick={onRemove} title="Xóa vật tư khỏi kế hoạch" style={{ width: 30, height: 28, borderRadius: 6, border: `1px solid ${C.redBorder}`, background: C.redBg, color: C.red, cursor: 'pointer', fontWeight: 850 }}>×</button>
    </div>
  );
}

function PatientPlan({ patient, jobs, draft, setDraft }) {
  const [open, setOpen] = useState(true);
  const [addText, setAddText] = useState('');
  const patientJobs = jobs.map(({ job, index }) => ({ job, index }));
  const episodeDates = safeArray(draft?.patient_dates?.[patient.ma_bn]);
  const [addDate, setAddDate] = useState(patientJobs[patientJobs.length - 1]?.job?.ngay_lam || episodeDates[episodeDates.length - 1] || '');
  const episodeRange = episodeDates.length ? `${episodeDates[0]} → ${episodeDates[episodeDates.length - 1]}` : 'Chưa rõ khoảng';
  const missingCount = patientJobs.reduce((sum, { job }) => sum + safeArray(job.supplies).filter(item => item.selected !== false && num(item.input_quantity) > 0).length, 0);
  const warningCount = patientJobs.reduce((sum, { job }) => sum + safeArray(job.supplies).reduce((n, item) => n + safeArray(item.warnings).length, 0) + safeArray(job.warnings).length, 0);

  function setReviewed(checked) {
    setDraft(previous => ({
      ...previous,
      patients: safeArray(previous?.patients).map(row => String(row.ma_bn) === String(patient.ma_bn) ? { ...row, reviewed: checked } : row),
      updated_at: new Date().toISOString(),
    }));
  }

  function addSupply() {
    const rawCode = String(addText || '').split('·')[0].trim();
    const q = norm(addText);
    const found = HCHANH_VTYT_ITEMS.find(item => norm(item.code) === norm(rawCode) || norm(item.code) === q || norm(item.name) === q)
      || HCHANH_VTYT_ITEMS.find(item => norm(`${item.code} ${item.name}`).includes(q));
    if (!found || !addDate) return;
    const manualItem = {
      key: found.code, code: found.code, name: found.name, searchKeyword: found.name,
      required_quantity: 0, existing_quantity: 0, missing_quantity: 0,
      input_quantity: 1, selected: true, manual: true,
      reasons: ['Người dùng thêm thủ công'], warnings: [],
    };
    setDraft(previous => {
      const currentJobs = safeArray(previous?.jobs);
      const targetIndex = currentJobs.findIndex(job => String(job.ma_bn) === String(patient.ma_bn) && job.ngay_lam === addDate);
      let jobsNext;
      if (targetIndex >= 0) {
        jobsNext = currentJobs.map((job, index) => {
          if (index !== targetIndex) return job;
          const exists = safeArray(job.supplies).find(item => item.code === found.code);
          const supplies = exists
            ? safeArray(job.supplies).map(item => item.code === found.code ? { ...item, selected: true, input_quantity: Math.max(1, num(item.input_quantity)), manual: true } : item)
            : [...safeArray(job.supplies), manualItem];
          return { ...job, supplies, reviewed: false };
        });
      } else {
        jobsNext = [...currentJobs, {
          key: `${patient.ma_bn}::${addDate}`,
          ma_bn: patient.ma_bn,
          ho_ten: patient.ho_ten || '',
          so_phong: patient.phong || '',
          ngay_lam: addDate,
          supplies: [manualItem], drugs: [], orders: [], warnings: [],
          summary: { order_count: 0, drug_count: 0, supply_count: 1, warning_count: 0 },
          input_time: `08:00 ${addDate}`,
          range: { from: `00:00 ${addDate}`, to: `23:59 ${addDate}` },
          no_orders: true, hchanh_direct_vtyt: true, allow_select_all_orders: false, reviewed: false,
        }].sort((a, b) => String(a.ngay_lam || '').localeCompare(String(b.ngay_lam || '')));
      }
      return {
        ...previous,
        jobs: jobsNext,
        patients: safeArray(previous?.patients).map(row => String(row.ma_bn) === String(patient.ma_bn) ? { ...row, reviewed: false } : row),
        updated_at: new Date().toISOString(),
      };
    });
    setAddText('');
  }

  return (
    <div style={{ border: `1px solid ${patient.reviewed ? C.greenBorder : C.border}`, borderRadius: 6, background: C.surface, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 11px', background: C.surface2, borderBottom: open ? `1px solid ${C.border}` : 'none' }}>
        <button type="button" onClick={() => setOpen(value => !value)} style={{ border: 0, background: 'transparent', color: C.text2, cursor: 'pointer', width: 20 }}>{open ? '▾' : '▸'}</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 850 }}>{patient.ho_ten || patient.ma_bn}</div>
          <div style={{ fontSize: 9, color: C.text3 }}>Mã BN {patient.ma_bn} · Khoảng {episodeRange} · {episodeDates.length} ngày trong đợt · {patientJobs.length} ngày có kế hoạch · {missingCount} dòng sẽ nhập{warningCount ? ` · ${warningCount} cảnh báo` : ''}</div>
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: patient.reviewed ? C.green : C.text2, fontWeight: 800 }}>
          <input type="checkbox" checked={Boolean(patient.reviewed)} onChange={e => setReviewed(e.target.checked)} />
          Đã kiểm kế hoạch
        </label>
      </div>

      {open && <div>
        <div style={{ display: 'grid', gridTemplateColumns: '170px 1fr 90px', gap: 7, padding: '8px 10px', borderBottom: `1px solid ${C.border2}`, background: C.surface }}>
          <select value={addDate} onChange={e => setAddDate(e.target.value)} style={inputStyle}>
            {episodeDates.map(date => <option key={date} value={date}>{date}</option>)}
          </select>
          <input list={`vtyt-list-${patient.ma_bn}`} value={addText} onChange={e => setAddText(e.target.value)} placeholder="Gõ tên hoặc mã vật tư để thêm nhanh..." style={inputStyle} />
          <datalist id={`vtyt-list-${patient.ma_bn}`}>
            {HCHANH_VTYT_ITEMS.map(item => <option key={item.code} value={`${item.code} · ${item.name}`} />)}
          </datalist>
          <Btn variant="secondary" onClick={addSupply} disabled={!addText.trim()} style={{ fontSize: 10, padding: '4px 7px' }}>Thêm VTYT</Btn>
        </div>

        {patientJobs.length === 0 && (
          <div style={{ padding: 10, color: C.text3, fontSize: 10 }}>Chưa có vật tư tự động gợi ý. Có thể chọn một ngày ở trên và thêm vật tư thủ công.</div>
        )}

        {patientJobs.map(({ job, index }) => (
          <div key={`${patient.ma_bn}-${job.ngay_lam}`} style={{ borderBottom: `1px solid ${C.border}` }}>
            <div style={{ padding: '6px 9px', background: C.blueBg, color: C.blue, fontSize: 10, fontWeight: 850 }}>
              Ngày {job.ngay_lam} · {safeArray(job.drugs).length} thuốc/y lệnh · {safeArray(job.supplies).length} vật tư tổng hợp
            </div>
            {safeArray(job.supplies).length === 0 ? (
              <div style={{ padding: 9, color: C.text3, fontSize: 10 }}>Không có vật tư dự kiến cho ngày này.</div>
            ) : safeArray(job.supplies).map((item, itemIndex) => (
              <SupplyEditor
                key={`${item.code || item.name}-${itemIndex}`}
                item={item}
                onChange={next => setDraft(previous => updateJob(previous, index, current => ({ ...current, supplies: safeArray(current.supplies).map((row, rowIndex) => rowIndex === itemIndex ? next : row) })))}
                onRemove={() => setDraft(previous => updateJob(previous, index, current => ({ ...current, supplies: safeArray(current.supplies).filter((_, rowIndex) => rowIndex !== itemIndex) })))}
              />
            ))}
          </div>
        ))}
      </div>}
    </div>
  );
}

export default function HchanhVtytBatchPanel({ cards = [], draft, setDraft, onPreview, onInput, onClear, loading = false, inputting = false, onClose }) {
  const [selectedIds, setSelectedIds] = useState(() => new Set(safeArray(draft?.selected_patient_ids)));
  const selectedDraftSignature = safeArray(draft?.selected_patient_ids).join('|');
  useEffect(() => {
    if (selectedDraftSignature) setSelectedIds(new Set(safeArray(draft?.selected_patient_ids)));
  }, [selectedDraftSignature]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectableCards = useMemo(() => safeArray(cards).filter(card => patientId(card)), [cards]);
  const patientJobs = useMemo(() => {
    const map = new Map();
    safeArray(draft?.jobs).forEach((job, index) => {
      const id = String(job.ma_bn || '').trim();
      if (!map.has(id)) map.set(id, []);
      map.get(id).push({ job, index });
    });
    return map;
  }, [draft]);
  const allReviewed = safeArray(draft?.patients).length > 0 && safeArray(draft?.patients).every(patient => patient.reviewed);
  const precheckExpired = Boolean(draft?.precheck_expires_at && Date.parse(draft.precheck_expires_at) <= Date.now());
  const selectedCards = selectableCards.filter(card => selectedIds.has(patientId(card)));

  function toggleAll(checked) {
    setSelectedIds(checked ? new Set(selectableCards.map(patientId)) : new Set());
  }

  return (
    <div style={{ width: 'min(1120px, 88vw)', height: '100%', display: 'flex', flexDirection: 'column', background: C.surface, borderLeft: `1px solid ${C.border}`, boxShadow: '-10px 0 28px rgba(0,0,0,.12)' }}>
      <div style={{ padding: '11px 14px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 850 }}>NHẬP VẬT TƯ Y TẾ HÀNG LOẠT</div>
          <div style={{ fontSize: 10, color: C.text3, marginTop: 2 }}>Quét hôm qua · hôm nay · ngày mai · tự lưu bản nháp · sửa/xóa/thêm trước khi nhập</div>
        </div>
        <span style={{ fontSize: 10, color: C.green }}>● Tự động lưu</span>
        <button type="button" onClick={onClose} style={{ border: 0, background: 'transparent', color: C.text2, fontSize: 22, cursor: 'pointer' }}>×</button>
      </div>

      <div style={{ padding: '10px 13px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Btn variant="primary" disabled={loading || inputting || selectedCards.length === 0} onClick={() => onPreview?.(selectedCards)} style={{ fontSize: 11, padding: '5px 9px' }}>
          {loading ? <><Spinner size={10} /> Đang quét...</> : `Quét VTYT đã chọn (${selectedCards.length})`}
        </Btn>
        <Btn variant="solidSuccess" disabled={loading || inputting || !draft || !allReviewed || !draft?.precheck_token || precheckExpired} onClick={onInput} style={{ fontSize: 11, padding: '5px 9px' }}>
          {inputting ? <><Spinner size={10} /> Đang nhập...</> : 'Nhập hàng loạt'}
        </Btn>
        <Btn variant="danger" disabled={loading || inputting || !draft} onClick={onClear} style={{ fontSize: 11, padding: '5px 9px' }}>Xóa bản nháp</Btn>
        {draft?.precheck_expires_at && <span style={{ fontSize: 10, color: precheckExpired ? C.red : C.text3 }}>{precheckExpired ? 'Quyền nhập đã hết hạn; quét lại để giữ các chỉnh sửa và cấp quyền mới.' : `Quyền nhập một lần hết hạn: ${new Date(draft.precheck_expires_at).toLocaleString('vi-VN')}`}</span>}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 12, display: 'grid', gap: 10, alignContent: 'start' }}>
        {!draft && (
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ padding: '8px 10px', background: C.surface2, display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={selectableCards.length > 0 && selectedIds.size === selectableCards.length} onChange={e => toggleAll(e.target.checked)} />
              <b style={{ fontSize: 11 }}>Chọn người bệnh cần quét</b>
              <span style={{ marginLeft: 'auto', fontSize: 10, color: C.text3 }}>{selectedIds.size}/{selectableCards.length} người bệnh</span>
            </div>
            <div style={{ maxHeight: 'calc(100vh - 210px)', overflow: 'auto' }}>
              {selectableCards.map(card => {
                const id = patientId(card);
                return <label key={id} style={{ display: 'grid', gridTemplateColumns: '28px 1fr 130px', gap: 8, padding: '8px 10px', borderTop: `1px solid ${C.border2}`, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={selectedIds.has(id)} onChange={e => setSelectedIds(previous => { const next = new Set(previous); if (e.target.checked) next.add(id); else next.delete(id); return next; })} />
                  <div><b style={{ fontSize: 11 }}>{card.ho_ten || id}</b><div style={{ fontSize: 9, color: C.text3 }}>Mã BN {id}</div></div>
                  <div style={{ fontSize: 9, color: C.text2 }}>{card.admission_time || card?.profile?.ngay_vao_vien || 'Chưa rõ ngày vào'}</div>
                </label>;
              })}
            </div>
          </div>
        )}

        {draft && <>
          <div style={{ padding: '8px 10px', borderRadius: 8, background: allReviewed ? C.greenBg : C.amberBg, border: `1px solid ${allReviewed ? C.greenBorder : C.amberBorder}`, fontSize: 10, color: allReviewed ? C.green : C.amber }}>
            {allReviewed ? 'Tất cả người bệnh đã được xác nhận kế hoạch; có thể nhập hàng loạt.' : 'Cần kiểm và đánh dấu “Đã kiểm kế hoạch” cho từng người bệnh trước khi nhập.'}
          </div>
          {safeArray(draft.patients).map(patient => (
            <PatientPlan key={patient.ma_bn} patient={patient} jobs={patientJobs.get(String(patient.ma_bn)) || []} draft={draft} setDraft={setDraft} />
          ))}
          {Object.keys(draft.failed || {}).length > 0 && (
            <div style={{ padding: 10, borderRadius: 8, background: C.redBg, border: `1px solid ${C.redBorder}`, color: C.red, fontSize: 10 }}>
              Có {Object.keys(draft.failed).length} BN/ngày quét lỗi. Cần kiểm tra log hoặc quét lại trước khi nhập.
            </div>
          )}
        </>}
      </div>
    </div>
  );
}
