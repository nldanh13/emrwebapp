import { IconLayoutList } from '@tabler/icons-react';
import { navIcon, SHORT_LABELS, MOBILE_PRIMARY_TABS } from './navIcons.js';

// Thanh điều hướng dưới trên điện thoại: 4 màn hình hằng ngày + "Tất cả" mở menu đầy đủ.
// Khi đang ở màn hình không nằm trong 4 mục, "Tất cả" được đánh dấu là đang chọn.
export default function BottomNav({ tabs, active, onChange, onOpenMenu }) {
  const byId = new Map(tabs.map(t => [t.id, t]));
  const primary = MOBILE_PRIMARY_TABS.map(id => byId.get(id)).filter(Boolean);
  const activeIsPrimary = primary.some(t => t.id === active);

  return (
    <nav className="emr-bottomnav" aria-label="Điều hướng nhanh">
      {primary.map(tab => {
        const Icon = navIcon(tab.id);
        return (
          <button key={tab.id} type="button" className="emr-bottomnav__item" aria-current={active === tab.id ? 'page' : undefined} onClick={() => onChange(tab.id)}>
            <Icon size={22} stroke={1.75} aria-hidden="true" />
            <span>{SHORT_LABELS[tab.id] || tab.label}</span>
          </button>
        );
      })}
      <button type="button" className="emr-bottomnav__item" data-active={!activeIsPrimary} onClick={onOpenMenu} aria-haspopup="true">
        <IconLayoutList size={22} stroke={1.75} aria-hidden="true" />
        <span>Tất cả</span>
      </button>
    </nav>
  );
}
