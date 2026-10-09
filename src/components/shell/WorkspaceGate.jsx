import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import * as api from '../../api.js';
import {
  decideWorkspace,
  getWorkspaceChoice,
  joinSharedWorkspace,
  setKnownSharedWorkspace,
  setWorkspaceChoice,
} from '../../hooks/useSession.js';
import { Btn, Spinner } from '../shared.jsx';
import { C, FONT_UI, FS } from '../../tokens.js';

// Kho chung: máy chủ chỉ định một workspace mà mọi máy mở mặc định (server/routes/workspace.js).
// Cổng này hỏi máy chủ TRƯỚC khi app tải dữ liệu:
// - máy chưa có dữ liệu → vào thẳng kho chung;
// - máy đang có dữ liệu riêng → hiện dải hỏi (SharedWorkspaceNotice), không tự chuyển (dữ liệu riêng vẫn còn trên máy chủ);
// - máy chủ cũ / lỗi mạng → chạy như trước, không chặn app.

const WorkspaceContext = createContext({
  info: null, refresh: async () => null, setInfo: () => {}, ask: false, join: () => {}, keep: () => {},
});

export function useWorkspaceInfo() {
  return useContext(WorkspaceContext);
}

const GATE_TIMEOUT_MS = 3000;

function reloadPage() {
  try { window.location.reload(); } catch { /* ignore */ }
}

/** Dải hỏi chuyển sang kho chung; App đặt ngay dưới thanh trên cùng. */
export function SharedWorkspaceNotice() {
  const { info, ask, join, keep } = useWorkspaceInfo();
  if (!ask || !info?.shared || info?.current?.is_shared) return null;
  return <SharedWorkspaceBanner onJoin={join} onKeep={keep} />;
}

function SharedWorkspaceBanner({ onJoin, onKeep }) {
  return (
    <div role="status" style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 16px', flex: '0 0 auto',
      background: C.amberBg, borderBottom: `1px solid ${C.amberBorder}`, color: C.text,
      fontFamily: FONT_UI, fontSize: FS.sm,
    }}>
      <span style={{ flex: '1 1 260px' }}>
        <b style={{ color: C.amber }}>Máy này đang mở dữ liệu riêng</b>, không phải kho chung của khoa.
        Chuyển sang kho chung để thấy cùng dữ liệu với các máy khác. Dữ liệu riêng vẫn được giữ, mở lại ở
        Lấy dữ liệu → Đổi dữ liệu.
      </span>
      <Btn variant="solidPrimary" onClick={onJoin}>Chuyển sang kho chung</Btn>
      <Btn onClick={onKeep}>Giữ dữ liệu riêng</Btn>
    </div>
  );
}

export default function WorkspaceGate({ children }) {
  const [ready, setReady] = useState(false);
  const [info, setInfoState] = useState(null);
  const [ask, setAsk] = useState(false);

  const setInfo = useCallback((next) => {
    setInfoState(next);
    setKnownSharedWorkspace(next?.shared?.sid || '');
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getWorkspace();
      setInfo(next);
      return next;
    } catch {
      return null;
    }
  }, [setInfo]);

  useEffect(() => {
    let done = false;
    const finish = () => { if (!done) { done = true; setReady(true); } };
    const timer = window.setTimeout(finish, GATE_TIMEOUT_MS);
    (async () => {
      const first = await refresh();
      if (done) return;
      const action = decideWorkspace({ shared: first?.shared, current: first?.current, choice: getWorkspaceChoice() });
      if (action === 'switch') {
        joinSharedWorkspace(first.shared.sid);
        await refresh();
      } else if (action === 'ask') {
        setAsk(true);
      }
      window.clearTimeout(timer);
      finish();
    })();
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const join = useCallback(() => {
    const sid = info?.shared?.sid;
    if (!sid) return;
    // App đã tải dữ liệu của workspace cũ: tải lại trang để mọi màn hình đọc kho chung.
    if (joinSharedWorkspace(sid)) reloadPage();
    else setAsk(false);
  }, [info]);

  const keep = useCallback(() => {
    setWorkspaceChoice('private');
    setAsk(false);
  }, []);

  if (!ready) {
    return (
      <div style={{ fontFamily: FONT_UI, background: C.bg, height: '100vh', display: 'grid', placeItems: 'center', color: C.text3 }}>
        <Spinner size={20} />
      </div>
    );
  }

  return (
    <WorkspaceContext.Provider value={{ info, refresh, setInfo, ask, join, keep }}>
      {children}
    </WorkspaceContext.Provider>
  );
}
