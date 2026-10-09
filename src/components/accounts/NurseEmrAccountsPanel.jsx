// src/components/accounts/NurseEmrAccountsPanel.jsx — Tài khoản EMR theo tên điều dưỡng trong lịch.
// Dùng khi NHẬP liệu: mỗi lượt đăng nhập bằng tài khoản người ca làm (worker/nurse_emr_accounts.py).
// Trước đây sửa trong Lịch điều dưỡng; nay gom về Thiết lập tài khoản → Tài khoản EMR. Lịch điều
// dưỡng chỉ còn danh sách tên, lịch ca và ảnh chữ ký.
// Tự lưu từng người (~0,8 giây sau lần gõ cuối) qua PUT /api/nurse-emr-accounts/account/:name, không
// gửi cả danh sách để không ghi đè chữ ký vừa đổi ở Lịch điều dưỡng.

import { useCallback, useEffect, useRef, useState } from 'react';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import * as api from '../../api.js';
import { useOnTabReturn, useUnsavedChangesGuard } from '../../hooks/useTabActivity.js';
import { SkeletonTable } from '../Skeleton.jsx';

const AUTOSAVE_MS = 800;

const INPUT_STYLE = {
  width: '100%', height: 30, padding: '0 8px', borderRadius: 5, boxSizing: 'border-box',
  background: C.surface, border: `1px solid ${C.border}`, color: C.text, fontSize: FS.sm, fontFamily: 'inherit',
};

