import { useEffect, useMemo, useRef, useState } from 'react';
import { C, mono } from '../tokens.js';
import { Btn, Badge, Spinner } from './shared.jsx';
import * as api from '../api.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const DEFAULT_LOGIN_URL = import.meta.env.VITE_EMR_LOGIN_URL || '';
const DEFAULT_LIST_URL = import.meta.env.VITE_EMR_CLINIC_LIST_URL || '';
const DEFAULT_CARE_DEPARTMENT = 'Khoa Khám Bệnh';

function localIsoDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function careRowKey(row = {}, index = 0) {
  const stayId = String(row.noitruid || '').trim();
  if (stayId) return `stay:${stayId}`;
  const patientTime = `${String(row.ma_bn || '').trim()}::${String(row.care_time_str || row.tg_vao || '').trim()}`;
  return patientTime !== '::' ? `patient:${patientTime}` : `row:${index}`;
}

const DEFAULT_DOCTOR_KEYWORDS = 'tiêm khớp, chọc hút, nắn chỉnh, bó bột, rạch, khâu, tiểu phẫu';
const DEFAULT_NURSE_KEYWORDS = 'thay băng, cắt chỉ, băng, nẹp';

const fieldStyle = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 5,
  border: `1px solid ${C.border}`, background: C.surface, color: C.text,
  fontFamily: 'inherit', fontSize: 12, outline: 'none',
};

function Label({ children }) {
  return <div style={{ fontSize: 11, color: C.text3, fontWeight: 800, marginBottom: 4 }}>{children}</div>;
}

