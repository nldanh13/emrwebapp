import { Component } from 'react';
import { C, FONT_MONO, FONT_UI } from '../tokens.js';

const box = {
  minHeight: '100vh',
  background: C.bg,
  color: C.text,
  fontFamily: FONT_UI,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
};

const panel = {
  width: 'min(680px, 100%)',
  borderTop: `3px solid ${C.red}`,
  borderBottom: `1px solid ${C.border}`,
  background: C.surface,
  padding: '20px 0',
};

const button = {
  border: `1px solid ${C.border}`,
  borderRadius: 5,
  background: C.surface,
  color: C.text,
  padding: '7px 10px',
  cursor: 'pointer',
  fontWeight: 700,
};

function clearSavedUiState() {
  try {
    localStorage.removeItem('emr_active_tab_v1');
    localStorage.removeItem('emr_active_tab_v2');
    localStorage.removeItem('emr_work_date_range_v1');
  } catch {}
  window.location.reload();
}

export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[UI] React render error:', error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const message = error?.stack || error?.message || String(error || 'Không rõ lỗi');
    return (
      <div style={box}>
        <main style={panel}>
          <div style={{ color: C.red, fontSize: 11, fontWeight: 800 }}>
            Lỗi giao diện
          </div>
          <h1 style={{ margin: '6px 0 8px', fontSize: 20 }}>Không tải được màn hình chính</h1>
          <p style={{ color: C.text2, lineHeight: 1.6, margin: 0 }}>
            Ứng dụng đã bắt được lỗi thay vì để màn hình đen. Hãy thử xóa trạng thái giao diện đã lưu rồi tải lại.
          </p>
          <div style={{ display: 'flex', gap: 10, margin: '18px 0', flexWrap: 'wrap' }}>
            <button type="button" style={button} onClick={clearSavedUiState}>Xóa trạng thái và tải lại</button>
            <button type="button" style={button} onClick={() => window.location.reload()}>Tải lại</button>
          </div>
          <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto', background: C.surface2, color: C.red, border: `1px solid ${C.border2}`, borderRadius: 5, padding: 10, fontSize: 11, fontFamily: FONT_MONO }}>
            {message}
          </pre>
        </main>
      </div>
    );
  }
}
