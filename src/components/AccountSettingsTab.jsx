// src/components/AccountSettingsTab.jsx — Thiết lập tài khoản: MỘT chỗ cho mọi thứ về tài khoản.
//   - Người dùng Data Hub: ai được đăng nhập app, vai trò, mã truy cập.
//   - Tài khoản EMR: tổng hợp mọi tài khoản EMR app giữ (chỉ ra chỗ khai trùng), tài khoản chung,
//     tài khoản theo điều dưỡng (trước ở Lịch điều dưỡng), tài khoản đọc song song, máy góp sức.
//   - Thiết bị tin cậy: máy/điện thoại mở lại không phải đăng nhập.
// Người dùng Data Hub và Tài khoản EMR chỉ quản trị thấy (máy chủ cũng chặn); Thiết bị tin cậy thì
// ai cũng dùng được cho máy của mình.
// Các mục đã mở được giữ lại khi đổi mục (như KeepAliveTab), để không mất phần đang sửa dở.

import { useCallback, useState } from 'react';
import { C, FS } from '../tokens.js';
import { Segmented } from './shared.jsx';
import { useAuth } from '../hooks/useAuth.jsx';
import DeviceTrustPanel from './DeviceTrustPanel.jsx';
import DataHubUsersPanel, { ROLE_LABELS } from './accounts/DataHubUsersPanel.jsx';
import EmrAccountsSection from './accounts/EmrAccountsSection.jsx';

const SECTION_KEY = 'emr_account_section_v1';

export const ACCOUNT_SECTIONS = [
  { value: 'users', label: 'Người dùng Data Hub', adminOnly: true },
  { value: 'emr', label: 'Tài khoản EMR', adminOnly: true },
  { value: 'devices', label: 'Thiết bị tin cậy', adminOnly: false },
];

export function sectionsFor(isAdmin) {
  return ACCOUNT_SECTIONS.filter(s => isAdmin || !s.adminOnly);
}

function loadSection(allowed) {
  try {
    const saved = localStorage.getItem(SECTION_KEY);
    if (allowed.some(s => s.value === saved)) return saved;
  } catch { /* trình duyệt chặn lưu trữ: dùng mặc định */ }
  return allowed[0].value;
}

export default function AccountSettingsTab({ toast }) {
  const { user, authMode } = useAuth();
  // Không đăng nhập (chạy riêng trên máy này) thì coi như quản trị, như trước.
  const isAdmin = !user || user.role === 'admin';
  const allowed = sectionsFor(isAdmin);
  const [section, setSectionState] = useState(() => loadSection(allowed));
  const [visited, setVisited] = useState(() => new Set([section]));
  const current = allowed.some(s => s.value === section) ? section : allowed[0].value;

  const setSection = useCallback((next) => {
    setSectionState(next);
    setVisited(prev => (prev.has(next) ? prev : new Set([...prev, next])));
    try { localStorage.setItem(SECTION_KEY, next); } catch { /* bỏ qua */ }
  }, []);

  const who = authMode === 'local_only' || !user
    ? 'Chưa bật đăng nhập: ai mở app trên máy này cũng có quyền quản trị.'
    : `Bạn đang đăng nhập: ${user.name} · ${ROLE_LABELS[user.role] || user.role}.`;

  const render = (id) => {
    if (id === 'users') return <DataHubUsersPanel toast={toast} />;
    if (id === 'emr') return <EmrAccountsSection toast={toast} />;
    return (
      <div style={{ display: 'grid', gap: 12 }}>
        <DeviceTrustPanel isAdmin={isAdmin} toast={toast} />
        {!isAdmin && (
          <div style={{ fontSize: FS.sm, color: C.text2, lineHeight: 1.6 }}>
            Người dùng Data Hub và tài khoản EMR chỉ tài khoản vai trò <b>Quản trị</b> sửa được. Cần thêm/sửa tài khoản
            thì nhờ quản trị hệ thống.
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ padding: 12, maxWidth: 1080, margin: '0 auto', display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ fontSize: FS.sm, color: C.text2 }}>{who}</div>
        {allowed.length > 1 && (
          <Segmented label="Mục tài khoản" value={current} onChange={setSection} options={allowed.map(({ value, label }) => ({ value, label }))} />
        )}
      </div>
      {allowed.map(({ value }) => (visited.has(value) || value === current ? (
        <div key={value} hidden={value !== current}>{render(value)}</div>
      ) : null))}
    </div>
  );
}
