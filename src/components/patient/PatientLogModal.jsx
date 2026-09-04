import { C } from '../../tokens.js';
import { Spinner } from '../shared.jsx';

export default function PatientLogModal({ open, onClose, loading, data }) {
  if (!open) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 2000,
    }} onClick={onClose}>
      <div style={{
        background: C.surface, border: `1px solid ${C.border}`,
        borderRadius: 8, width: 640, maxHeight: '80vh',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 8px 32px rgba(0,0,0,0.28)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>Log session</span>
          {loading && <Spinner size={11} />}
          <span style={{ marginLeft: 'auto', fontSize: 11, color: C.text3 }}>Click ngoài để đóng</span>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '10px 14px' }}>
          {loading && <div style={{ color: C.text3, fontSize: 12 }}>Đang tải...</div>}
          {!loading && data && (<>
            {data.diagnostics && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 6 }}>
                  Chẩn đoán hệ thống:
                </div>
                <pre style={{
                  fontSize: 10, background: C.bg, padding: 8, borderRadius: 4,
                  border: `1px solid ${C.border}`, overflowX: 'auto',
                  color: C.text2, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>{JSON.stringify(data.diagnostics, null, 2)}</pre>
              </div>
            )}
            {data.files?.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 6 }}>
                  File log/debug ({data.files.length}):
                </div>
                {data.files.map(f => (
                  <div key={f.name} style={{ fontSize: 11, color: C.text2, padding: '2px 0',
                    fontFamily: 'monospace', display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: f.name.endsWith('.png') ? C.blue : C.text }}>{f.name}</span>
                    <span style={{ color: C.text3 }}>{f.size_kb} KB</span>
                  </div>
                ))}
              </div>
            )}

            {data.activity_log && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 6 }}>
                  Hoạt động giao diện/API:
                </div>
                <pre style={{
                  fontSize: 10, background: C.bg, padding: 8, borderRadius: 4,
                  border: `1px solid ${C.border}`, overflowX: 'auto',
                  color: C.text2, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>{data.activity_log}</pre>
              </div>
            )}
            {data.scan_history && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 6 }}>
                  Lịch sử quét:
                </div>
                <pre style={{
                  fontSize: 10, background: C.bg, padding: 8, borderRadius: 4,
                  border: `1px solid ${C.border}`, overflowX: 'auto',
                  color: C.text2, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>{data.scan_history}</pre>
              </div>
            )}
            {!data.files?.length && !data.scan_history && !data.activity_log && !data.diagnostics && (
              <div style={{ color: C.text3, fontSize: 12 }}>Chưa có log nào trong session này.</div>
            )}
          </>)}
        </div>
      </div>
    </div>
  );
}
