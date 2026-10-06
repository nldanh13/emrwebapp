// Nghiên cứu riêng: Thống kê & xuất dữ liệu. Chỉ hiển thị thống kê mô tả (mẫu, độ đầy đủ,
// đo lường từng biến); dữ liệu chi tiết chỉ lấy ra bằng Xuất CSV khi cần xử lý số liệu.
// Nghiên cứu chỉ thêm/bớt biến trên dữ liệu lấy từ kho — không thu thập, không phiếu nhập tay,
// để không ảnh hưởng kho dùng chung.
import { useCallback, useEffect, useState } from 'react';
import * as api from '../../api.js';
import { C, FS } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import { compactNumber, saveBlob } from './researchFormat.js';
import { STUDY_TABLES, datasetCount, tableLabel } from './researchScope.js';
import { CohortSummary, VariableStatsTable } from './researchStats.jsx';
import { StudyVariableEditor } from './StudyVariableEditor.jsx';

// Bảng xuất chính, theo thứ tự hay dùng khi phân tích.
const MAIN_EXPORTS = [
  ['analysis_selected', 'Các biến đã chọn của nghiên cứu, mỗi lượt điều trị một dòng. Dùng file này để xử lý số liệu.'],
  ['analysis_final', 'Dataset cuối đã kiểm tra, dùng cho phân tích thống kê.'],
  ['analysis_ready', 'Bảng tổng hợp đầy đủ mọi biến của kho cho từng lượt.'],
  ['cohort', 'Danh sách mẫu của nghiên cứu.'],
];
// Bảng không còn dùng ở nghiên cứu (phiếu nhập tay đã bỏ).
const HIDDEN_TABLES = new Set(['crf']);

const card = { border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, padding: '12px 14px' };

export function StudyStatsView({ study, toast, onStudyChanged }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [hideSensitive, setHideSensitive] = useState(true);
  const [otherTable, setOtherTable] = useState('');
  const [exporting, setExporting] = useState('');
  const [seeding, setSeeding] = useState(false);
  const studyId = study?.id || '';
  const hasRun = Boolean(study?.latest_run);

  const load = useCallback(async () => {
    if (!studyId || !hasRun) { setStats(null); return; }
    setLoading(true);
    try { setStats(await api.getResearchStudyVariableStats(studyId)); }
    catch (e) { setStats(null); toast?.(String(e.message || e), 'error'); }
    finally { setLoading(false); }
  }, [studyId, hasRun, toast]);

  useEffect(() => { load(); }, [load, study?.latest_run?.id]);

  const exportTable = async (tableKey) => {
    setExporting(tableKey);
    try {
      const r = await api.downloadResearchStudyCsv(studyId, { table: tableKey, runId: 'latest', redact: hideSensitive });
      saveBlob(r.filename || `${studyId}_${tableKey}.csv`, r.blob);
      toast?.(`Đã xuất ${tableLabel(tableKey, false)}${hideSensitive ? ' (đã ẩn định danh)' : ''}.`, 'ok');
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setExporting('');
    }
  };

  // Nghiên cứu chưa có dữ liệu: lấy dữ liệu của đúng các mẫu từ kho (chỉ đọc kho, không mở EMR).
  const seedFromArchive = async () => {
    setSeeding(true);
    try {
      const r = await api.fetchResearchStudyFromArchive(studyId);
      toast?.(r?.message || 'Đã lấy dữ liệu từ kho.', 'ok');
      await onStudyChanged?.();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setSeeding(false);
    }
  };

  const afterVariablesSaved = async () => {
    await onStudyChanged?.();
    await load();
  };

  if (!hasRun) {
    return (
      <div style={{ padding: '10px 12px' }}>
        <div style={{ ...card, textAlign: 'center', padding: '32px 20px' }}>
          <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Nghiên cứu này chưa có dữ liệu</div>
          <div style={{ fontSize: FS.sm, color: C.text3, marginTop: 6 }}>
            Đã có {compactNumber(study?.cohort_count || 0)} mẫu. Lấy dữ liệu của các mẫu này từ kho (không mở EMR, không đổi kho).
          </div>
          <Btn variant="solidPrimary" onClick={seedFromArchive} loading={seeding} disabled={seeding} style={{ marginTop: 12, height: 32 }}>Lấy dữ liệu từ kho</Btn>
        </div>
      </div>
    );
  }

  const summary = stats?.summary || null;
  const otherTables = STUDY_TABLES.filter(([id]) => !HIDDEN_TABLES.has(id) && !MAIN_EXPORTS.some(([m]) => m === id));
  return (
    <div style={{ padding: '10px 12px 16px', display: 'grid', gap: 14 }}>
      <section style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Mẫu nghiên cứu</span>
          {loading && <Spinner size={9} />}
        </div>
        {summary
          ? <CohortSummary summary={summary} />
          : !loading && (
            <div style={{ fontSize: FS.sm, color: C.text3 }}>
              {stats?.reason === 'no_selection'
                ? `Nghiên cứu không có danh sách biến đã chọn. ${compactNumber(datasetCount(study, 'analysis_ready', false))} lượt trong bảng phân tích.`
                : 'Chưa có thống kê.'}
            </div>
          )}
      </section>

      <section style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Đo lường từng biến</span>
          <StudyVariableEditor study={study} toast={toast} onSaved={afterVariablesSaved} />
        </div>
        {!!summary?.variables?.length && <VariableStatsTable variables={summary.variables} />}
      </section>

      <section style={{ ...card, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Xuất dữ liệu để xử lý số liệu</span>
          <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: FS.sm, color: C.text2 }}>
            <input type="checkbox" checked={hideSensitive} onChange={e => setHideSensitive(e.target.checked)} />
            Ẩn định danh khi xuất
          </label>
        </div>
        {MAIN_EXPORTS.map(([key, desc]) => {
          const count = datasetCount(study, key, false);
          return (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', borderTop: `1px solid ${C.border2}`, paddingTop: 9 }}>
              <div style={{ flex: '1 1 280px' }}>
                <div style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>
                  {tableLabel(key, false)} <span style={{ fontWeight: 500, color: C.text3, fontVariantNumeric: 'tabular-nums' }}>· {compactNumber(count)} dòng</span>
                </div>
                <div style={{ fontSize: FS.xs, color: C.text3 }}>{desc}</div>
              </div>
              <Btn variant={key === 'analysis_selected' ? 'solidSuccess' : 'success'} onClick={() => exportTable(key)} disabled={!count || Boolean(exporting)} loading={exporting === key} style={{ height: 30 }}>Xuất CSV</Btn>
            </div>
          );
        })}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', borderTop: `1px solid ${C.border2}`, paddingTop: 9 }}>
          <select value={otherTable} onChange={e => setOtherTable(e.target.value)} aria-label="Bảng khác" style={{ height: 30, borderRadius: 5, border: `1px solid ${C.border}`, background: C.surface, color: C.text, padding: '0 8px', fontSize: FS.sm, fontFamily: 'inherit', flex: '0 1 320px' }}>
            <option value="">Bảng khác (xét nghiệm, CĐHA, y lệnh, mã hóa...)</option>
            {otherTables.map(([id, l]) => <option key={id} value={id}>{l} · {compactNumber(datasetCount(study, id, false))} dòng</option>)}
          </select>
          <Btn variant="success" onClick={() => exportTable(otherTable)} disabled={!otherTable || Boolean(exporting)} loading={Boolean(otherTable) && exporting === otherTable} style={{ height: 30 }}>Xuất CSV</Btn>
        </div>
      </section>
    </div>
  );
}
