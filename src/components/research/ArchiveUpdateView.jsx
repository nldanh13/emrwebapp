// Khu Thu thập dữ liệu của kho gốc: chọn thao tác cập nhật và theo dõi tiến độ.
import { CollectionAutoPanel } from './CollectionAutoPanel.jsx';
import { ResearchOperationDashboard } from './ResearchMonitor.jsx';

export function ArchiveUpdateView({
  archiveOptions, lastUpdateSummary, loadProgressSnapshot, loadSummary, operationSnapshot,
  selectedId, statusLoading, toast, uiBusy,
}) {
  return <div style={{ padding: '8px 12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
    <CollectionAutoPanel
      options={archiveOptions}
      disabled={uiBusy}
      toast={toast}
      onDone={async () => { await loadSummary(); await loadProgressSnapshot(selectedId, { silent: true }); }}
    />
    <ResearchOperationDashboard
      snapshot={operationSnapshot}
      lastUpdate={lastUpdateSummary}
      loading={statusLoading}
      onRefresh={() => loadProgressSnapshot(selectedId, { silent: false })}
    />
  </div>;
}
