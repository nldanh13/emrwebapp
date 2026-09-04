import { C, TL_TYPE, FONT_MONO } from '../../tokens.js';
import { Badge } from '../shared.jsx';
import { buildTimelineFromThuoc } from './patientDetailUtils.js';

function sanitizeTimelineLabel(label) {
  return String(label || '')
    .replace(/^\s*dự\s*trù\s+/i, '')
    .replace(/^\s*du\s*tru\s+/i, '')
    .trim();
}

export default function PatientTimeline({ items = [], thuoc = null }) {
  const raw = items.length > 0 ? items : buildTimelineFromThuoc(thuoc);

  if (!raw.length) {
    return (
      <div style={{ fontSize: 12, color: C.text3, padding: '16px 0' }}>
        Chưa có dữ liệu — bệnh nhân chưa có y lệnh hoặc chưa xử lý
      </div>
    );
  }

  const groupMap   = new Map();
  const groupOrder = [];
  for (const item of raw) {
    const key = item.t || '—';
    if (!groupMap.has(key)) { groupMap.set(key, []); groupOrder.push(key); }
    groupMap.get(key).push(item);
  }

  return (
    <div style={{ padding: '4px 0' }}>
      {groupOrder.map((timeKey, gi) => {
        const group  = groupMap.get(timeKey);
        const isLastGroup = gi === groupOrder.length - 1;
        return (
          <div key={timeKey} style={{ display: 'flex', gap: 0, marginBottom: isLastGroup ? 0 : 2 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 16, flexShrink: 0, marginRight: 10 }}>
              <div style={{
                width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                background:  timeKey === '—' ? C.surface2 : C.blue,
                border: `2px solid ${timeKey === '—' ? C.border : C.blue}`,
                marginTop: 4, zIndex: 1,
              }} />
              {!isLastGroup && (
                <div style={{ width: 1, flex: 1, minHeight: 18, background: C.border2 }} />
              )}
            </div>

            <div style={{ flex: 1, marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{
                  fontFamily: FONT_MONO,
                  fontSize: 12, fontWeight: 700,
                  color: timeKey === '—' ? C.text3 : C.blue,
                }}>{timeKey}</span>
                <div style={{ flex: 1, height: 1, background: C.border2 }} />
                <span style={{ fontSize: 10, color: C.text3 }}>{group.length} mục</span>
              </div>

              <div style={{ borderLeft: `1.5px solid ${C.border2}`, marginLeft: 4, paddingLeft: 14 }}>
                {group.map((item, i) => {
                  const tt     = TL_TYPE[item.type] || TL_TYPE.care;
                  const displayLabel = sanitizeTimelineLabel(item.label);
                  const isLast = i === group.length - 1;
                  const parts  = item.detail ? [
                    item.detail.ham_luong,
                    item.detail.the_tich && `${item.detail.the_tich}ml`,
                    item.detail.toc_do   && `${item.detail.toc_do}gt/p`,
                    item.detail.thoi_gian_chay_phut && `~${item.detail.thoi_gian_chay_phut}ph`,
                  ].filter(Boolean) : [];

                  return (
                    <div key={`${item.type}-${displayLabel || item.label}-${i}`} style={{
                      display: 'flex', gap: 8, alignItems: 'flex-start',
                      marginBottom: isLast ? 0 : 8, position: 'relative',
                    }}>
                      <div style={{
                        position: 'absolute', left: -14, top: 11,
                        width: 12, height: 1, background: C.border2,
                      }} />

                      <div style={{
                        width: 24, height: 24, borderRadius: 4, flexShrink: 0,
                        background: C.surface2,
                        border: `1px solid ${tt.color}55`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 9, fontWeight: 700, color: tt.color,
                      }}>{tt.label}</div>

                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12, color: C.text }}>{displayLabel}</span>
                          {item.detail?.duong_dung && (
                            <span style={{
                              fontSize: 9, fontWeight: 600, padding: '1px 5px',
                              borderRadius: 3, background: C.surface,
                              border: `1px solid ${C.border}`,
                              color: C.text3,
                            }}>{item.detail.duong_dung}</span>
                          )}
                          {item.flag === 'TT' && (
                            <Badge text="TT" bg={C.amberBg} color={C.amber} size={10} />
                          )}
                          {item.flag && item.flag !== 'TT' && (
                            <Badge text={item.flag} bg={C.redBg} color={C.red} size={10} />
                          )}
                        </div>
                        {parts.length > 0 && (
                          <div style={{ fontSize: 10, color: C.text3, marginTop: 2 }}>
                            {parts.join(' · ')}
                          </div>
                        )}
                        {item.detail?.message && (
                          <div style={{ fontSize: 10, color: C.amber, marginTop: 3 }}>
                            {item.detail.message}
                          </div>
                        )}
                        {item.detail?.yl_text && (
                          <pre style={{
                            margin: '6px 0 0', padding: '7px 8px',
                            maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap',
                            fontSize: 10, lineHeight: 1.45, color: C.text2,
                            background: C.surface, border: `1px solid ${C.border}`,
                            borderRadius: 6,
                          }}>
                            {item.detail.yl_text}
                          </pre>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
