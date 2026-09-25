import { IconActivityHeartbeat, IconHistory, IconLogout, IconMenu2, IconPlayerStop, IconSearch } from '@tabler/icons-react';

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

export default function TopBar({ tab, now, onCancel, onViewLog, onDiagnostics, onOpenFunctions, mobile = false, onMenuClick, user, authMode, onLogout }) {
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
        {mobile ? (
          <IconButton label="Tìm chức năng" onClick={onOpenFunctions}><IconSearch {...iconProps} /></IconButton>
        ) : (
          <button type="button" className="emr-search-trigger" onClick={onOpenFunctions}>
            <IconSearch size={16} stroke={1.75} aria-hidden="true" />
            <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>Tìm chức năng, quy trình…</span>
          </button>
        )}
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