function Card({ title, right, children, style = {} }) {
  return (
    <div style={{ background: C.surface, borderTop: `1px solid ${C.border2}`, overflow: 'hidden', ...style }}>
      <div style={{ padding: '8px 2px', borderBottom: `1px solid ${C.border2}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontWeight: 850, fontSize: 13 }}>{title}</div>
        {right}
      </div>
      <div style={{ padding: '10px 2px' }}>{children}</div>
    </div>
  );
}

function SubTabButton({ active, children, onClick }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        border: 'none',
        borderBottom: `2px solid ${active ? C.blue : 'transparent'}`,
        background: 'transparent',
        color: active ? C.text : C.text3,
        borderRadius: 0,
        padding: '8px 10px',
        fontFamily: 'inherit',
        fontSize: 12,
        fontWeight: 850,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function asBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Không đọc được file'));
    reader.readAsDataURL(file);
  });
}

function StatusBadge({ status }) {
  const s = String(status || 'Không rõ');
  const n = s.toLowerCase();
  if (n.includes('treo')) return <Badge text={s} bg={C.redBg} color={C.red} />;
  if (n.includes('hoàn tất') || n.includes('tất toán')) return <Badge text={s} bg={C.greenBg} color={C.green} />;
  if (n.includes('đang')) return <Badge text={s} bg={C.blueBg} color={C.blue} />;
  if (n.includes('chờ')) return <Badge text={s} bg={C.amberBg} color={C.amber} />;
  return <Badge text={s} bg={C.surface2} color={C.text2} />;
}

function ProcedureBadge({ row }) {
  if (row?.needs_procedure) {
    return <Badge text={`Cần nhập TT ${row.tt_text || ''}`.trim()} bg={C.amberBg} color={C.amber} />;
  }
  if (row?.skip_status) return <Badge text={row.skip_reason || 'Bỏ qua'} bg={C.surface2} color={C.text3} />;
  if (row?.tt_total > 0) return <Badge text={`TT đủ ${row.tt_done}/${row.tt_total}`} bg={C.greenBg} color={C.green} />;
  return <Badge text="Không có TT thiếu" bg={C.surface2} color={C.text3} />;
}

function CarePatientPreviewCard({
  row,
  rowKey,
  edit,
  careContent,
  needsVitals,
  disabled,
  onChange,
  onSave,
  onToggleSuggestion,
}) {
  const hasLink = Boolean(row?.has_nursing_link || row?.nursing_url || row?.noitruid);
  const effectiveNurse = String(row?.dieu_duong || '').trim();
  const canInput = hasLink && Boolean(effectiveNurse);
  const saved = Boolean(edit?.saved);
  const draft = String(edit?.draft ?? '');
  const orderInfo = edit?.orderInfo || null;
  const useSuggestion = Boolean(edit?.useSuggestion && orderInfo?.seed_dien_bien);
  const orderError = String(edit?.orderError || '').trim();

  return (
    <div style={{
      borderTop: `1px solid ${saved ? (C.greenBorder || C.green) : C.border2}`,
      borderBottom: `1px solid ${C.border2}`,
      borderRadius: 0,
      background: C.surface,
      padding: '10px 2px',
      display: 'grid',
      gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 14, fontWeight: 850 }}>{row.ho_ten || 'Chưa có tên người bệnh'}</div>
            {saved && <Badge text="Đã lưu để nhập" bg={C.greenBg} color={C.green} />}
            {!saved && canInput && <Badge text="Chưa lưu" bg={C.amberBg} color={C.amber} />}
            {!hasLink && <Badge text="Thiếu liên kết Điều dưỡng" bg={C.redBg} color={C.red} />}
            {hasLink && !effectiveNurse && <Badge text="Chưa xác định điều dưỡng" bg={C.redBg} color={C.red} />}
          </div>
          <div style={{ marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ ...mono, fontSize: 11, color: C.text2 }}>Mã BN: {row.ma_bn || '—'}</span>
            <Badge text={row.care_time_str || row.tg_vao || 'Chưa có T/G vào'} bg={C.blueBg} color={C.blue} />
            <span style={{ fontSize: 11, color: C.text3 }}>{row.khoa_chuyen_den || 'Khoa Khám Bệnh'} · Không cần xếp phòng</span>
          </div>
        </div>
        <Btn
          variant={saved ? 'solidSuccess' : 'primary'}
          disabled={disabled || !canInput || !draft.trim()}
          onClick={() => onSave(rowKey)}
        >
          {saved ? 'Đã lưu' : 'Lưu người bệnh này'}
        </Btn>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(210px, 250px) 1fr', gap: 10, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ borderLeft: `2px solid ${C.border2}`, borderRadius: 0, background: C.surface, padding: '7px 9px' }}>
            <Label>Thông tin nhập</Label>
            <div style={{ display: 'grid', gap: 6, fontSize: 12 }}>
              <div><span style={{ color: C.text3 }}>Điều dưỡng:</span> <b>{effectiveNurse || 'Chưa xác định'}</b></div>
              <div><span style={{ color: C.text3 }}>Thời gian phiếu:</span> <b style={{ color: C.blue }}>{row.care_time_str || row.tg_vao || '—'}</b></div>
              <div><span style={{ color: C.text3 }}>Dấu hiệu sinh tồn:</span> <b>{needsVitals ? 'Có lấy' : 'Không lấy'}</b></div>
            </div>
          </div>

          <div style={{ borderLeft: `2px solid ${C.border2}`, borderRadius: 0, background: C.surface, padding: '7px 9px' }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, cursor: orderInfo ? 'pointer' : 'default' }}>
              <input
                type="checkbox"
                checked={useSuggestion}
                disabled={disabled || !orderInfo?.seed_dien_bien}
                onChange={event => onToggleSuggestion(rowKey, event.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span>
                <b>Dùng vị trí đau gợi ý từ y lệnh đầu tiên</b>
                <div style={{ color: C.text3, fontSize: 11, marginTop: 3, lineHeight: 1.4 }}>
                  {orderInfo?.pain_location
                    ? `Vị trí đau: ${orderInfo.pain_location}${orderInfo.tg_ylenh ? ` · ${orderInfo.tg_ylenh}` : ''}`
                    : (orderInfo ? 'Không nhận diện được vị trí đau trong diễn biến y lệnh đầu tiên.' : 'Chưa lấy y lệnh chung cho danh sách.')}
                </div>
              </span>
            </label>
            {orderError && <div style={{ marginTop: 6, fontSize: 11, color: C.red }}>{orderError}</div>}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 10 }}>
          <div>
            <Label>Nội dung chăm sóc sẽ nhập</Label>
            <div style={{ ...fieldStyle, minHeight: 34, whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>
              {careContent || '—'}
            </div>
          </div>
          <div>
            <Label>Diễn biến của người bệnh</Label>
            <textarea
              value={draft}
              onChange={event => onChange(rowKey, event.target.value)}
              rows={6}
              disabled={disabled || !canInput}
              style={{ ...fieldStyle, resize: 'vertical', lineHeight: 1.45, background: !canInput ? C.surface2 : C.surface }}
            />
            <div style={{ color: C.text3, fontSize: 11, marginTop: 4 }}>
              Bỏ chọn nếu gợi ý vị trí đau không phù hợp.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Summary({ data }) {
  const items = Object.entries(data?.summary?.by_status || {});
  if (!data) return null;
  const ps = data.procedure_summary || {};
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <Badge text={`Tổng: ${data.summary?.total ?? data.rows?.length ?? 0}`} bg={C.surface2} color={C.text} />
      {data.target_count != null && <Badge text={`Mã BN: ${data.target_count}`} bg={(C.purple || C.blue) + '22'} color={C.purple || C.blue} />}
      <Badge text={`Cần nhập TT: ${ps.actionable_count || 0}`} bg={ps.actionable_count ? C.amberBg : C.greenBg} color={ps.actionable_count ? C.amber : C.green} />
      <Badge text={`Bỏ qua TT/HT/Treo: ${ps.skipped_status_count || 0}`} bg={C.surface2} color={C.text2} />
      {items.slice(0, 4).map(([k, v]) => <Badge key={k} text={`${k}: ${v}`} bg={C.blueBg} color={C.blue} />)}
    </div>
  );
}

function ResultTable({ rows = [] }) {
  if (!rows.length) {
    return <div style={{ color: C.text3, fontSize: 12 }}>Chưa có dòng kết quả.</div>;
  }
  return (
    <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 390px)', border: `1px solid ${C.border2}`, borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead style={{ position: 'sticky', top: 0, background: C.surface2, zIndex: 1 }}>
          <tr>
            {['Mã BN', 'Họ tên', 'Thời gian', 'Trạng thái', 'Kết quả DV', 'Tên chỉ định TT', 'TT', 'Thủ thuật viên', 'Xử trí', 'Nơi thực hiện'].map(h => (
              <th key={h} style={{ padding: '7px 8px', textAlign: 'left', borderBottom: `1px solid ${C.border}` }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={`${r.ma_bn || 'row'}_${idx}`} style={{ borderBottom: `1px solid ${C.border2}`, background: r.needs_procedure ? C.amberBg : 'transparent' }}>
              <td style={{ padding: '7px 8px', ...mono }}>{r.ma_bn || ''}</td>
              <td style={{ padding: '7px 8px', minWidth: 160 }}>{r.ho_ten || r.excel_ho_ten || ''}</td>
              <td style={{ padding: '7px 8px', whiteSpace: 'nowrap' }}>{r.thoi_gian || ''}</td>
              <td style={{ padding: '7px 8px', whiteSpace: 'nowrap' }}><StatusBadge status={r.trang_thai || ''} /></td>
              <td style={{ padding: '7px 8px', minWidth: 100 }}>{r.ket_qua_dich_vu || ''}</td>
              <td style={{ padding: '7px 8px', minWidth: 260 }}>
                <div style={{ fontWeight: r.needs_procedure ? 900 : 600 }}>{r.procedure_service_name || ''}</div>
                {(r.procedure_order_time || r.procedure_order_status || r.procedure_order_parent_name) && (
                  <div style={{ color: C.text3, fontSize: 11, marginTop: 2 }}>
                    {r.procedure_order_time || ''}{r.procedure_order_status ? ` · ${r.procedure_order_status}` : ''}{r.procedure_order_parent_name ? ` · ${r.procedure_order_parent_name}` : ''}
                  </div>
                )}
                {r.procedure_detail_error && <div style={{ color: C.red, fontSize: 11, marginTop: 2 }}>{r.procedure_detail_error}</div>}
              </td>
              <td style={{ padding: '7px 8px', minWidth: 145 }}><ProcedureBadge row={r} /></td>
              <td style={{ padding: '7px 8px', minWidth: 170 }}>
                {r.needs_procedure ? (
                  <div>
                    <div style={{ fontWeight: 800 }}>{r.procedure_performer_name || '(chưa nhập lịch khoa)'}</div>
                    <div style={{ color: C.text3, fontSize: 11 }}>{r.procedure_performer_role_label || ''}{r.procedure_performer_keyword ? ` · ${r.procedure_performer_keyword}` : ''}</div>
                  </div>
                ) : <span style={{ color: C.text3 }}>—</span>}
              </td>
              <td style={{ padding: '7px 8px', whiteSpace: 'nowrap' }}>{r.xu_tri || ''}</td>
              <td style={{ padding: '7px 8px', minWidth: 220 }}>{r.noi_thuc_hien || r.excel_phong_kham || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ClinicTab({ toast }) {
  const [activeSection, setActiveSection] = useState('operations');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginUrl, setLoginUrl] = useState(DEFAULT_LOGIN_URL);
  const [listUrl, setListUrl] = useState(DEFAULT_LIST_URL);
  const [manualCodes, setManualCodes] = useState('');
  const [excel, setExcel] = useState(null);
  const [headless, setHeadless] = useState(true);
  const [doctorMorningName, setDoctorMorningName] = useState('');
  const [doctorAfternoonName, setDoctorAfternoonName] = useState('');
  const [nurseName, setNurseName] = useState('');
  const [afternoonStartHour, setAfternoonStartHour] = useState('12');
  const [defaultRole, setDefaultRole] = useState('nurse');
  const [doctorKeywords, setDoctorKeywords] = useState(DEFAULT_DOCTOR_KEYWORDS);
  const [nurseKeywords, setNurseKeywords] = useState(DEFAULT_NURSE_KEYWORDS);
  const [procedureTemplateName, setProcedureTemplateName] = useState('CTCH-thay băng');
  const [procedureDurationMinutes, setProcedureDurationMinutes] = useState('10');
  const [loading, setLoading] = useState(false);
  const [inputLoading, setInputLoading] = useState(false);
  const [careLoading, setCareLoading] = useState(false);
  const [carePreviewLoading, setCarePreviewLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [carePreview, setCarePreview] = useState(null);
  const [careEdits, setCareEdits] = useState({});
  const [careOrdersLoading, setCareOrdersLoading] = useState(false);
  const [careDraftReady, setCareDraftReady] = useState(false);
  const [careDraftSaving, setCareDraftSaving] = useState(false);
  const [careDraftSavedAt, setCareDraftSavedAt] = useState('');
  const [careDraftError, setCareDraftError] = useState('');
  const careDraftLoadCancelled = useRef(false);
  const [careDate, setCareDate] = useState(localIsoDate);
  const [targetDepartment] = useState(DEFAULT_CARE_DEPARTMENT);
  const [careContent, setCareContent] = useState('Hoàn tất hồ sơ nhập viện + Kính chuyển Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh + Hồ sơ');
  const [dienBien, setDienBien] = useState('Phòng khám Chấn thương chỉnh hình - Thần kinh nhận\nNgười bệnh tỉnh\nTiếp xúc tốt\nDa niêm hồng\nMạch rõ, chi ấm\nĐau vùng tổn thương\nVận động hạn chế\nTiền sử dị ứng thuốc chưa ghi nhận');
  const [needsVitals, setNeedsVitals] = useState(false);

  useEffect(() => {
    careDraftLoadCancelled.current = false;
    (async () => {
      try {
        const data = await api.getClinicCareDraft();
        if (careDraftLoadCancelled.current) return;
        const draft = data?.draft;
        if (draft && typeof draft === 'object') {
          if (draft.careDate) setCareDate(String(draft.careDate));
          if (typeof draft.careContent === 'string' && draft.careContent) setCareContent(draft.careContent);
          if (typeof draft.dienBien === 'string' && draft.dienBien) setDienBien(draft.dienBien);
          setNeedsVitals(Boolean(draft.needsVitals));
          setCarePreview(draft.carePreview && typeof draft.carePreview === 'object' ? draft.carePreview : null);
          setCareEdits(draft.careEdits && typeof draft.careEdits === 'object' ? draft.careEdits : {});
          setCareDraftSavedAt(String(draft.saved_at || ''));
          if (draft.carePreview?.rows?.length) setActiveSection('care');
        }
      } catch (e) {
        if (!careDraftLoadCancelled.current) setCareDraftError(String(e.message || e));
      } finally {
        if (!careDraftLoadCancelled.current) setCareDraftReady(true);
      }
    })();
    return () => { careDraftLoadCancelled.current = true; };
  }, []);

  useEffect(() => {
    if (!careDraftReady) return undefined;
    const clientUpdatedAt = Date.now();
    const timer = window.setTimeout(async () => {
      setCareDraftSaving(true);
      try {
        const data = await api.saveClinicCareDraft({
          client_updated_at: clientUpdatedAt,
          careDate,
          targetDepartment,
          careContent,
          dienBien,
          needsVitals,
          carePreview,
          careEdits,
        });
        setCareDraftSavedAt(String(data?.saved_at || new Date().toISOString()));
        setCareDraftError('');
      } catch (e) {
        setCareDraftError(String(e.message || e));
      } finally {
        setCareDraftSaving(false);
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [careDraftReady, careDate, targetDepartment, careContent, dienBien, needsVitals, carePreview, careEdits]);

  const canRun = username.trim() && password && loginUrl.trim() && listUrl.trim();
  const codeCount = useMemo(() => String(manualCodes || '').split(/[\s,;]+/).filter(Boolean).length, [manualCodes]);
  const actionRows = useMemo(() => (result?.rows || []).filter(r => r?.needs_procedure), [result]);

  const careRows = useMemo(() => carePreview?.rows || [], [carePreview]);
  const careActionRows = useMemo(() => careRows.filter(r => (
    Boolean(r?.has_nursing_link || r?.nursing_url || r?.noitruid)
    && Boolean(String(r?.dieu_duong || '').trim())
  )), [careRows]);
  const careSavedRows = useMemo(() => careActionRows
    .map((row, index) => {
      const key = careRowKey(row, index);
      const edit = careEdits[key];
      if (!edit?.saved || !String(edit.savedValue || '').trim()) return null;
      return {
        ...row,
        dien_bien: String(edit.savedValue || '').trim(),
        saved_for_input: true,
      };
    })
    .filter(Boolean), [careActionRows, careEdits]);
  const allCareRowsSaved = careActionRows.length > 0 && careSavedRows.length === careActionRows.length;
  const canRunCare = Boolean(careDate);

  function invalidateCarePreview() {
    setCarePreview(null);
    setCareEdits({});
  }

  function changeCareDienBien(rowKey, value) {
    setCareEdits(previous => ({
      ...previous,
      [rowKey]: {
        ...(previous[rowKey] || {}),
        draft: value,
        saved: false,
      },
    }));
  }

  function saveCarePatient(rowKey) {
    const draft = String(careEdits[rowKey]?.draft || '').trim();
    if (!draft) {
      toast?.('Diễn biến không được để trống.', 'error');
      return;
    }
    setCareEdits(previous => ({
      ...previous,
      [rowKey]: {
        ...(previous[rowKey] || {}),
        draft,
        savedValue: draft,
        saved: true,
      },
    }));
  }

  async function previewCare() {
    if (!canRunCare) {
      toast?.('Thiếu ngày T/G vào.', 'error');
      return;
    }
    setCarePreviewLoading(true);
    setCarePreview(null);
    try {
      const data = await api.runClinicCarePreview({
        careDate, targetDepartment,
        careContent, dienBien, needsVitals,
      });
      setCarePreview(data);
      setCareEdits(previous => {
        const initialEdits = {};
        (Array.isArray(data?.rows) ? data.rows : []).forEach((row, index) => {
          if (!Boolean(row?.has_nursing_link || row?.nursing_url || row?.noitruid)) return;
          if (!String(row?.dieu_duong || '').trim()) return;
          const key = careRowKey(row, index);
          const existing = previous[key];
          initialEdits[key] = existing ? {
            draft: String(existing.draft || dienBien),
            savedValue: String(existing.savedValue || ''),
            saved: Boolean(existing.saved && String(existing.savedValue || '').trim()),
            orderInfo: existing.orderInfo || null,
            orderError: String(existing.orderError || ''),
            useSuggestion: Boolean(existing.useSuggestion),
          } : {
            draft: dienBien,
            savedValue: '',
            saved: false,
            orderInfo: null,
            orderError: '',
            useSuggestion: false,
          };
        });
        return initialEdits;
      });
      toast?.(data.message || 'Đã tìm người bệnh cần nhập chăm sóc.', 'ok');
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setCarePreviewLoading(false);
    }
  }

  function toggleCareSuggestion(rowKey, checked) {
    setCareEdits(previous => {
      const current = previous[rowKey] || {};
      const seed = String(current.orderInfo?.suggested_dien_bien || current.orderInfo?.seed_dien_bien || '').trim();
      const currentDraft = String(current.draft || '');
      let nextDraft = currentDraft;
      if (checked && seed) nextDraft = seed;
      if (!checked && seed && currentDraft.trim() === seed) nextDraft = dienBien;
      return {
        ...previous,
        [rowKey]: {
          ...current,
          useSuggestion: checked && Boolean(seed),
          draft: nextDraft,
          saved: false,
        },
      };
    });
  }

  async function fetchAllOrderSeeds() {
    if (!careActionRows.length) {
      toast?.('Chưa có danh sách người bệnh phù hợp để lấy y lệnh.', 'error');
      return;
    }
    setCareOrdersLoading(true);
    try {
      const rows = careActionRows.map((row, index) => ({
        ...row,
        client_key: careRowKey(row, index),
      }));
      const data = await api.runClinicCareOrderSeeds({
        careDate,
        targetDepartment,
        dienBien,
        rows,
      });
      const byKey = new Map((Array.isArray(data?.results) ? data.results : []).map(item => [String(item?.row_key || ''), item]));
      setCareEdits(previous => {
        const next = { ...previous };
        careActionRows.forEach((row, index) => {
          const key = careRowKey(row, index);
          const item = byKey.get(key);
          const current = next[key] || {};
          const suggestion = String(item?.suggested_dien_bien || item?.seed_dien_bien || '').trim();
          if (item?.success && suggestion) {
            next[key] = {
              ...current,
              draft: suggestion,
              saved: false,
              useSuggestion: true,
              orderError: '',
              orderInfo: {
                ...(item.first_order || {}),
                pain_location: String(item.pain_location || '').trim(),
                suggested_dien_bien: suggestion,
                seed_dien_bien: suggestion,
                total_orders: Number(item.total_orders || 0),
              },
            };
          } else {
            next[key] = {
              ...current,
              draft: String(current.draft || dienBien),
              saved: false,
              useSuggestion: false,
              orderInfo: item?.success ? {
                ...(item.first_order || {}),
                pain_location: '',
                suggested_dien_bien: '',
                seed_dien_bien: '',
                total_orders: Number(item.total_orders || 0),
              } : null,
              orderError: String(item?.error || 'Không lấy được y lệnh đầu tiên.'),
            };
          }
        });
        return next;
      });
      toast?.(data?.message || 'Đã lấy y lệnh đầu tiên cho danh sách.', data?.status === 'error' ? 'error' : (data?.status === 'partial' ? 'info' : 'ok'));
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setCareOrdersLoading(false);
    }
  }

  async function inputCare() {
    if (!canRunCare) { toast?.('Thiếu ngày T/G vào.', 'error'); return; }
    if (!careActionRows.length) { toast?.('Chưa có người bệnh phù hợp có liên kết điều dưỡng.', 'error'); return; }
    if (!allCareRowsSaved) { toast?.('Cần xem, chỉnh và lưu diễn biến của tất cả người bệnh trước khi nhập.', 'error'); return; }
    if (!carePreview?.precheck_token) { toast?.('Kết quả quét đã hết hiệu lực. Hãy tìm lại người bệnh phù hợp trước khi nhập.', 'error'); return; }
    const ok = window.confirm(`Sẽ quét lại điều kiện và nhập chăm sóc cho ${careSavedRows.length} người bệnh theo đúng nội dung đã lưu riêng từng người. Thời gian phiếu bằng đúng T/G vào. Xác nhận quét chỉ dùng một lần. Tiếp tục?`);
    if (!ok) return;
    setCareLoading(true);
    try {
      const data = await api.runClinicInputCare({
        careDate, targetDepartment,
        careContent, dienBien, needsVitals,
        precheck_token: carePreview.precheck_token,
        rows: careSavedRows,
      });
      toast?.(data.message || 'Đã chạy nhập chăm sóc phòng khám.', data.status === 'ok' ? 'ok' : 'info');
      if (data.status === 'ok') {
        await api.clearClinicCareDraft();
        setCarePreview(null);
        setCareEdits({});
        setCareDraftSavedAt('');
      }
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setCareLoading(false);
    }
  }

  const clinicSchedule = useMemo(() => ({
    doctorMorningName: doctorMorningName.trim(),
    doctorAfternoonName: doctorAfternoonName.trim(),
    nurseName: nurseName.trim(),
    defaultRole,
    afternoonStartHour,
    doctorKeywords,
    nurseKeywords,
    procedureTemplateName: procedureTemplateName.trim(),
    procedureDurationMinutes: procedureDurationMinutes.trim(),
  }), [doctorMorningName, doctorAfternoonName, nurseName, defaultRole, afternoonStartHour, doctorKeywords, nurseKeywords, procedureTemplateName, procedureDurationMinutes]);

  async function onPickFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const base64 = await asBase64(file);
      setExcel({ filename: file.name, base64 });
      toast?.(`Đã chọn file Excel: ${file.name}`, 'ok');
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    }
  }

  async function run(mode) {
    if (!canRun) {
      toast?.('Thiếu tài khoản, mật khẩu hoặc URL phòng khám.', 'error');
      return;
    }
    if (mode === 'missed' && !excel && !manualCodes.trim()) {
      toast?.('Hoàn tất ca bỏ lỡ cần file Excel hoặc danh sách mã BN.', 'error');
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const data = await api.runClinicPreview({
        mode, username: username.trim(), password, loginUrl: loginUrl.trim(), listUrl: listUrl.trim(),
        manualCodes, excel, headless, clinicSchedule,
      });
      setResult(data);
      toast?.(data.message || 'Đã đọc phòng khám.', 'ok');
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function inputProcedures() {
    if (!canRun) {
      toast?.('Thiếu tài khoản, mật khẩu hoặc URL phòng khám.', 'error');
      return;
    }
    if (!actionRows.length) {
      toast?.('Không có dòng TT chưa hoàn tất để nhập thủ thuật.', 'error');
      return;
    }
    const missingStaff = actionRows.filter(r => !String(r.procedure_performer_name || '').trim()).length;
    if (missingStaff) {
      toast?.('Cần nhập đủ lịch khoa: bác sĩ sáng/chiều hoặc điều dưỡng theo loại thủ thuật.', 'error');
      return;
    }
    const missingService = actionRows.filter(r => !String(r.procedure_service_name || '').trim() || String(r.procedure_service_name || '').includes('Chưa đọc')).length;
    if (missingService) {
      toast?.('Còn dòng chưa đọc được Tên chỉ định TT từ popup. Hãy đọc lại danh sách hoặc kiểm tra EMR.', 'error');
      return;
    }
    const ok = window.confirm(`Sẽ nhập thủ thuật cho ${actionRows.length} chỉ định TT chưa hoàn tất. Tiếp tục?`);
    if (!ok) return;
    setInputLoading(true);
    try {
      const data = await api.runClinicInputProcedures({
        username: username.trim(), password, loginUrl: loginUrl.trim(), listUrl: listUrl.trim(),
        headless, clinicSchedule, rows: actionRows,
      });
      toast?.(data.message || 'Đã chạy nhập thủ thuật phòng khám.', data.status === 'ok' ? 'ok' : 'info');
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setInputLoading(false);
    }
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 14, display: 'grid', gap: 12, alignContent: 'start' }}>
      {activeSection === 'operations' && <Card
        title="Phòng khám"
        right={(loading || inputLoading || careLoading || carePreviewLoading) ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: C.blue, fontSize: 12 }}><Spinner size={13} /> Đang chạy Selenium</span> : null}
      >
        <div style={{ color: C.text2, fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}>
          Bỏ qua các trạng thái Hoàn tất, Đã tất toán, Treo. Dòng có TT chưa đủ sẽ được click popup Lịch sử TT để đọc Tên chỉ định trước khi quyết định thủ thuật viên.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '170px 170px 1fr', gap: 10, alignItems: 'end' }}>
          <div>
            <Label>Tài khoản</Label>
            <input value={username} onChange={e => { setUsername(e.target.value); invalidateCarePreview(); }} style={fieldStyle} autoComplete="username" />
          </div>
          <div>
            <Label>Mật khẩu</Label>
            <input value={password} onChange={e => { setPassword(e.target.value); invalidateCarePreview(); }} style={fieldStyle} type="password" autoComplete="current-password" />
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: C.text2, fontSize: 12, paddingBottom: 8 }}>
            <input type="checkbox" checked={headless} onChange={e => setHeadless(e.target.checked)} />
            Chạy Chrome ẩn
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
          <div>
            <Label>URL đăng nhập</Label>
            <input value={loginUrl} onChange={e => { setLoginUrl(e.target.value); invalidateCarePreview(); }} style={{ ...fieldStyle, ...mono }} />
          </div>
          <div>
            <Label>URL Danh sách Khám bệnh</Label>
            <input value={listUrl} onChange={e => setListUrl(e.target.value)} style={{ ...fieldStyle, ...mono }} />
          </div>
        </div>
      </Card>}

      <div role="tablist" aria-label="Chức năng phòng khám" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <SubTabButton active={activeSection === 'operations'} onClick={() => setActiveSection('operations')}>
          Khám và thủ thuật
        </SubTabButton>
        <SubTabButton active={activeSection === 'care'} onClick={() => setActiveSection('care')}>
          Nhập chăm sóc{careRows.length ? ` (${careRows.length})` : ''}
        </SubTabButton>
      </div>

      {activeSection === 'operations' && <>
      <Card title="Lịch khoa hôm nay">
        <div style={{ color: C.text3, fontSize: 11, lineHeight: 1.45, marginBottom: 10 }}>
          Bác sĩ được chọn theo giờ chỉ định trong popup TT: trước giờ bắt đầu chiều là bác sĩ sáng, từ giờ đó trở đi là bác sĩ chiều. Điều dưỡng chỉ có 1 người cho cả ngày.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 130px 160px', gap: 10 }}>
          <div>
            <Label>Bác sĩ phòng sáng</Label>
            <input value={doctorMorningName} onChange={e => setDoctorMorningName(e.target.value)} style={fieldStyle} placeholder="Tên để chọn trong EMR" />
          </div>
          <div>
            <Label>Bác sĩ phòng chiều</Label>
            <input value={doctorAfternoonName} onChange={e => setDoctorAfternoonName(e.target.value)} style={fieldStyle} placeholder="Tên để chọn trong EMR" />
          </div>
          <div>
            <Label>Điều dưỡng phòng khám</Label>
            <input value={nurseName} onChange={e => { setNurseName(e.target.value); invalidateCarePreview(); }} style={fieldStyle} placeholder="Tên để chọn trong EMR" />
          </div>
          <div>
            <Label>Giờ bắt đầu chiều</Label>
            <input value={afternoonStartHour} onChange={e => setAfternoonStartHour(e.target.value.replace(/\D+/g, '').slice(0, 2))} style={fieldStyle} />
          </div>
          <div>
            <Label>Thời lượng TT phút</Label>
            <input value={procedureDurationMinutes} onChange={e => setProcedureDurationMinutes(e.target.value.replace(/\D+/g, '').slice(0, 3))} style={fieldStyle} />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 180px 220px', gap: 10, marginTop: 10 }}>
          <div>
            <Label>Từ khóa chọn bác sĩ</Label>
            <input value={doctorKeywords} onChange={e => setDoctorKeywords(e.target.value)} style={fieldStyle} />
          </div>
          <div>
            <Label>Từ khóa chọn điều dưỡng</Label>
            <input value={nurseKeywords} onChange={e => setNurseKeywords(e.target.value)} style={fieldStyle} />
          </div>
          <div>
            <Label>Nếu không khớp từ khóa</Label>
            <select value={defaultRole} onChange={e => setDefaultRole(e.target.value)} style={fieldStyle}>
              <option value="nurse">Điều dưỡng</option>
              <option value="doctor">Bác sĩ theo giờ</option>
            </select>
          </div>
          <div>
            <Label>Mẫu tường trình</Label>
            <input value={procedureTemplateName} onChange={e => setProcedureTemplateName(e.target.value)} style={fieldStyle} />
          </div>
        </div>
      </Card>

      <Card title="Hoàn tất khám / rà ca bỏ lỡ" right={<Summary data={result} />}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 390px) 1fr', gap: 12 }}>
          <div style={{ display: 'grid', gap: 10 }}>
            <div>
              <Label>File Excel ca bỏ lỡ</Label>
              <input type="file" accept=".xlsx" onChange={onPickFile} style={{ ...fieldStyle, padding: 6 }} />
              <div style={{ color: excel ? C.green : C.text3, fontSize: 11, marginTop: 4 }}>
                {excel ? `Đã nạp: ${excel.filename}` : 'Cột cần có: Mã BN. Các cột Tên phòng khám/Trạng thái KB/Tên BN sẽ được giữ để đối chiếu.'}
              </div>
            </div>
            <div>
              <Label>Hoặc nhập mã BN thủ công</Label>
              <textarea value={manualCodes} onChange={e => setManualCodes(e.target.value)} rows={5} style={{ ...fieldStyle, resize: 'vertical', ...mono }} placeholder="Mỗi mã một dòng hoặc cách nhau bằng dấu phẩy" />
              <div style={{ color: C.text3, fontSize: 11, marginTop: 4 }}>{codeCount} mã nhập tay</div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Btn variant="primary" disabled={loading || inputLoading || !canRun} onClick={() => run('today')}>Đọc ca trong ngày</Btn>
              <Btn variant="solidWarn" disabled={loading || inputLoading || !canRun} onClick={() => run('missed')}>Tìm ca bỏ lỡ · 3 tháng</Btn>
              <Btn variant="solidSuccess" disabled={loading || inputLoading || !actionRows.length} onClick={inputProcedures}>Nhập TT chưa hoàn tất ({actionRows.length})</Btn>
            </div>
            <div style={{ color: C.text3, fontSize: 11, lineHeight: 1.45 }}>
              Nút nhập TT chỉ lấy dòng chưa có trạng thái Hoàn tất/Đã tất toán/Treo, có TT chưa đủ, và đã đọc được Tên chỉ định từ popup TT.
            </div>
          </div>

          <div style={{ minWidth: 0 }}>
            {result?.message && <div style={{ color: C.text2, fontSize: 12, marginBottom: 8 }}>{result.message}</div>}
            <ResultTable rows={result?.rows || []} />
          </div>
        </div>
      </Card>
      </>}

      {activeSection === 'care' && (
      <Card title={`Nhập chăm sóc từ danh sách điều trị nội trú${careRows.length ? ` · ${careRows.length} BN phù hợp` : ''}`}>
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{
            padding: '9px 10px', borderRadius: 8,
            border: `1px solid ${C.green}`, background: C.greenBg, color: C.green,
            fontSize: 11, lineHeight: 1.5,
          }}>
            Dùng tự động cấu hình EMR chung của hệ thống: tài khoản, mật khẩu, URL đăng nhập,
            URL danh sách điều trị nội trú và lịch điều dưỡng. Không cần thiết lập lại tại tab này.
          </div>

          <div style={{ color: careDraftError ? C.red : C.text3, fontSize: 11, lineHeight: 1.45 }}>
            {careDraftSaving
              ? 'Đang tự động lưu bản nháp…'
              : (careDraftError
                ? `Chưa lưu được bản nháp: ${careDraftError}`
                : (careDraftSavedAt
                  ? `Bản nháp đã lưu tự động lúc ${new Date(careDraftSavedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}. Tải lại trang vẫn giữ dữ liệu.`
                  : 'Bản nháp sẽ tự động lưu theo phiên làm việc. Tải lại trang sẽ khôi phục danh sách và nội dung đã chỉnh.'))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr 220px', gap: 10, alignItems: 'end' }}>
            <div>
              <Label>Ngày T/G vào</Label>
              <input type="date" value={careDate} onChange={e => { setCareDate(e.target.value); invalidateCarePreview(); }} style={fieldStyle} />
            </div>
            <div>
              <Label>Khoa chuyển đến</Label>
              <input value={targetDepartment} readOnly style={{ ...fieldStyle, color: C.text2 }} />
            </div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: C.text2, fontSize: 12, paddingBottom: 8 }}>
              <input type="checkbox" checked={needsVitals} onChange={e => { setNeedsVitals(e.target.checked); invalidateCarePreview(); }} />
              Lấy dấu hiệu sinh tồn
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <Label>Nội dung chăm sóc</Label>
              <textarea
                value={careContent}
                onChange={e => { setCareContent(e.target.value); invalidateCarePreview(); }}
                rows={4}
                style={{ ...fieldStyle, resize: 'vertical' }}
              />
            </div>
            <div>
              <Label>Mẫu diễn biến mặc định khi quét danh sách</Label>
              <textarea
                value={dienBien}
                onChange={e => { setDienBien(e.target.value); invalidateCarePreview(); }}
                rows={4}
                style={{ ...fieldStyle, resize: 'vertical' }}
              />
              <div style={{ color: C.text3, fontSize: 11, marginTop: 4 }}>
                Sau khi quét, nút lấy y lệnh chung chỉ tìm vị trí đau trong diễn biến của y lệnh đầu tiên. Mẫu này được giữ nguyên và chỉ thay dòng bắt đầu bằng “Đau …”.
              </div>
            </div>
          </div>

          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
            padding: '10px 12px', border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface2,
          }}>
            <div style={{ display: 'grid', gap: 4 }}>
              <div style={{ color: C.text2, fontSize: 12, lineHeight: 1.5 }}>
                Quét <b>Danh sách điều trị nội trú</b> theo đúng hai điều kiện: <b>Khoa chuyển đến = Khoa Khám Bệnh</b> và ngày của <b>T/G vào</b> bằng ngày đã chọn.
              </div>
              <div style={{ color: C.text3, fontSize: 11 }}>
                Thời gian phiếu chăm sóc sẽ đúng bằng <b>T/G vào</b> của từng người bệnh; không tự thay bằng giờ khác.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Btn
                variant="primary"
                disabled={carePreviewLoading || careLoading || careOrdersLoading || loading || inputLoading || !canRunCare}
                onClick={previewCare}
              >
                {carePreviewLoading ? 'Đang tìm...' : 'Tìm người bệnh phù hợp'}
              </Btn>
              <Btn
                variant="secondary"
                disabled={carePreviewLoading || careLoading || careOrdersLoading || loading || inputLoading || !careActionRows.length}
                onClick={fetchAllOrderSeeds}
              >
                {careOrdersLoading ? 'Đang lấy y lệnh...' : `Lấy y lệnh đầu cho tất cả (${careActionRows.length})`}
              </Btn>
              <Btn
                variant="solidSuccess"
                disabled={carePreviewLoading || careLoading || careOrdersLoading || loading || inputLoading || !allCareRowsSaved || !carePreview?.precheck_token || !canRunCare}
                onClick={inputCare}
              >
                {careLoading ? 'Đang nhập...' : `Nhập chăm sóc (${careSavedRows.length}/${careActionRows.length} BN đã lưu)`}
              </Btn>
            </div>
          </div>

          {carePreview?.message && <div style={{ color: C.text2, fontSize: 12 }}>{carePreview.message}</div>}
          {carePreview?.precheck_token && (
            <div style={{ color: C.green, fontSize: 11 }}>
              Danh sách người bệnh đã được xác nhận để nhập một lần{carePreview.precheck_expires_at ? ` · hết hạn ${new Date(carePreview.precheck_expires_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}` : ''}.
              {' '}Cần lưu diễn biến của từng người bệnh trước khi bấm nhập.
            </div>
          )}
          {careRows.length > careActionRows.length && (
            <div style={{ color: C.amber, fontSize: 11 }}>
              Có {careRows.length - careActionRows.length} dòng thiếu liên kết Điều dưỡng hoặc chưa xác định được người lập phiếu nên sẽ không được nhập.
            </div>
          )}
          {!carePreview && <div style={{ color: C.text3, fontSize: 11 }}>Chọn ngày rồi bấm “Tìm người bệnh phù hợp”. Danh sách tìm được sẽ hiển thị đầy đủ nội dung dự kiến nhập cho từng người bệnh.</div>}

          {careRows.length > 0 && (
            <>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
                padding: '9px 10px', border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface2,
              }}>
                <div style={{ fontSize: 12, fontWeight: 850 }}>Xem trước nội dung sẽ nhập</div>
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                  <Badge text={`Phù hợp: ${careActionRows.length}`} bg={C.blueBg} color={C.blue} />
                  <Badge
                    text={`Đã lưu: ${careSavedRows.length}/${careActionRows.length}`}
                    bg={allCareRowsSaved ? C.greenBg : C.amberBg}
                    color={allCareRowsSaved ? C.green : C.amber}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gap: 10, maxHeight: 'calc(100vh - 360px)', overflow: 'auto', paddingRight: 2 }}>
                {careRows.map((row, index) => {
                  const rowKey = careRowKey(row, index);
                  return (
                    <CarePatientPreviewCard
                      key={rowKey}
                      row={row}
                      rowKey={rowKey}
                      edit={careEdits[rowKey]}
                      careContent={careContent}
                      needsVitals={needsVitals}
                      disabled={careLoading || carePreviewLoading || careOrdersLoading || loading || inputLoading}
                      onChange={changeCareDienBien}
                      onSave={saveCarePatient}
                      onToggleSuggestion={toggleCareSuggestion}
                    />
                  );
                })}
              </div>
            </>
          )}
        </div>
      </Card>
      )}
    </div>
  );
}
