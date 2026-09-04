import React, { useEffect, useMemo, useState } from 'react';
import { C } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import {
  getRecordsCheckSubmissions,
  addRecordsCheckSubmission,
  submitRecordsCheckSubmission,
  markRecordsCheckSubmissionReturned,
  removeRecordsCheckSubmissionItems,
  exportRecordsCheckSubmissionPdf,
} from '../../api.js';

function txt(value, fallback = '—') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function norm(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function formatDate(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : txt(value, '—');
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return txt(value);
  return date.toLocaleString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function aliasesIntersect(left, right) {
  const set = new Set((Array.isArray(left) ? left : []).filter(Boolean));
  return (Array.isArray(right) ? right : []).some(value => set.has(value));
}

function itemTone(status) {
  if (status === 'returned') return { fg: C.red, bg: C.redBg, border: C.redBorder, label: 'Bị trả về' };
  if (status === 'submitted') return { fg: C.green, bg: C.greenBg, border: C.greenBorder, label: 'Đã nộp' };
  if (status === 'preparing' || status === 'scheduled') return { fg: C.blue, bg: C.blueBg, border: C.blueBorder, label: 'Chuẩn bị nộp' };
  return { fg: C.text2, bg: C.surface2, border: C.border, label: 'Đã bỏ' };
}

function batchTone(batch) {
  if (batch?.batch_status === 'submitted' || batch?.status === 'submitted') {
    return { fg: C.green, bg: C.greenBg, border: C.greenBorder, label: 'ĐÃ NỘP' };
  }
  return { fg: C.blue, bg: C.blueBg, border: C.blueBorder, label: 'ĐANG CHUẨN BỊ' };
}

function StatusChip({ status }) {
  const tone = itemTone(status);
  return <span style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 7px', borderRadius: 4, color: tone.fg, background: tone.bg, border: `1px solid ${tone.border}`, fontSize: 10, fontWeight: 800, whiteSpace: 'nowrap' }}>{tone.label}</span>;
}

function BatchChip({ batch }) {
  const tone = batchTone(batch);
  return <span style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 4, color: tone.fg, background: tone.bg, border: `1px solid ${tone.border}`, fontSize: 10, fontWeight: 850, whiteSpace: 'nowrap' }}>{tone.label}</span>;
}

function eventLabel(event) {
  const map = {
    added: 'Đưa vào đợt nộp',
    resubmitted: 'Nộp lại sau khi bị trả về',
    submitted: 'Chốt đã nộp',
    returned: 'Hồ sơ bị trả về',
    removed: 'Bỏ khỏi đợt đang chuẩn bị',
    exported: 'Xuất danh sách PDF',
  };
  return map[event?.type] || txt(event?.type, 'Cập nhật');
}

function snapshotFromRecord(record) {
  const row = record?.snapshot || {};
  return {
    ho_ten: row.ho_ten || record?.ho_ten || '',
    ma_bn: row.ma_bn || record?.ma_bn || '',
    so_luu_tru: row.so_luu_tru || record?.so_luu_tru || '',
    so_luu_tru_in: row.so_luu_tru_in || record?.so_luu_tru_in || '',
    storage_kind: row.storage_kind || record?.storage_kind || '',
    admission_date: row.admission_date || record?.admission_date || '',
    discharge_date: row.discharge_date || record?.discharge_date || '',
    xq: Number(row.xq ?? record?.xq ?? 0),
    ct: Number(row.ct ?? record?.ct ?? 0),
    mri: Number(row.mri ?? record?.mri ?? 0),
  };
}

