import { useCallback, useEffect, useState } from 'react';
import { IconCheck, IconPlayerPlay, IconTrash, IconX } from '@tabler/icons-react';
import { C } from '../../tokens.js';
import { Badge, Btn, SectionLabel, Spinner } from '../shared.jsx';
import * as api from '../../api.js';
import { setSessionId } from '../../hooks/useSession.js';
import { dateRangeLabel, fmtAge, fmtTime, primaryLabel } from './shiftUtils.js';

export default function SessionPicker({ onUseSession, onFetchNew, onClose, toast }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(null);

  const refresh = useCallback(() => {
    setLoading(true);
    api.getDataSessions()
      .then(s => setSessions(Array.isArray(s?.sessions) ? s.sessions : []))
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDelete = useCallback(async (item) => {
    const label = `${dateRangeLabel(item)} · ${item.count || 0} BN`;
    if (!window.confirm(`Xoá dữ liệu này?\n${label}\n\nThao tác này không xoá dữ liệu trên EMR.`)) return;
    setDeleting(item.sid);
    try {
      const r = await api.deleteDataSession(item.sid);
      toast?.(r.message || 'Đã xoá.', 'ok');
      await refresh();
    } catch (err) {
      toast?.(String(err.message || 'Không xoá được'), 'error');
    } finally {
      setDeleting(null);
    }
  }, [refresh, toast]);

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'var(--emr-scrim)',
        zIndex: 200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
    >
      <div style={{
        background: C.surface, borderRadius: '10px 10px 0 0',
        border: `1px solid ${C.border}`, width: '100%', maxWidth: 540,
        padding: '20px 20px 36px', maxHeight: '80vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Chọn dữ liệu</span>
          <button type="button" className="emr-icon-btn" onClick={onClose} aria-label="Đóng" title="Đóng"><IconX size={18} stroke={1.75} /></button>
        </div>

        <Btn variant="primary" onClick={onFetchNew}
          style={{ width: '100%', justifyContent: 'center', marginBottom: 16, padding: '10px', fontSize: 13 }}>
          ⟳ Quét & lấy dữ liệu mới từ EMR
        </Btn>

        <SectionLabel>Dữ liệu đã lưu</SectionLabel>

        {loading ? (
          <div style={{ padding: 20, display: 'flex', justifyContent: 'center' }}>
            <Spinner size={16} />
          </div>
        ) : sessions.length === 0 ? (
          <div style={{ padding: '14px 0', fontSize: 12, color: C.text3 }}>
            Chưa có dữ liệu cũ.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {sessions.map(item => {
              const color = item.primary === 'processed' ? C.green
                : item.primary === 'raw' ? C.amber : C.blue;
              return (
                <div key={item.sid} style={{
                  background: C.surface2,
                  border: `1px solid ${item.is_current ? C.blueBorder : C.border}`,
                  borderRadius: 8, padding: 12,
                }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{dateRangeLabel(item)}</span>
                    <Badge text={primaryLabel(item.primary)} bg={color + '22'} color={color} />
                    {item.is_current && <Badge text="Đang dùng" bg={C.blueBg} color={C.blue} />}
                  </div>
                  <div style={{ fontSize: 11, color: C.text3, marginBottom: 10 }}>
                    {item.count || 0} BN · {fmtTime(item.modified)} · {fmtAge(item.modified)}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Btn
                      icon={item.primary === 'processed' ? IconCheck : IconPlayerPlay}
                      variant={item.primary === 'processed' ? 'success' : 'default'}
                      onClick={() => { setSessionId(item.sid); onUseSession(item); }}
                      style={{ flex: 1, justifyContent: 'center' }}
                    >
                      {item.primary === 'processed' ? 'Dùng dữ liệu này' : 'Tiếp tục'}
                    </Btn>
                    <Btn variant="default" icon={IconTrash} loading={deleting === item.sid} onClick={() => handleDelete(item)}
                      aria-label="Xoá dữ liệu này" title="Xoá dữ liệu này" style={{ color: C.red }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
