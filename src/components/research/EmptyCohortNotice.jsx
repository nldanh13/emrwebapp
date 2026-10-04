// Nghiên cứu chưa có mẫu (vd. lần "Lưu thành nghiên cứu" trước bị lỗi khi nạp danh sách):
// nạp lại danh sách mẫu từ kho theo điều kiện chọn mẫu đã lưu, giữ nguyên phiếu nhập tay.
import { useState } from 'react';
import { C, FS } from '../../tokens.js';
import { Btn } from '../shared.jsx';
import * as api from '../../api.js';

export function studyHasSavedSelection(study) {
  const sel = study?.variable_selection || study?.analysis_config?.variable_selection || null;
  return Boolean(sel && ((sel.conditions || []).some(c => !c.exclude) || sel.period?.from || sel.period?.to));
}

export function EmptyCohortNotice({ study, onImported, toast }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!study?.id || Number(study.cohort_count || 0) > 0) return null;
  const canImport = studyHasSavedSelection(study);
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.importResearchFromArchive(study.id, {});
      toast?.(`Đã nạp ${Number(r?.count || 0).toLocaleString('vi-VN')} mẫu từ kho theo điều kiện đã lưu.`, 'ok');
      await onImported?.();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="status" style={{ margin: '10px 12px 0', padding: '10px 14px', borderRadius: 8, border: `1px solid ${C.amberBorder}`, background: C.amberBg, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 320px', fontSize: FS.sm, color: C.text2 }}>
        <b style={{ color: C.text }}>Nghiên cứu này chưa có mẫu.</b>{' '}
        {canImport
          ? 'Nạp danh sách người bệnh từ kho theo đúng điều kiện chọn mẫu đã lưu khi tạo nghiên cứu. Phiếu nhập tay đã thiết kế được giữ nguyên.'
          : 'Nghiên cứu không lưu điều kiện chọn mẫu: vào Tạo nghiên cứu mới để chọn mẫu rồi Lưu thành nghiên cứu.'}
        {error ? <div style={{ color: C.red, marginTop: 4 }}>{error}</div> : null}
      </div>
      {canImport && <Btn variant="solidPrimary" onClick={run} loading={busy} disabled={busy} style={{ height: 32 }}>Nạp danh sách mẫu từ kho</Btn>}
    </div>
  );
}
