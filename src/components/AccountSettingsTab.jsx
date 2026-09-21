// src/components/AccountSettingsTab.jsx
// Giao diện quản lý tài khoản đăng nhập Data Hub (config/users.json):
//   - Xem danh sách tài khoản, vai trò, mã truy cập, tài khoản EMR riêng
//   - Thêm / sửa / tắt-bật / tạo mã mới / xoá tài khoản
// Chỉ role admin dùng được — server (server/routes/admin_users.js) đã chặn,
// trang này chỉ hiện thông báo phù hợp khi không đủ quyền hoặc chưa đăng nhập.

import { useState, useEffect, useCallback } from 'react';
import { C } from '../tokens.js';
import { Btn, Spinner, Badge } from './shared.jsx';
import { useAuth } from '../hooks/useAuth.jsx';
import * as api from '../api.js';

const ROLE_OPTIONS = [
  { value: 'viewer', label: 'Người xem — chỉ xem' },
  { value: 'researcher', label: 'Nghiên cứu — xem + xuất dữ liệu nghiên cứu' },
  { value: 'operator', label: 'Vận hành — nhập/xử lý dữ liệu (đa số nhân viên)' },
  { value: 'supervisor', label: 'Giám sát — thêm export, xoá dữ liệu' },
  { value: 'admin', label: 'Quản trị — toàn quyền, kể cả thiết lập tài khoản' },
];
const ROLE_LABELS = Object.fromEntries(ROLE_OPTIONS.map(r => [r.value, r.label.split(' — ')[0]]));

const FIELD_LABEL_STYLE = { fontSize: 11, color: C.text2, marginBottom: 3 };
const INPUT_STYLE = {
  width: '100%', padding: '6px 10px', borderRadius: 6,
  background: C.surface, border: `1px solid ${C.border}`,
  color: C.text, fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit',
};

function Field({ label, children }) {
  return (
    <div>
      <div style={FIELD_LABEL_STYLE}>{label}</div>
      {children}
    </div>
  );
}

function emptyForm() {
  return { name: '', role: 'operator', sessionsMode: 'all', sessionsList: '', enabled: true, emr_username: '', emr_password: '' };
}

function formFromUser(u) {
  const restricted = Array.isArray(u.sessions);
  return {
    name: u.name || '', role: u.role || 'operator',
    sessionsMode: restricted ? 'restricted' : 'all',
    sessionsList: restricted ? u.sessions.join(', ') : '',
    enabled: u.enabled !== false,
    emr_username: u.emr_username || '', emr_password: u.emr_password || '',
  };
}

function copyToClipboard(text, toast) {
  navigator.clipboard?.writeText(text)
    .then(() => toast?.('Đã sao chép.', 'ok'))
    .catch(() => toast?.('Không sao chép được — hãy copy thủ công.', 'error'));
}

function TokenCell({ token, toast }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <code style={{ fontSize: 11, color: C.text2, letterSpacing: 0.3 }}>
        {revealed ? token : `${token.slice(0, 4)}${'•'.repeat(10)}`}
      </code>
      <button type="button" onClick={() => setRevealed(v => !v)} title={revealed ? 'Ẩn' : 'Hiện'} style={{
        border: 'none', background: 'none', cursor: 'pointer', color: C.text3, fontSize: 12, padding: 2,
      }}>{revealed ? '🙈' : '👁'}</button>
      <button type="button" onClick={() => copyToClipboard(token, toast)} title="Sao chép" style={{
        border: 'none', background: 'none', cursor: 'pointer', color: C.blue, fontSize: 11, padding: 2, fontWeight: 700,
      }}>Copy</button>
    </div>
  );
}

