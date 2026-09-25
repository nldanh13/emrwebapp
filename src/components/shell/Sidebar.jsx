import { useCallback, useMemo } from 'react';
import { IconHeartbeat, IconX } from '@tabler/icons-react';
import { navIcon } from './navIcons.js';

// Nhóm "Cài đặt" đặt riêng ở chân menu để phần trên chỉ còn việc hằng ngày.
const FOOTER_GROUP = 'Cài đặt';

function groupTabs(tabs) {
  const groups = [];
  for (const tab of tabs) {
    let group = groups.find(g => g.name === tab.group);
    if (!group) { group = { name: tab.group, tabs: [] }; groups.push(group); }
    group.tabs.push(tab);
  }
  return groups;
}

function NavItem({ tab, active, onPick }) {
  const Icon = navIcon(tab.id);
  return (
    <button
      type="button"
      className="emr-nav-item"
      aria-current={active ? 'page' : undefined}
      onClick={() => onPick(tab.id)}
      title={tab.hint}
    >
      <Icon size={18} stroke={1.75} aria-hidden="true" />
      <span className="emr-nav-item__label">{tab.label}</span>
    </button>
  );
}

export default function Sidebar({ tabs, active, onChange, mobile = false, open = false, onClose }) {
  const groups = useMemo(() => groupTabs(tabs), [tabs]);
  const mainGroups = groups.filter(g => g.name !== FOOTER_GROUP);
  const footerGroup = groups.find(g => g.name === FOOTER_GROUP);

  const handlePick = useCallback((id) => {
    onChange(id);
    if (mobile) onClose?.();
  }, [onChange, mobile, onClose]);

  return (
    <>
      {mobile && open && <div className="emr-drawer-backdrop" onClick={onClose} aria-hidden="true" />}
      <aside className="emr-sidebar" data-open={mobile ? String(open) : undefined} aria-label="Menu chức năng" inert={mobile && !open}>
        <div className="emr-sidebar__brand">
          <span className="emr-sidebar__logo" aria-hidden="true"><IconHeartbeat size={19} stroke={2} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="emr-sidebar__name">Data Hub</div>
            <div className="emr-sidebar__tagline">Khai thác dữ liệu bệnh viện</div>
          </div>
          {mobile && (
            <button type="button" className="emr-icon-btn" onClick={onClose} aria-label="Đóng menu">
              <IconX size={18} stroke={1.75} />
            </button>
          )}
        </div>
        <nav className="emr-sidebar__nav">
          {mainGroups.map(group => (
            <div key={group.name} className="emr-sidebar__group" role="group" aria-label={group.name}>
              <div className="emr-sidebar__group-label">{group.name}</div>
              {group.tabs.map(tab => <NavItem key={tab.id} tab={tab} active={active === tab.id} onPick={handlePick} />)}
            </div>
          ))}
        </nav>
        {footerGroup && (
          <div className="emr-sidebar__footer" role="group" aria-label={footerGroup.name}>
            <div className="emr-sidebar__group-label" style={{ paddingTop: 6 }}>{footerGroup.name}</div>
            {footerGroup.tabs.map(tab => <NavItem key={tab.id} tab={tab} active={active === tab.id} onPick={handlePick} />)}
          </div>
        )}
      </aside>
    </>
  );
}
