import { useEffect, useRef, useState } from 'react';
import { IconActivityHeartbeat, IconDatabase, IconHistory, IconLogout, IconMenu2, IconPlayerStop, IconSearch, IconShare } from '@tabler/icons-react';
import * as api from '../../api.js';
import { getSessionId, getWorkspaceShareUrl, joinSharedWorkspace } from '../../hooks/useSession.js';
import { useWorkspaceInfo } from './WorkspaceGate.jsx';

const ROLE_LABELS = { viewer: 'Người xem', researcher: 'Nghiên cứu', operator: 'Vận hành', supervisor: 'Giám sát', admin: 'Quản trị' };

function userInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '··';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function IconButton({ label, onClick, danger = false, children }) {
  return (
    <button type="button" className={`emr-icon-btn${danger ? ' emr-icon-btn--danger' : ''}`} onClick={onClick} aria-label={label} title={label}>
      {children}
    </button>
  );
}

async function shareWorkspace() {
  const url = getWorkspaceShareUrl();
  const title = 'EMR Web App — cùng workspace';
  const text = 'Mở link này trên thiết bị khác để dùng đúng cùng dữ liệu và hàng đợi tác vụ. Thiết bị kia vẫn phải nhập mã truy cập riêng.';
  try {
    if (navigator.share) {
      await navigator.share({ title, text, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    window.alert('Đã sao chép link dùng chung dữ liệu. Gửi/mở link này trên thiết bị khác.');
  } catch (err) {
    // Người dùng bấm Hủy bảng Share thì không hiện lỗi. Nếu clipboard/share không hỗ trợ,
    // dùng prompt để họ vẫn copy được URL mà không cần mở DevTools.
    if (err?.name === 'AbortError') return;
    window.prompt('Sao chép link này để mở cùng workspace trên thiết bị khác:', url);
  }
}

// Cho biết máy đang mở kho chung hay dữ liệu riêng, và cho giám sát đặt/bỏ kho chung.
function WorkspaceChip({ mobile }) {
  const { info, setInfo } = useWorkspaceInfo();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!info) return null; // máy chủ chưa có tính năng kho chung
  const sharedSid = info.shared?.sid || '';
  const isShared = Boolean(sharedSid) && sharedSid === getSessionId();
  const canManage = Boolean(info.can_manage);
  if (!sharedSid && !canManage) return null;

  const label = isShared ? 'Kho chung' : sharedSid ? 'Dữ liệu riêng' : 'Chưa có kho chung';
  const tone = isShared ? 'is-shared' : sharedSid ? 'is-private' : 'is-none';
  const title = isShared
    ? 'Mọi máy mở mặc định vào dữ liệu này.'
    : sharedSid
      ? 'Máy này đang mở dữ liệu riêng, khác với kho chung các máy khác đang dùng.'
      : 'Chưa đặt kho chung: mỗi máy mới sẽ có dữ liệu riêng.';

  const run = async (fn) => {
    setBusy(true);
    try {
      const next = await fn();
      if (next?.status === 'ok') setInfo(next);
      setOpen(false);
    } catch (err) {
      window.alert(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  const makeShared = () => {
    const msg = sharedSid
      ? 'Đặt dữ liệu đang mở làm kho chung, thay cho kho chung hiện tại?\n\nCác máy chưa có dữ liệu riêng sẽ mở dữ liệu này. Kho chung cũ không bị xoá.'
      : 'Đặt dữ liệu đang mở làm kho chung?\n\nMáy mới hoặc máy chưa có dữ liệu sẽ tự mở dữ liệu này; máy đang có dữ liệu riêng sẽ được hỏi.';
    if (window.confirm(msg)) run(() => api.setSharedWorkspace(getSessionId()));
  };
  const clearShared = () => {
    if (window.confirm('Bỏ kho chung?\n\nKhông xoá dữ liệu nào. Máy nào đang mở dữ liệu nào thì giữ nguyên; máy mới sẽ có dữ liệu riêng.')) {
      run(() => api.clearSharedWorkspace());
    }
  };
  const join = () => { if (joinSharedWorkspace(sharedSid)) window.location.reload(); else setOpen(false); };

  const items = [];
  if (sharedSid && !isShared) items.push(<button key="join" type="button" role="menuitem" className="emr-menu-item" disabled={busy} onClick={join}>Chuyển sang kho chung</button>);
  if (canManage && !isShared) items.push(<button key="set" type="button" role="menuitem" className="emr-menu-item" disabled={busy} onClick={makeShared}>Đặt dữ liệu này làm kho chung</button>);
  if (canManage && isShared) items.push(<button key="clear" type="button" role="menuitem" className="emr-menu-item" disabled={busy} onClick={clearShared}>Bỏ kho chung</button>);

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button type="button" className={`emr-workspace-chip ${tone}`} title={title}
        aria-haspopup={items.length ? 'menu' : undefined} aria-expanded={items.length ? open : undefined}
        onClick={() => { if (items.length) setOpen(o => !o); }}>
        <IconDatabase size={15} stroke={1.9} aria-hidden="true" />
        {!mobile || !isShared ? <span>{label}</span> : <span className="emr-sr-only">{label}</span>}
      </button>
      {open && items.length > 0 && (
        <div role="menu" className="emr-workspace-menu">
          <p>{title}</p>
          {items}
        </div>
      )}
    </div>
  );
}

export default function TopBar({ tab, now, onCancel, onViewLog, onDiagnostics, onOpenFunctions, mobile = false, onMenuClick, user, authMode, onLogout, running = null }) {
  const dateStr = now.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const isLocalOnly = authMode === 'local_only';
  const displayName = isLocalOnly ? 'Chưa bật đăng nhập' : (user?.name || '');
  const roleLabel = ROLE_LABELS[user?.role] || '';
  const iconProps = { size: 19, stroke: 1.75, 'aria-hidden': true };

  return (
    <header className="emr-topbar">
      {mobile && (
        <IconButton label="Mở menu" onClick={onMenuClick}><IconMenu2 {...iconProps} /></IconButton>
      )}
      <div className="emr-topbar__title">
        <h1>{tab?.label}</h1>
        {!mobile && tab?.hint && <p>{tab.hint}</p>}
      </div>
      <div className="emr-topbar__actions">
        {running && (
          <button type="button" className="emr-topbar__running" onClick={running.onOpen} title={running.title}>
            <span className="emr-running-dot" aria-hidden="true" />
            <span>{mobile ? 'Đang chạy' : running.label}</span>
          </button>
        )}
        {mobile ? (
          <IconButton label="Tìm chức năng" onClick={onOpenFunctions}><IconSearch {...iconProps} /></IconButton>
        ) : (
          <button type="button" className="emr-search-trigger" onClick={onOpenFunctions}>
            <IconSearch size={16} stroke={1.75} aria-hidden="true" />
            <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>Tìm chức năng, quy trình…</span>
          </button>
        )}
        <WorkspaceChip mobile={mobile} />
        <IconButton label="Mở cùng dữ liệu trên thiết bị khác" onClick={shareWorkspace}><IconShare {...iconProps} /></IconButton>
        <IconButton label="Chẩn đoán hệ thống" onClick={onDiagnostics}><IconActivityHeartbeat {...iconProps} /></IconButton>
        {!mobile && <IconButton label="Xem nhật ký" onClick={onViewLog}><IconHistory {...iconProps} /></IconButton>}
        <IconButton label="Dừng tác vụ đang chạy" onClick={onCancel} danger><IconPlayerStop {...iconProps} /></IconButton>
        {mobile && !isLocalOnly && (
          <IconButton label="Đăng xuất" onClick={onLogout}><IconLogout {...iconProps} /></IconButton>
        )}
        {!mobile && (
          <>
            <span className="emr-topbar__divider" aria-hidden="true" />
            <div className="emr-user">
              <span className="emr-user__avatar" aria-hidden="true">{userInitials(user?.name)}</span>
              <span className="emr-user__meta">
                <b>{displayName}{roleLabel ? <span style={{ color: 'var(--emr-ink-3)', fontWeight: 500 }}> · {roleLabel}</span> : null}</b>
                <time dateTime={now.toISOString()}>{dateStr} · {timeStr}</time>
              </span>
              {!isLocalOnly && (
                <IconButton label="Đăng xuất" onClick={onLogout}><IconLogout {...iconProps} /></IconButton>
              )}
            </div>
          </>
        )}
      </div>
    </header>
  );
}