function hhmm(date) {
  return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

/** Danh sách hiển thị: mọi tên trong lịch, cộng người đã có tài khoản mà không còn trong lịch. */
export function buildNurseAccountRows(roster = [], accounts = []) {
  const byName = new Map((accounts || []).map(a => [a.name, a]));
  const names = [...(roster || [])];
  for (const a of accounts || []) {
    if (!names.includes(a.name) && (a.emr_username || a.emr_password)) names.push(a.name);
  }
  return names.map(name => ({
    name,
    inRoster: (roster || []).includes(name),
    emr_username: byName.get(name)?.emr_username || '',
    emr_password: byName.get(name)?.emr_password || '',
  }));
}

function PasswordInput({ value, onChange, label }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input type={revealed ? 'text' : 'password'} value={value} onChange={onChange} placeholder="Mật khẩu EMR"
        aria-label={label} autoComplete="new-password" style={{ ...INPUT_STYLE, paddingRight: 32 }} />
      <button type="button" className="emr-icon-btn" onClick={() => setRevealed(v => !v)}
        aria-label={revealed ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} title={revealed ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
        style={{ position: 'absolute', right: 1, top: 1, width: 28, height: 28 }}>
        {revealed ? <IconEyeOff size={15} stroke={1.75} /> : <IconEye size={15} stroke={1.75} />}
      </button>
    </div>
  );
}

export default function NurseEmrAccountsPanel({ onSaved }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState({}); // name -> { state: 'pending'|'saving'|'saved'|'error', at, message }
  const timers = useRef({});
  const pending = useRef({}); // name -> patch chưa gửi

  const dirty = Object.values(status).some(s => s.state === 'pending' || s.state === 'saving');
  useUnsavedChangesGuard(dirty);

  const load = useCallback(async () => {
    try {
      const [settings, accounts] = await Promise.all([api.getNurseSettings(), api.getNurseEmrAccounts()]);
      setError('');
      const next = buildNurseAccountRows(settings?.roster || [], accounts?.accounts || []);
      // Cập nhật ngầm: dòng đang gõ dở giữ nguyên phần đang gõ.
      setRows(prev => next.map(r => {
        const editing = pending.current[r.name];
        if (!editing) return r;
        const old = (prev || []).find(p => p.name === r.name);
        return { ...r, ...(old ? { emr_username: old.emr_username, emr_password: old.emr_password } : editing) };
      }));
    } catch (e) {
      setError(String(e.message || e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useOnTabReturn(() => load());

  const flush = useCallback(async (name) => {
    const patch = pending.current[name];
    if (!patch) return;
    delete pending.current[name];
    setStatus(s => ({ ...s, [name]: { state: 'saving' } }));
    try {
      const r = await api.updateNurseEmrAccount(name, patch);
      if (r?.status !== 'ok') throw new Error(r?.message || 'Máy chủ không nhận.');
      setStatus(s => (pending.current[name] ? s : { ...s, [name]: { state: 'saved', at: new Date() } }));
      onSaved?.();
    } catch (e) {
      pending.current[name] = { ...patch, ...(pending.current[name] || {}) };
      setStatus(s => ({ ...s, [name]: { state: 'error', message: `Chưa lưu được: ${String(e.message || e)}. Sửa lại ô này để thử lưu lần nữa.` } }));
    }
  }, [onSaved]);

  // Rời màn hình (đóng/ẩn component) khi còn phần chưa lưu: lưu ngay.
  useEffect(() => () => {
    for (const name of Object.keys(timers.current)) clearTimeout(timers.current[name]);
    for (const name of Object.keys(pending.current)) api.updateNurseEmrAccount(name, pending.current[name]).catch(() => {});
  }, []);

  const change = (name, field, value) => {
    setRows(list => list.map(r => (r.name === name ? { ...r, [field]: value } : r)));
    pending.current[name] = { ...(pending.current[name] || {}), [field]: value };
    setStatus(s => ({ ...s, [name]: { state: 'pending' } }));
    clearTimeout(timers.current[name]);
    timers.current[name] = setTimeout(() => { delete timers.current[name]; flush(name); }, AUTOSAVE_MS);
  };

  const statusText = (name) => {
    const s = status[name];
    if (!s) return null;
    if (s.state === 'pending') return <span style={{ color: C.amber }}>Có thay đổi, đang chờ tự lưu…</span>;
    if (s.state === 'saving') return <span style={{ color: C.text2 }}>Đang lưu…</span>;
    if (s.state === 'saved') return <span style={{ color: C.green }}>Đã tự lưu lúc {hhmm(s.at)}</span>;
    return <span role="alert" style={{ color: C.red }}>{s.message}</span>;
  };

  return (
    <section style={{ padding: 12, background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8 }}>
      <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>Tài khoản EMR của từng điều dưỡng (nhập liệu)</div>
      <div style={{ fontSize: FS.sm, color: C.text2, marginTop: 4, lineHeight: 1.5 }}>
        Khi nhập chăm sóc, dịch truyền, thủ thuật, VTYT, app đăng nhập EMR bằng tài khoản của <b>người ca làm theo
        Lịch điều dưỡng</b>, để EMR ghi đúng người thực hiện. Người chưa có tài khoản thì nhập bằng tài khoản chung
        và có cảnh báo. Danh sách tên lấy từ Lịch điều dưỡng; thêm/bớt người ở đó.
      </div>
      {error && <div role="alert" style={{ marginTop: 8, color: C.red, fontSize: FS.sm }}>Không tải được danh sách điều dưỡng: {error}. Tải lại trang để thử lại.</div>}
      {rows == null && !error ? (
        <div role="status" aria-busy="true" aria-label="Đang tải tài khoản điều dưỡng" style={{ marginTop: 10 }}><SkeletonTable rows={4} cols={3} /></div>
      ) : rows && rows.length === 0 ? (
        <div style={{ marginTop: 10, fontSize: FS.sm, color: C.text2 }}>Lịch điều dưỡng chưa có tên nào. Thêm điều dưỡng ở tab Lịch điều dưỡng rồi quay lại đây.</div>
      ) : rows && (
        <div style={{ overflowX: 'auto', marginTop: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Điều dưỡng', 'Tên đăng nhập EMR', 'Mật khẩu EMR', ''].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: FS.xs, color: C.text2, borderBottom: `1px solid ${C.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.name} style={{ borderBottom: `1px solid ${C.border2}` }}>
                  <td style={{ padding: '6px 8px', fontSize: FS.md, color: C.text, minWidth: 150 }}>
                    {row.name}
                    {!row.inRoster && <div style={{ fontSize: FS.xs, color: C.text3 }}>Không còn trong lịch</div>}
                  </td>
                  <td style={{ padding: '6px 8px', minWidth: 150 }}>
                    <input value={row.emr_username} onChange={e => change(row.name, 'emr_username', e.target.value)}
                      placeholder="Tài khoản EMR" aria-label={`Tài khoản EMR của ${row.name}`} autoComplete="off" style={INPUT_STYLE} />
                  </td>
                  <td style={{ padding: '6px 8px', minWidth: 170 }}>
                    <PasswordInput value={row.emr_password} onChange={e => change(row.name, 'emr_password', e.target.value)} label={`Mật khẩu EMR của ${row.name}`} />
                  </td>
                  <td style={{ padding: '6px 8px', fontSize: FS.xs, minWidth: 140 }}>
                    {statusText(row.name) || (!row.emr_username || !row.emr_password
                      ? <span style={{ color: C.text3 }}>Chưa có, nhập bằng tài khoản chung</span>
                      : null)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