export default function RecordsSubmissionTab({ records = [], toast, onClearChecked }) {
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [selectedRecordIds, setSelectedRecordIds] = useState(() => new Set());
  const [selectedItemIds, setSelectedItemIds] = useState(() => new Set());
  const [candidateSearch, setCandidateSearch] = useState('');
  const [batchSearch, setBatchSearch] = useState('');

  function applyDashboard(data) {
    const next = data?.dashboard || data;
    setDashboard(next);
    const batches = next?.batches || [];
    setSelectedDate(prev => prev || next?.today || '');
    setSelectedBatchId(prev => {
      if (prev && batches.some(batch => batch.id === prev)) return prev;
      return batches[0]?.id || '';
    });
    return next;
  }

  async function refresh({ silent = false } = {}) {
    if (!silent) setLoading(true);
    try {
      const data = await getRecordsCheckSubmissions();
      return applyDashboard(data);
    } catch (err) {
      toast?.(`Không tải được lịch nộp hồ sơ: ${String(err.message || err)}`, 'error');
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const activeAliases = useMemo(() => new Set(dashboard?.active_aliases || []), [dashboard]);
  const eligibleRecords = useMemo(() => {
    const q = norm(candidateSearch);
    return (records || [])
      .filter(record => record?.checked)
      .filter(record => !(record?.aliases || []).some(alias => activeAliases.has(alias)))
      .filter(record => {
        if (!q) return true;
        const snap = snapshotFromRecord(record);
        return norm([snap.ho_ten, snap.ma_bn, snap.so_luu_tru, snap.admission_date, snap.discharge_date].join(' ')).includes(q);
      })
      .sort((a, b) => {
        const sa = snapshotFromRecord(a);
        const sb = snapshotFromRecord(b);
        return String(sa.so_luu_tru || '').localeCompare(String(sb.so_luu_tru || ''), 'vi', { numeric: true })
          || String(sa.ho_ten || '').localeCompare(String(sb.ho_ten || ''), 'vi');
      });
  }, [records, activeAliases, candidateSearch]);

  useEffect(() => {
    const valid = new Set(eligibleRecords.map(record => record.record_id));
    setSelectedRecordIds(prev => new Set([...prev].filter(id => valid.has(id))));
  }, [eligibleRecords]);

  const selectedBatch = useMemo(
    () => (dashboard?.batches || []).find(batch => batch.id === selectedBatchId) || null,
    [dashboard, selectedBatchId]
  );
  const selectedDateBatch = useMemo(
    () => (dashboard?.batches || []).find(batch => batch.submission_date === selectedDate) || null,
    [dashboard, selectedDate]
  );
  const selectedDateLocked = Boolean(selectedDateBatch?.locked);

  function currentRecordForItem(item) {
    return (records || []).find(record => record.record_id === item.record_id || aliasesIntersect(record.aliases, item.aliases)) || null;
  }

  const displayedBatchItems = useMemo(() => {
    const q = norm(batchSearch);
    return (selectedBatch?.items || [])
      .filter(item => item.status !== 'removed')
      .map(item => {
        const current = currentRecordForItem(item);
        const snapshot = { ...(item.snapshot || {}), ...(current ? snapshotFromRecord(current) : {}) };
        return { ...item, current, snapshot };
      })
      .filter(item => {
        if (!q) return true;
        return norm([item.snapshot.ho_ten, item.snapshot.ma_bn, item.snapshot.so_luu_tru].join(' ')).includes(q);
      });
  }, [selectedBatch, batchSearch, records]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectableBatchItems = useMemo(
    () => displayedBatchItems.filter(item => item.status === 'active'),
    [displayedBatchItems]
  );

  useEffect(() => {
    const valid = new Set(selectableBatchItems.map(item => item.id));
    setSelectedItemIds(prev => new Set([...prev].filter(id => valid.has(id))));
  }, [selectableBatchItems]);

  function toggleRecord(recordId, checked) {
    setSelectedRecordIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(recordId); else next.delete(recordId);
      return next;
    });
  }

  function toggleAllRecords(checked) {
    setSelectedRecordIds(checked ? new Set(eligibleRecords.map(record => record.record_id)) : new Set());
  }

  function toggleItem(itemId, checked) {
    setSelectedItemIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(itemId); else next.delete(itemId);
      return next;
    });
  }

  function toggleAllItems(checked) {
    setSelectedItemIds(checked ? new Set(selectableBatchItems.map(item => item.id)) : new Set());
  }

  async function clearWaitingChecked() {
    const selected = eligibleRecords.filter(record => selectedRecordIds.has(record.record_id));
    const targets = selected.length ? selected : eligibleRecords;
    if (!targets.length) {
      toast?.('Không có hồ sơ đã kiểm đang chờ để làm sạch.', 'warn');
      return;
    }
    const scopeText = selected.length
      ? `${selected.length} hồ sơ đã chọn`
      : `toàn bộ ${targets.length} hồ sơ đang hiển thị`;
    const confirmed = window.confirm(
      `Bỏ dấu “Đã kiểm” của ${scopeText}?

Các hồ sơ này sẽ biến mất khỏi danh sách chờ xếp ngày nộp. Dữ liệu hồ sơ vẫn được giữ nguyên và có thể tích kiểm lại ở tab Kiểm hồ sơ.`
    );
    if (!confirmed) return;
    if (typeof onClearChecked !== 'function') {
      toast?.('Chức năng bỏ dấu đã kiểm chưa được kết nối.', 'error');
      return;
    }

    setBusy(true);
    try {
      await onClearChecked(targets);
      setSelectedRecordIds(new Set());
      toast?.(`Đã bỏ dấu “Đã kiểm” của ${targets.length} hồ sơ.`, 'ok');
    } catch (err) {
      toast?.(`Không làm sạch được dấu đã kiểm: ${String(err.message || err)}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function addSelected() {
    if (!selectedDate) {
      toast?.('Hãy chọn ngày nộp hồ sơ.', 'warn');
      return;
    }
    if (selectedDateLocked) {
      toast?.(`Ngày ${formatDate(selectedDate)} đã chốt nộp. Hãy chọn ngày khác.`, 'warn');
      return;
    }
    const selected = eligibleRecords.filter(record => selectedRecordIds.has(record.record_id));
    if (!selected.length) {
      toast?.('Chưa chọn hồ sơ đã kiểm để xếp ngày nộp.', 'warn');
      return;
    }
    setBusy(true);
    try {
      const out = await addRecordsCheckSubmission({
        submission_date: selectedDate,
        records: selected.map(record => ({
          record_id: record.record_id,
          aliases: record.aliases || [],
          source_case_keys: record.source_case_keys || [],
          snapshot: snapshotFromRecord(record),
        })),
      });
      applyDashboard(out);
      setSelectedBatchId(selectedDate);
      setSelectedRecordIds(new Set());
      const skipped = Array.isArray(out?.skipped) ? out.skipped.length : 0;
      toast?.(`${out?.message || 'Đã xếp ngày nộp hồ sơ.'}${skipped ? ` Có ${skipped} hồ sơ không thêm được vì đã nằm trong đợt nộp khác hoặc chưa còn dấu đã kiểm.` : ''}`, skipped ? 'warn' : 'ok');
    } catch (err) {
      toast?.(`Không xếp được ngày nộp: ${String(err.message || err)}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function submitBatch() {
    if (!selectedBatch) return;
    const count = (selectedBatch.items || []).filter(item => item.status === 'active').length;
    if (!count) {
      toast?.('Ngày nộp này chưa có hồ sơ để chốt.', 'warn');
      return;
    }
    const confirmed = window.confirm(
      `Xác nhận đã nộp ${count} hồ sơ ngày ${formatDate(selectedBatch.submission_date)}?\n\nSau khi chốt, không thể thêm hoặc bỏ hồ sơ khỏi đợt này. Hồ sơ bị trả về vẫn có thể đánh dấu để nộp lại vào ngày khác.`
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      const out = await submitRecordsCheckSubmission({ batch_id: selectedBatch.id });
      applyDashboard(out);
      setSelectedItemIds(new Set());
      toast?.(out?.message || 'Đã chốt đợt hồ sơ là đã nộp.', 'ok');
    } catch (err) {
      toast?.(`Không chốt được đợt nộp: ${String(err.message || err)}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function markReturned() {
    const selected = displayedBatchItems.filter(item => selectedItemIds.has(item.id) && item.status === 'active');
    if (!selectedBatch || !selected.length) {
      toast?.('Chưa chọn hồ sơ bị trả về.', 'warn');
      return;
    }
    if (!window.confirm(`Đánh dấu ${selected.length} hồ sơ bị trả về từ ngày ${formatDate(selectedBatch.submission_date)}?`)) return;
    const note = window.prompt('Ghi chú lý do trả về (có thể để trống):') || '';
    setBusy(true);
    try {
      const out = await markRecordsCheckSubmissionReturned({ batch_id: selectedBatch.id, item_ids: selected.map(item => item.id), note });
      const next = applyDashboard(out);
      setSelectedItemIds(new Set());
      setSelectedRecordIds(new Set(selected.map(item => item.record_id)));
      setSelectedDate(next?.today || selectedDate);
      toast?.(out?.message || 'Đã đánh dấu hồ sơ bị trả về.', 'ok');
    } catch (err) {
      toast?.(`Không đánh dấu được hồ sơ trả về: ${String(err.message || err)}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removeSelected() {
    const selected = displayedBatchItems.filter(item => selectedItemIds.has(item.id) && item.status === 'active');
    if (!selectedBatch || !selected.length) {
      toast?.('Chưa chọn hồ sơ cần bỏ khỏi đợt nộp.', 'warn');
      return;
    }
    if (!window.confirm(`Bỏ ${selected.length} hồ sơ khỏi ngày nộp ${formatDate(selectedBatch.submission_date)}?`)) return;
    setBusy(true);
    try {
      const out = await removeRecordsCheckSubmissionItems({ batch_id: selectedBatch.id, item_ids: selected.map(item => item.id) });
      applyDashboard(out);
      setSelectedItemIds(new Set());
      toast?.(out?.message || 'Đã bỏ hồ sơ khỏi đợt nộp.', 'ok');
    } catch (err) {
      toast?.(`Không bỏ được hồ sơ: ${String(err.message || err)}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function exportBatch() {
    if (!selectedBatch) return;
    const rows = (selectedBatch.items || [])
      .filter(item => item.status !== 'removed')
      .map(item => {
        const current = currentRecordForItem(item);
        return {
          record_id: item.record_id,
          aliases: [...new Set([...(item.aliases || []), ...(current?.aliases || [])])],
          ...snapshotFromRecord(current || { snapshot: item.snapshot }),
        };
      });
    if (!rows.length) {
      toast?.('Ngày nộp này chưa có hồ sơ để xuất file.', 'warn');
      return;
    }
    setBusy(true);
    try {
      const out = await exportRecordsCheckSubmissionPdf({ batch_id: selectedBatch.id, rows });
      applyDashboard(out);
      const url = out?.url || '';
      if (!url) throw new Error('Backend chưa trả về đường dẫn PDF.');
      window.open(url, '_blank', 'noopener,noreferrer');
      if (!selectedBatch.locked) {
        toast?.('Đã xuất danh sách. Đợt vẫn đang chuẩn bị; hãy bấm “Chốt đã nộp ngày này” sau khi nộp thực tế.', 'ok');
      }
    } catch (err) {
      toast?.(`Không xuất được file theo ngày nộp: ${String(err.message || err)}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  const selectedBatchEvents = useMemo(
    () => (dashboard?.events || []).filter(event => event.batch_id === selectedBatchId).slice(0, 100),
    [dashboard, selectedBatchId]
  );

  const allRecordsSelected = eligibleRecords.length > 0 && eligibleRecords.every(record => selectedRecordIds.has(record.record_id));
  const allItemsSelected = selectableBatchItems.length > 0 && selectableBatchItems.every(item => selectedItemIds.has(item.id));

  if (loading && !dashboard) {
    return <div style={{ padding: 28, display: 'flex', gap: 10, alignItems: 'center', color: C.text2 }}><Spinner /> Đang tải lịch nộp hồ sơ...</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <div style={{ padding: '9px 12px', background: C.surface, borderBottom: `1px solid ${C.border2}` }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 190 }}>
            <div style={{ color: C.text, fontSize: 13, fontWeight: 850 }}>Xếp ngày nộp hồ sơ</div>
            <div style={{ color: C.text3, fontSize: 10, marginTop: 2 }}>Chỉ hiển thị hồ sơ đã kiểm và chưa chốt nộp.</div>
          </div>
          <input type="date" value={selectedDate} onChange={event => setSelectedDate(event.target.value)} style={inputStyle} />
          <Btn variant="primary" disabled={busy || !selectedRecordIds.size || selectedDateLocked} onClick={addSelected} style={{ fontSize: 11, padding: '5px 12px' }}>
            Thêm vào ngày nộp ({selectedRecordIds.size})
          </Btn>
          <Btn variant="secondary" disabled={busy} onClick={() => refresh()} style={{ fontSize: 11, padding: '5px 12px' }}>Làm mới</Btn>
          <Btn
            variant="default"
            disabled={busy || !eligibleRecords.length}
            onClick={clearWaitingChecked}
            title={selectedRecordIds.size ? 'Bỏ dấu đã kiểm của các hồ sơ đang chọn' : 'Không chọn dòng nào: bỏ dấu đã kiểm của toàn bộ hồ sơ đang hiển thị'}
            style={{ fontSize: 11, padding: '5px 12px', color: C.red, borderColor: C.redBorder, background: C.redBg }}
          >
            {selectedRecordIds.size ? `Làm sạch đã kiểm (${selectedRecordIds.size})` : 'Làm sạch đã kiểm'}
          </Btn>
          <input value={candidateSearch} onChange={event => setCandidateSearch(event.target.value)} placeholder="Tìm hồ sơ đã kiểm..." style={{ ...inputStyle, flex: 1, minWidth: 200, maxWidth: 360 }} />
          {busy && <Spinner size={14} />}
        </div>
        {selectedDateLocked ? (
          <div style={{ marginTop: 7, padding: '6px 9px', borderRadius: 8, color: C.green, background: C.greenBg, border: `1px solid ${C.greenBorder}`, fontSize: 11, fontWeight: 800 }}>
            Ngày {formatDate(selectedDate)} đã được chốt nộp. Hãy chọn ngày khác để xếp các hồ sơ mới.
          </div>
        ) : null}
        <div style={{ marginTop: 8, maxHeight: 190, overflow: 'auto', border: `1px solid ${C.border}`, borderRadius: 6 }}>
          {eligibleRecords.length === 0 ? (
            <div style={{ padding: 14, color: C.text2, fontSize: 12 }}>Không có hồ sơ đã kiểm đang chờ xếp ngày nộp.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: C.surface2, zIndex: 2 }}>
                <tr>
                  <th style={headStyle}><input type="checkbox" checked={allRecordsSelected} onChange={event => toggleAllRecords(event.target.checked)} title="Chọn tất cả hồ sơ đang hiển thị" /></th>
                  {['Số lưu trữ', 'Họ và tên', 'Mã BN', 'XQ', 'CT', 'MRI', 'Dữ liệu'].map(label => <th key={label} style={headStyle}>{label}</th>)}
                </tr>
              </thead>
              <tbody>
                {eligibleRecords.map(record => {
                  const snap = snapshotFromRecord(record);
                  return (
                    <tr key={record.record_id}>
                      <td style={centerCell}><input type="checkbox" checked={selectedRecordIds.has(record.record_id)} onChange={event => toggleRecord(record.record_id, event.target.checked)} /></td>
                      <td style={normalCell}><b>{txt(snap.so_luu_tru)}</b></td>
                      <td style={normalCell}>{txt(snap.ho_ten)}</td>
                      <td style={normalCell}>{txt(snap.ma_bn)}</td>
                      <td style={centerCell}>{snap.xq}</td>
                      <td style={centerCell}>{snap.ct}</td>
                      <td style={centerCell}>{snap.mri}</td>
                      <td style={normalCell}><span style={{ color: record.data_complete ? C.green : C.amber, fontWeight: 800 }}>{record.data_complete ? 'Đủ dữ liệu' : 'Cần cập nhật'}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <aside style={{ width: 250, flexShrink: 0, overflow: 'auto', borderRight: `1px solid ${C.border}`, background: C.surface }}>
          <div style={{ padding: '10px 12px', fontSize: 11, fontWeight: 850, color: C.text2, letterSpacing: .2 }}>Ngày nộp</div>
          {(dashboard?.batches || []).length === 0 ? (
            <div style={{ padding: 14, color: C.text2, fontSize: 12 }}>Chưa có đợt nộp hồ sơ.</div>
          ) : (dashboard.batches || []).map(batch => (
            <button key={batch.id} type="button" onClick={() => { setSelectedBatchId(batch.id); setSelectedItemIds(new Set()); }} style={{ width: '100%', border: 0, borderTop: `1px solid ${C.border2}`, padding: '10px 12px', textAlign: 'left', cursor: 'pointer', background: selectedBatchId === batch.id ? C.surface2 : C.surface, color: C.text }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <b style={{ fontSize: 13 }}>{formatDate(batch.submission_date)}</b>
                <BatchChip batch={batch} />
              </div>
              <div style={{ marginTop: 5, display: 'flex', gap: 7, flexWrap: 'wrap', fontSize: 10, color: C.text2 }}>
                <span>Tổng: {batch.counts?.total || 0} HS</span>
                {batch.locked ? <span style={{ color: C.green }}>Đã nộp: {batch.counts?.submitted || 0}</span> : <span style={{ color: C.blue }}>Chuẩn bị: {batch.counts?.preparing ?? batch.counts?.scheduled ?? 0}</span>}
                <span style={{ color: batch.counts?.returned ? C.red : C.text3 }}>Trả về: {batch.counts?.returned || 0}</span>
              </div>
              <div style={{ marginTop: 4, fontSize: 10, color: batch.locked ? C.green : (batch.exported_at ? C.amber : C.text3) }}>
                {batch.locked
                  ? (batch.submitted_at ? `Chốt ${formatDateTime(batch.submitted_at)}` : 'Đã nộp theo dữ liệu cũ')
                  : batch.exported_at
                    ? `Đã xuất ${formatDateTime(batch.exported_at)} · Chưa chốt`
                    : 'Chưa xuất file · Chưa chốt'}
              </div>
            </button>
          ))}
        </aside>

        <main style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: 12 }}>
          {!selectedBatch ? (
            <div style={{ padding: 22, color: C.text2, fontSize: 13 }}>Chọn hoặc tạo một ngày nộp hồ sơ để xem chi tiết.</div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                <div style={{ marginRight: 'auto', minWidth: 300 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ color: C.text, fontSize: 15, fontWeight: 850 }}>Hồ sơ nộp ngày {formatDate(selectedBatch.submission_date)}</div>
                    <BatchChip batch={selectedBatch} />
                  </div>
                  <div style={{ color: C.text3, fontSize: 10, marginTop: 3 }}>
                    {selectedBatch.locked
                      ? (selectedBatch.submitted_at
                        ? `Đã chốt lúc ${formatDateTime(selectedBatch.submitted_at)}. Không thể thêm hoặc bỏ hồ sơ; chọn hồ sơ để đánh dấu bị trả về.`
                        : 'Đợt đã nộp theo dữ liệu lịch sử. Không thể thêm hoặc bỏ hồ sơ; chọn hồ sơ để đánh dấu bị trả về.')
                      : 'Đang chuẩn bị: có thể thêm, bỏ và xuất danh sách. Xuất PDF không tự đánh dấu đã nộp.'}
                  </div>
                </div>
                <Btn variant="secondary" disabled={busy || !selectedBatch.can_mark_returned || !selectedItemIds.size} onClick={markReturned} style={{ fontSize: 11, padding: '5px 11px' }}>Đánh dấu bị trả về</Btn>
                <Btn variant="default" disabled={busy || !selectedBatch.can_remove || !selectedItemIds.size} onClick={removeSelected} style={{ fontSize: 11, padding: '5px 11px' }}>Bỏ khỏi đợt</Btn>
                <Btn variant="secondary" disabled={busy || !displayedBatchItems.length} onClick={exportBatch} style={{ fontSize: 11, padding: '5px 11px' }}>Xuất danh sách PDF</Btn>
                <Btn variant="primary" disabled={busy || !selectedBatch.can_submit} onClick={submitBatch} style={{ fontSize: 11, padding: '5px 11px' }}>
                  {selectedBatch.locked ? 'Đã chốt nộp' : 'Chốt đã nộp ngày này'}
                </Btn>
                <input value={batchSearch} onChange={event => setBatchSearch(event.target.value)} placeholder="Tìm tên trong ngày nộp..." style={{ ...inputStyle, minWidth: 210 }} />
              </div>

              {!selectedBatch.locked ? (
                <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 9, color: C.amber, background: C.amberBg, border: `1px solid ${C.amberBorder}`, fontSize: 11 }}>
                  Chỉ bấm <b>Chốt đã nộp ngày này</b> sau khi hồ sơ đã được nộp thực tế. Khi chốt, đợt sẽ được khóa và các hồ sơ này không xuất hiện trong danh sách chờ của ngày sau.
                </div>
              ) : null}

              <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden', background: C.surface }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead style={{ background: C.surface2 }}>
                    <tr>
                      <th style={headStyle}><input type="checkbox" checked={allItemsSelected} onChange={event => toggleAllItems(event.target.checked)} disabled={!selectableBatchItems.length} title="Chọn tất cả hồ sơ đang hiển thị" /></th>
                      {['Trạng thái', 'Số lưu trữ', 'Họ và tên', 'Mã BN', 'XQ', 'CT', 'MRI', 'Lần nộp'].map(label => <th key={label} style={headStyle}>{label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {displayedBatchItems.length === 0 ? <tr><td colSpan={9} style={{ padding: 20, textAlign: 'center', color: C.text2 }}>Không có hồ sơ phù hợp.</td></tr> : displayedBatchItems.map(item => (
                      <tr key={item.id} style={{ background: item.effective_status === 'returned' ? C.redBg : C.surface }}>
                        <td style={centerCell}><input type="checkbox" disabled={item.status !== 'active'} checked={selectedItemIds.has(item.id)} onChange={event => toggleItem(item.id, event.target.checked)} /></td>
                        <td style={normalCell}><StatusChip status={item.effective_status} /></td>
                        <td style={normalCell}><b>{txt(item.snapshot.so_luu_tru)}</b></td>
                        <td style={normalCell}>
                          <div style={{ fontWeight: 800 }}>{txt(item.snapshot.ho_ten)}</div>
                          {item.return_note ? <div style={{ marginTop: 2, fontSize: 10, color: C.red }}>Lý do trả về: {item.return_note}</div> : null}
                        </td>
                        <td style={normalCell}>{txt(item.snapshot.ma_bn)}</td>
                        <td style={centerCell}>{Number(item.snapshot.xq || 0)}</td>
                        <td style={centerCell}>{Number(item.snapshot.ct || 0)}</td>
                        <td style={centerCell}>{Number(item.snapshot.mri || 0)}</td>
                        <td style={normalCell}>
                          <div>{formatDateTime(item.added_at)}</div>
                          {item.previous_submission_date ? <div style={{ color: C.amber, fontSize: 10, marginTop: 2 }}>Nộp lại từ {formatDate(item.previous_submission_date)}</div> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ marginTop: 12, border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden', background: C.surface }}>
                <div style={{ padding: '8px 10px', background: C.surface2, color: C.text2, fontSize: 11, fontWeight: 850, textTransform: 'uppercase' }}>Lịch sử thay đổi ngày {formatDate(selectedBatch.submission_date)}</div>
                {selectedBatchEvents.length === 0 ? <div style={{ padding: 12, color: C.text2, fontSize: 12 }}>Chưa có lịch sử.</div> : selectedBatchEvents.map(event => (
                  <div key={event.id} style={{ padding: '7px 10px', borderTop: `1px solid ${C.border2}`, display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 11 }}>
                    <span style={{ color: C.text3, minWidth: 125 }}>{formatDateTime(event.at)}</span>
                    <b style={{ color: event.type === 'returned' ? C.red : (event.type === 'submitted' ? C.green : C.text), minWidth: 180 }}>{eventLabel(event)}</b>
                    <span style={{ color: C.text2 }}>{txt(event?.snapshot?.ho_ten || event?.file_name || (event?.count ? `${event.count} hồ sơ` : ''), '')}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

const inputStyle = { padding: '6px 9px', borderRadius: 8, background: C.surface2, border: `1px solid ${C.border}`, color: C.text, fontSize: 12 };
const headStyle = { padding: '7px 8px', borderBottom: `1px solid ${C.border}`, color: C.text2, fontSize: 10, fontWeight: 850, textTransform: 'uppercase', letterSpacing: .5, textAlign: 'left', whiteSpace: 'nowrap' };
const normalCell = { padding: '7px 8px', borderBottom: `1px solid ${C.border2}`, color: C.text, fontSize: 11, whiteSpace: 'nowrap' };
const centerCell = { ...normalCell, textAlign: 'center' };