function EditModal({ mode, initial, onClose, onSave, toast }) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [regenerateToken, setRegenerateToken] = useState(false);

  const set = (key) => (e) => setForm(prev => ({ ...prev, [key]: e.target.value }));

  const handleSave = async () => {
    setError('');
    if (!form.name.trim()) { setError('Cần nhập tên.'); return; }
    if (form.sessionsMode === 'restricted' && !form.sessionsList.trim()) {
      setError('Đã chọn "Giới hạn" thì cần nhập ít nhất 1 mã phiên, hoặc đổi lại "Tất cả".');
      return;
    }
    setSaving(true);
    try {
      const sessions = form.sessionsMode === 'all'
        ? '*'
        : form.sessionsList.split(',').map(x => x.trim()).filter(Boolean);
      await onSave({
        name: form.name.trim(),
        role: form.role,
        sessions,
        enabled: form.enabled,
        emr_username: form.emr_username.trim(),
        emr_password: form.emr_password,
        ...(mode === 'edit' && regenerateToken ? { regenerate_token: true } : {}),
      });
      onClose();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(23,32,51,0.42)', zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6,
        padding: 18, width: 520, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' }}
        onClick={e => e.stopPropagation()}>

        <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 14 }}>
          {mode === 'create' ? 'Thêm tài khoản' : `Sửa tài khoản: ${initial.name}`}
        </div>

        <div style={{ display: 'grid', gap: 10 }}>
          <Field label="Tên *">
            <input value={form.name} onChange={set('name')} placeholder="VD: Nguyễn Thị A" style={INPUT_STYLE} />
          </Field>
          <Field label="Vai trò">
            <select value={form.role} onChange={set('role')} style={INPUT_STYLE}>
              {ROLE_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </Field>

          <Field label="Phạm vi phiên dữ liệu">
            <div style={{ display: 'flex', gap: 14, fontSize: 12.5, color: C.text2 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                <input type="radio" checked={form.sessionsMode === 'all'} onChange={() => setForm(p => ({ ...p, sessionsMode: 'all' }))} />
                Tất cả
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                <input type="radio" checked={form.sessionsMode === 'restricted'} onChange={() => setForm(p => ({ ...p, sessionsMode: 'restricted' }))} />
                Giới hạn danh sách
              </label>
            </div>
            {form.sessionsMode === 'restricted' && (
              <input value={form.sessionsList} onChange={set('sessionsList')} placeholder="VD: default, khoa-noi"
                style={{ ...INPUT_STYLE, marginTop: 6 }} />
            )}
          </Field>

          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: C.text2, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.enabled} onChange={e => setForm(p => ({ ...p, enabled: e.target.checked }))} />
            Đang hoạt động (bỏ tick để tạm khoá tài khoản, không xoá)
          </label>

          {mode === 'edit' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4 }}>
              <TokenCell token={initial.token} toast={toast} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: C.amber, cursor: 'pointer', marginLeft: 'auto' }}>
                <input type="checkbox" checked={regenerateToken} onChange={e => setRegenerateToken(e.target.checked)} />
                Tạo mã mới (mã cũ sẽ mất hiệu lực ngay)
              </label>
            </div>
          )}

          <div style={{ borderTop: `1px solid ${C.border2}`, paddingTop: 10, display: 'grid', gap: 10 }}>
            <div style={{ fontSize: 11, color: C.text3, lineHeight: 1.5 }}>
              Tài khoản EMR thật riêng — chỉ dùng khi ghi/nhập dữ liệu (chăm sóc, dịch truyền, thủ thuật, VTYT) để
              thao tác hiện đúng tên người làm trên EMR bệnh viện. Bỏ trống thì tự dùng tài khoản chung.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label="Tài khoản EMR">
                <input value={form.emr_username} onChange={set('emr_username')} placeholder="Tên đăng nhập EMR" style={INPUT_STYLE} />
              </Field>
              <Field label="Mật khẩu EMR">
                <input type="password" value={form.emr_password} onChange={set('emr_password')} placeholder="Mật khẩu EMR" style={INPUT_STYLE} />
              </Field>
            </div>
          </div>
        </div>

        {error && (
          <div style={{ padding: '6px 10px', borderRadius: 6, background: C.redBg,
            border: `1px solid ${C.redBorder}`, color: C.red, fontSize: 12, marginTop: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <Btn variant="default" onClick={onClose}>Hủy</Btn>
          <Btn variant="primary" disabled={saving} onClick={handleSave}>
            {saving ? <><Spinner size={12} /> Đang lưu...</> : 'Lưu'}
          </Btn>
        </div>
      </div>
    </div>
  );
}

export default function AccountSettingsTab() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [fileInfo, setFileInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(null); // { mode: 'create'|'edit', form }
  const [deleting, setDeleting] = useState('');
  const [toast, setToast] = useState(null);
  const [newTokenNotice, setNewTokenNotice] = useState(null);
  const [bypassedCount, setBypassedCount] = useState(0);

  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await api.getAdminUsers();
      setItems(data.users || []);
      setFileInfo(data.file || null);
      setBypassedCount(data.local_only_bypassed_users_count || 0);
      if (data.parse_error) setLoadError(`File users.json hiện có lỗi: ${data.parse_error}`);
    } catch (e) {
      setLoadError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (payload) => {
    const r = await api.createAdminUser(payload);
    showToast('Đã tạo tài khoản.', 'ok');
    setNewTokenNotice(r.user);
    await load();
  };

  const handleUpdate = async (id, payload) => {
    const r = await api.updateAdminUser(id, payload);
    showToast(payload.regenerate_token ? 'Đã lưu và tạo mã mới.' : 'Đã lưu.', 'ok');
    if (payload.regenerate_token) setNewTokenNotice(r.user);
    await load();
  };

  const handleDelete = async (item) => {
    if (!window.confirm(`Xoá tài khoản "${item.name}"? Người này sẽ không đăng nhập được nữa ngay lập tức.`)) return;
    setDeleting(item.id);
    try {
      await api.deleteAdminUser(item.id);
      showToast('Đã xoá.', 'ok');
      await load();
    } catch (e) {
      showToast('Lỗi: ' + String(e.message || e), 'error');
    } finally {
      setDeleting('');
    }
  };

  if (user && user.role !== 'admin') {
    return (
      <div style={{ padding: 20, maxWidth: 560, margin: '40px auto', textAlign: 'center', color: C.text2 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 8 }}>Cần quyền quản trị</div>
        <div style={{ fontSize: 13, lineHeight: 1.6 }}>
          Chỉ tài khoản vai trò <b>Quản trị</b> mới thiết lập được tài khoản đăng nhập. Bạn đang đăng nhập với vai trò
          <b> {ROLE_LABELS[user.role] || user.role}</b> — liên hệ quản trị hệ thống nếu cần thêm/sửa tài khoản.
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 12, maxWidth: 1080, margin: '0 auto' }}>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>Thiết lập tài khoản</div>
          <div style={{ fontSize: 12, color: C.text2, marginTop: 4 }}>
            Tài khoản đăng nhập Data Hub và tài khoản EMR riêng cho từng người.
          </div>
        </div>
        <Btn variant="primary" disabled={fileInfo?.mode === 'inline'} onClick={() => setEditing({ mode: 'create', form: emptyForm() })}>
          + Thêm tài khoản
        </Btn>
      </div>

      {fileInfo?.mode === 'inline' && (
        <div style={{ marginBottom: 14, padding: '9px 12px', borderRadius: 7, background: C.amberBg,
          border: `1px solid ${C.amberBorder}`, fontSize: 12, color: C.amber, lineHeight: 1.5 }}>
          Server đang lấy danh sách tài khoản từ biến môi trường <code>EMR_USERS_JSON</code> — không sửa được từ giao diện
          này. Hãy sửa trực tiếp biến môi trường đó rồi khởi động lại server.
        </div>
      )}
      {bypassedCount > 0 && (
        <div style={{ marginBottom: 14, padding: '9px 12px', borderRadius: 7, background: C.blueBg,
          border: `1px solid ${C.blueBorder}`, fontSize: 12, color: C.text2, lineHeight: 1.5 }}>
          Đã có {bypassedCount} tài khoản trong danh sách, nhưng server hiện chỉ mở cho máy này (chưa đặt
          <code> HOST=0.0.0.0</code>) nên <b>đang tạm bỏ qua đăng nhập</b> — ai mở app trên máy này cũng vào thẳng
          với quyền quản trị. Tài khoản vẫn sửa được bình thường ở đây; đăng nhập sẽ tự bật lại ngay khi bạn mở
          server ra mạng LAN.
        </div>
      )}
      {loadError && (
        <div style={{ marginBottom: 14, padding: '9px 12px', borderRadius: 7, background: C.redBg,
          border: `1px solid ${C.redBorder}`, fontSize: 12, color: C.red, lineHeight: 1.5 }}>
          {loadError}
        </div>
      )}
      {newTokenNotice && (
        <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 7, background: C.greenBg,
          border: `1px solid ${C.greenBorder}`, fontSize: 12.5, color: C.text, lineHeight: 1.6 }}>
          <div style={{ fontWeight: 700, color: C.green, marginBottom: 4 }}>
            Mã truy cập cho "{newTokenNotice.name}" — gửi riêng cho người này, không gửi chung:
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <code style={{ fontSize: 12.5, background: C.surface, padding: '4px 8px', borderRadius: 4, border: `1px solid ${C.border}` }}>
              {newTokenNotice.token}
            </code>
            <button type="button" onClick={() => copyToClipboard(newTokenNotice.token, showToast)} style={{
              border: 'none', background: 'none', cursor: 'pointer', color: C.blue, fontSize: 12, fontWeight: 700,
            }}>Sao chép</button>
            <button type="button" onClick={() => setNewTokenNotice(null)} style={{
              border: 'none', background: 'none', cursor: 'pointer', color: C.text3, fontSize: 12, marginLeft: 'auto',
            }}>Đóng</button>
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ color: C.text2, display: 'flex', gap: 8, alignItems: 'center' }}>
          <Spinner /> Đang tải...
        </div>
      ) : !items.length ? (
        <div style={{ color: C.text3, padding: 20, textAlign: 'center' }}>
          Chưa có tài khoản nào — bấm "+ Thêm tài khoản" để tạo tài khoản đầu tiên.
        </div>
      ) : (
        <div style={{ background: C.surface, borderTop: `1px solid ${C.border2}`, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: C.surface2 }}>
                {['Tên', 'Vai trò', 'Mã truy cập', 'Phạm vi', 'TK EMR riêng', 'Trạng thái', 'Tác vụ'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11,
                    fontWeight: 700, color: C.text2, borderBottom: `1px solid ${C.border}`,
                    letterSpacing: 0.15, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={item.id} style={{ borderBottom: i < items.length - 1 ? `1px solid ${C.border2}` : 'none' }}>
                  <td style={{ padding: '10px 12px', fontSize: 13, color: C.text, fontWeight: 500 }}>{item.name}</td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: C.text2 }}>{ROLE_LABELS[item.role] || item.role}</td>
                  <td style={{ padding: '10px 12px', fontSize: 12 }}><TokenCell token={item.token} toast={showToast} /></td>
                  <td style={{ padding: '10px 12px', fontSize: 11.5, color: C.text2 }}>
                    {item.sessions === '*' ? 'Tất cả' : (Array.isArray(item.sessions) ? item.sessions.join(', ') : '—')}
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 12 }}>
                    {item.emr_username
                      ? <Badge text="Có" bg={C.blueBg} color={C.blue} />
                      : <span style={{ color: C.text3 }}>—</span>}
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 12 }}>
                    {item.enabled
                      ? <Badge text="Hoạt động" bg={C.greenBg} color={C.green} />
                      : <Badge text="Đã khoá" bg={C.surface2} color={C.text3} />}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Btn variant="secondary" disabled={fileInfo?.mode === 'inline'}
                        onClick={() => setEditing({ mode: 'edit', form: formFromUser(item), id: item.id, token: item.token, name: item.name })}
                        style={{ fontSize: 11, padding: '2px 10px' }}>
                        Sửa
                      </Btn>
                      <Btn variant="default" disabled={fileInfo?.mode === 'inline' || deleting === item.id} onClick={() => handleDelete(item)}
                        style={{ fontSize: 11, padding: '2px 10px', color: C.red }}>
                        {deleting === item.id ? <Spinner size={10} /> : 'Xoá'}
                      </Btn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, maxWidth: 380, padding: '10px 18px',
          borderRadius: 8, background: toast.type === 'error' ? C.redBg : toast.type === 'ok' ? C.greenBg : C.surface,
          border: `1px solid ${toast.type === 'error' ? C.redBorder : toast.type === 'ok' ? C.greenBorder : C.border}`,
          color: toast.type === 'error' ? C.red : toast.type === 'ok' ? C.green : C.text,
          fontSize: 13, lineHeight: 1.5, boxShadow: C.shadow2, zIndex: 100 }}>
          {toast.msg}
        </div>
      )}

      {editing && (
        <EditModal
          mode={editing.mode}
          initial={editing.mode === 'create' ? editing.form : { ...editing.form, name: editing.name, token: editing.token }}
          onClose={() => setEditing(null)}
          onSave={(payload) => editing.mode === 'create' ? handleCreate(payload) : handleUpdate(editing.id, payload)}
          toast={showToast}
        />
      )}
    </div>
  );
}
