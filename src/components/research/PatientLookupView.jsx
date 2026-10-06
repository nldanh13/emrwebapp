// Tra cứu người bệnh trong kho gốc (lịch sử các đợt, XN/CĐHA/thuốc/phẫu thuật).
import { useState } from 'react';
import * as api from '../../api.js';
import { C, FS } from '../../tokens.js';
import { inp, EmptyState, StatBadge } from './researchUi.jsx';
import { text } from './researchFormat.js';
import { Btn, Spinner } from '../shared.jsx';
import { IdentifiedLockNotice } from './IdentifiedLockNotice.jsx';
import { EncounterHistoryCard } from './ResearchMonitor.jsx';

const PATIENT_CODE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_DIRECT_PATIENTS = 200;

function parsePatientCodes(raw) {
  const seen = new Set();
  const codes = [];
  for (const item of String(raw || '').split(/[\s,;]+/)) {
    const code = item.trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

export function PatientLookupView({
  identifiedAccess, identifiedLocked, loadPatientHistory, patientHistory, patientHistoryError,
  patientHistoryLoading, patientHistoryMeta, patientQuery, setPatientQuery,
}) {
  const [directPatientCodes, setDirectPatientCodes] = useState('');
  const [directState, setDirectState] = useState({ loading: false, message: '', error: '' });
  const parsedDirectCodes = parsePatientCodes(directPatientCodes);

  const collectDirectPatients = async () => {
    const codes = parsePatientCodes(directPatientCodes);
    if (!codes.length) {
      setDirectState({ loading: false, message: '', error: 'Nhập ít nhất một Mã BN cần lấy dữ liệu.' });
      return;
    }
    if (codes.length > MAX_DIRECT_PATIENTS) {
      setDirectState({ loading: false, message: '', error: `Mỗi lần chỉ lấy tối đa ${MAX_DIRECT_PATIENTS} Mã BN.` });
      return;
    }
    if (codes.some(code => !PATIENT_CODE_RE.test(code))) {
      setDirectState({ loading: false, message: '', error: 'Danh sách có Mã BN không hợp lệ.' });
      return;
    }

    setDirectState({ loading: true, message: '', error: '' });
    try {
      const r = await api.collectResearchAuto('', { patientCodes: codes, headless: true });
      if (codes.length === 1) setPatientQuery(codes[0]);
      const missing = Number(r?.missing_count || 0);
      const base = r?.message || `Đã nhận ${codes.length} Mã BN. Máy chủ sẽ lấy lần lượt từng ca.`;
      setDirectState({
        loading: false,
        message: missing ? `${base} Có ${missing} mã chưa có trong danh sách đã quét.` : base,
        error: '',
      });
    } catch (e) {
      setDirectState({ loading: false, message: '', error: String(e?.message || e) });
    }
  };

  return <div style={{ padding: '10px 12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div style={{ background: C.surface, padding: '2px 0 10px', borderBottom: `1px solid ${C.border2}` }}>
      <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>Tra cứu người bệnh</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <input value={patientQuery} disabled={identifiedLocked} onChange={e => setPatientQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') loadPatientHistory(); }} placeholder="Mã BN, họ tên, mã NC hoặc chẩn đoán" style={{ ...inp, flex: '1 1 320px' }} />
        <Btn variant="primary" onClick={() => loadPatientHistory()} disabled={identifiedLocked || patientHistoryLoading || !text(patientQuery)} style={{ height: 28 }}>
          {patientHistoryLoading ? <><Spinner size={9} /> Đang tìm</> : 'Tìm'}
        </Btn>
      </div>
      {patientHistoryMeta && !patientHistoryLoading && (
        <div style={{ marginTop: 6, fontSize: FS.xs, color: C.text3 }}>
          {patientHistoryMeta.source ? `Nguồn: ${patientHistoryMeta.source.toUpperCase()} · ` : ''}{(patientHistoryMeta.elapsedMs / 1000).toFixed(2)} giây
          {patientHistory?.selection_required ? ` · Tìm thấy ${patientHistoryMeta.matched} kết quả; chọn đúng người bệnh để mở chi tiết.` : ''}
          {patientHistoryMeta.truncated ? ` · Hiển thị ${Math.min(30, patientHistoryMeta.matched)} kết quả đầu.` : ''}
        </div>
      )}

      <div style={{ marginTop: 10, paddingTop: 9, borderTop: `1px solid ${C.border2}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: FS.xs, color: C.text2 }}>
          <b>Lấy trực tiếp từ EMR theo Mã BN</b> · có thể dán một hoặc nhiều Mã BN, mỗi dòng một mã. Hệ thống lấy Hồ sơ nền, Ra viện, Phẫu thuật, Y lệnh, XN và CĐHA theo đúng thứ tự đã dán.
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <textarea
            value={directPatientCodes}
            disabled={identifiedLocked || directState.loading}
            onChange={e => setDirectPatientCodes(e.target.value)}
            onKeyDown={e => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !directState.loading) collectDirectPatients();
            }}
            placeholder={'Dán Mã BN, mỗi dòng một mã\nVí dụ:\n26000001\n26000002'}
            autoComplete="off"
            rows={5}
            style={{ ...inp, width: 260, minHeight: 92, resize: 'vertical', paddingTop: 7, paddingBottom: 7 }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
            <Btn
              variant="solidPrimary"
              onClick={collectDirectPatients}
              disabled={identifiedLocked || directState.loading || !parsedDirectCodes.length}
              style={{ height: 28, padding: '0 12px' }}
            >
              {directState.loading
                ? <><Spinner size={9} /> Đang gửi</>
                : parsedDirectCodes.length > 1
                  ? `Lấy ${parsedDirectCodes.length} ca này`
                  : 'Lấy ca này'}
            </Btn>
            <span style={{ fontSize: FS.xs, color: C.text3 }}>
              {parsedDirectCodes.length ? `${parsedDirectCodes.length} mã hợp lệ sau khi loại trùng · ` : ''}Ctrl+Enter để gửi. Server chạy tuần tự ở nền; không cần giữ tab mở.
            </span>
          </div>
        </div>
        {directState.message && <div style={{ fontSize: FS.xs, color: C.green }}>{directState.message}</div>}
        {directState.error && <div style={{ fontSize: FS.xs, color: C.red }}><b>Không lấy được:</b> {directState.error}</div>}
      </div>
    </div>

    {identifiedLocked && <IdentifiedLockNotice {...{ identifiedAccess }} />}
    {!identifiedLocked && patientHistoryError && (
      <div style={{ border: `1px solid ${C.redBorder}`, background: C.redBg, color: C.red, borderRadius: 7, padding: '8px 10px', fontSize: FS.xs }}>
        <b>Không tra cứu được:</b> {patientHistoryError}
      </div>
    )}
    {!patientHistoryLoading && patientHistory?.selection_required && !!patientHistory?.candidates?.length && (
      <div style={{ borderTop: `1px solid ${C.border2}`, borderBottom: `1px solid ${C.border2}`, background: C.surface, overflow: 'hidden' }}>
        <div style={{ padding: '8px 10px', borderBottom: `1px solid ${C.border2}` }}>
          <div style={{ fontSize: FS.xs, fontWeight: 700, color: C.text }}>Chọn người bệnh</div>
          <div style={{ marginTop: 2, fontSize: FS.xs, color: C.text3 }}>
            Từ khóa khớp nhiều hồ sơ. Chỉ khi chọn một BN hệ thống mới tải XN/CĐHA/thuốc/PT chi tiết.
          </div>
        </div>
        <div style={{ maxHeight: 420, overflow: 'auto' }}>
          {(patientHistory.candidates || []).map((cand, ci) => {
            const exactQuery = cand.patient_code || cand.research_code;
            return (
              <button
                key={`${cand.patient_code || cand.research_code}_${ci}`}
                type="button"
                onClick={() => {
                  if (!exactQuery) return;
                  setPatientQuery(exactQuery);
                  loadPatientHistory(exactQuery);
                }}
                style={{
                  width: '100%', border: 0, borderBottom: `1px solid ${C.border2}`,
                  background: C.surface, padding: '9px 11px', textAlign: 'left',
                  cursor: 'pointer', display: 'flex', alignItems: 'center',
                  justifyContent: 'space-between', gap: 10,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = C.surface2; }}
                onMouseLeave={e => { e.currentTarget.style.background = C.surface; }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: FS.xs, fontWeight: 700, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {cand.patient_name || 'Chưa rõ họ tên'}
                  </div>
                  <div style={{ marginTop: 2, fontSize: FS.xs, color: C.text3 }}>
                    BN {cand.patient_code || '—'}{cand.research_code ? ` · NC ${cand.research_code}` : ''}
                    {cand.sex ? ` · ${cand.sex}` : ''}{cand.age ? ` · ${cand.age} tuổi` : ''}
                  </div>
                </div>
                <span style={{ fontSize: FS.xs, color: C.blue, fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {cand.encounter_count || 0} đợt · Xem
                </span>
              </button>
            );
          })}
        </div>
      </div>
    )}

    {patientHistoryLoading && patientHistory?.patients?.length ? (
      <div style={{ fontSize: FS.xs, color: C.blue }}><Spinner size={9} /> Đang cập nhật kết quả; dữ liệu cũ vẫn được giữ để xem.</div>
    ) : null}
    {patientHistoryLoading && !patientHistory?.patients?.length && <div style={{ padding: 14, color: C.text2 }}><Spinner size={11} /> Đang tra cứu...</div>}
    {!patientHistoryLoading && patientHistory && !patientHistory.selection_required && !patientHistory.patients?.length && !patientHistoryError && <EmptyState title="Không tìm thấy" hint="Thử mã BN/mã NC hoặc họ tên chính xác hơn." />}

    {patientHistory?.patients?.map((p, pi) => (
      <div key={`${p.patient_code}_${pi}`} style={{ borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, background: C.surface, overflow: 'hidden' }}>
        <div style={{ padding: '9px 11px', borderBottom: `1px solid ${C.border2}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>{p.patient_name || 'Người bệnh'} <span style={{ color: C.text3, fontWeight: 600 }}>· BN {(p.patient_codes?.length ? p.patient_codes.join(', ') : p.patient_code) || '—'}</span></div>
            <div style={{ marginTop: 2, fontSize: FS.xs, color: C.text3 }}>{p.sex || '—'} · {p.age ? `${p.age} tuổi` : 'chưa rõ tuổi'}{p.first_research_code ? ` · NC ${p.first_research_code}` : ''}</div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <StatBadge label="Đợt" value={p.encounter_count || 0} tone="info" />
            {Number(p.unassigned_count || 0) > 0 && <StatBadge label="Chưa ghép đợt" value={p.unassigned_count} tone="warn" />}
          </div>
        </div>
        <div style={{ display: 'grid', gap: 7, padding: 9 }}>
          {(p.encounters || []).map((enc, ei) => <EncounterHistoryCard key={`${enc.encounter_id}_${ei}`} enc={enc} index={ei} />)}
        </div>
      </div>
    ))}
  </div>;
}
