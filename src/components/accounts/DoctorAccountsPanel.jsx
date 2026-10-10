// src/components/accounts/DoctorAccountsPanel.jsx — Tài khoản EMR bác sĩ để đăng nhập phòng khám.
// Lưu chung file secrets/nurse_emr_accounts.json, đánh dấu kind 'doctor' (không dùng khi nhập liệu
// theo Lịch điều dưỡng). Phòng khám và Nghỉ ốm chọn bác sĩ theo tên; máy chủ tự điền tài khoản và
// mật khẩu (server/routes/clinic.js → withDoctorAccount), mật khẩu không về trình duyệt người dùng.
// Thêm nhiều bác sĩ một lần: máy chủ tự tạo tên đăng nhập (vd. Hoàng Minh Tú → hmtu).

import { useCallback, useEffect, useRef, useState } from 'react';
import { IconEye, IconEyeOff, IconTrash } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { Btn } from '../shared.jsx';
import * as api from '../../api.js';
import { useOnTabReturn, useUnsavedChangesGuard } from '../../hooks/useTabActivity.js';
import { SkeletonTable } from '../Skeleton.jsx';

const AUTOSAVE_MS = 800;

const INPUT_STYLE = {
  width: '100%', height: 30, padding: '0 8px', borderRadius: 5, boxSizing: 'border-box',
  background: C.surface, border: `1px solid ${C.border}`, color: C.text, fontSize: FS.sm, fontFamily: 'inherit',
};

/** Tách danh sách tên dán vào (phẩy, chấm phẩy hoặc xuống dòng). */
export function splitDoctorNames(text) {
  return [...new Set(String(text || '').split(/[,;\n]+/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

function doctorRows(accounts) {
  return (accounts || []).filter(a => a.kind === 'doctor')
    .map(a => ({ name: a.name, emr_username: a.emr_username || '', emr_password: a.emr_password || '' }))
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
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

export default function DoctorAccountsPanel({ toast, onSaved }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState({});
  const [namesText, setNamesText] = useState('');
  const [bulkPassword, setBulkPassword] = useState('');
  const [adding, setAdding] = useState(false);
  const timers = useRef({});
  const pending = useRef({});

  const dirty = Object.values(status).some(s => s.state === 'pending' || s.state === 'saving') || Boolean(namesText.trim());
  useUnsavedChangesGuard(dirty);

  const apply = useCallback((accounts) => {
    const next = doctorRows(accounts);
    setRows(prev => next.map(r => {
      if (!pending.current[r.name]) return r;
      return (prev || []).find(p => p.name === r.name) || r;
    }));
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await api.getNurseEmrAccounts();
      setError('');
      apply(data?.accounts || []);
    } catch (e) {
      setError(String(e.message || e));
    }
  }, [apply]);

  useEffect(() => { load(); }, [load]);
  useOnTabReturn(() => load());

  const flush = useCallback(async (name) => {
    const patch = pending.current[name];
    if (!patch) return;
    delete pending.current[name];
    setStatus(s => ({ ...s, [name]: { state: 'saving' } }));
    try {
      const r = await api.updateNurseEmrAccount(name, { ...patch, kind: 'doctor' });
      if (r?.status !== 'ok') throw new Error(r?.message || 'Máy chủ không nhận.');
      setStatus(s => (pending.current[name] ? s : { ...s, [name]: { state: 'saved', at: new Date() } }));
      onSaved?.();
    } catch (e) {
      pending.current[name] = { ...patch, ...(pending.current[name] || {}) };
      setStatus(s => ({ ...s, [name]: { state: 'error', message: `Chưa lưu được: ${String(e.message || e)}. Sửa lại ô này để thử lưu lần nữa.` } }));
    }
  }, [onSaved]);

  useEffect(() => () => {
    for (const name of Object.keys(timers.current)) clearTimeout(timers.current[name]);
    for (const name of Object.keys(pending.current)) api.updateNurseEmrAccount(name, { ...pending.current[name], kind: 'doctor' }).catch(() => {});
  }, []);

  const change = (name, field, value) => {
    setRows(list => list.map(r => (r.name === name ? { ...r, [field]: value } : r)));
    pending.current[name] = { ...(pending.current[name] || {}), [field]: value };
    setStatus(s => ({ ...s, [name]: { state: 'pending' } }));
    clearTimeout(timers.current[name]);
    timers.current[name] = setTimeout(() => { delete timers.current[name]; flush(name); }, AUTOSAVE_MS);
  };

  const names = splitDoctorNames(namesText);

  const addMany = async () => {
    if (!names.length) return;
    setAdding(true);
    try {
      const r = await api.addDoctorAccounts({ names, password: bulkPassword });
      if (r?.status !== 'ok') throw new Error(r?.message || 'Máy chủ không nhận.');
      apply(r.accounts || []);
      setNamesText('');
      setBulkPassword('');
      toast?.(`Đã thêm ${names.length} bác sĩ. Tên đăng nhập tự tạo hiện trong bảng, sửa được nếu khác.`, 'ok');
      onSaved?.();
    } catch (e) {
      toast?.(`Chưa thêm được bác sĩ: ${String(e.message || e)}`, 'error');
    } finally {
      setAdding(false);
    }
  };

  const remove = async (name) => {
    if (!window.confirm(`Bỏ tài khoản EMR của bác sĩ ${name}? Phòng khám sẽ không chọn được bác sĩ này nữa.`)) return;
    try {
      const r = await api.removeNurseEmrAccount(name);
      if (r?.status !== 'ok') throw new Error(r?.message || 'Máy chủ không nhận.');
      apply(r.accounts || []);
      onSaved?.();
    } catch (e) {
      toast?.(`Chưa bỏ được: ${String(e.message || e)}`, 'error');
    }
  };

  const statusText = (name) => {
    const s = status[name];
    if (!s) return null;
    if (s.state === 'pending') return <span style={{ color: C.amber }}>Có thay đổi, đang chờ tự lưu…</span>;
    if (s.state === 'saving') return <span style={{ color: C.text2 }}>Đang lưu…</span>;
    if (s.state === 'saved') return <span style={{ color: C.green }}>Đã tự lưu lúc {s.at.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span>;
    return <span role="alert" style={{ color: C.red }}>{s.message}</span>;
  };

  return (
    <section style={{ padding: 12, background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8 }}>
      <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>Bác sĩ phòng khám</div>
      <div style={{ fontSize: FS.sm, color: C.text2, marginTop: 4, lineHeight: 1.5 }}>
        Tài khoản EMR của bác sĩ để đăng nhập ở <b>Phòng khám</b> và khi quét ngoại trú ở <b>Nghỉ ốm</b>: ở đó chỉ cần chọn tên
        bác sĩ, không phải gõ tài khoản và mật khẩu. Không dùng khi nhập liệu theo Lịch điều dưỡng.
      </div>

      <div style={{ marginTop: 10, padding: 10, borderRadius: 6, background: C.surface2, display: 'grid', gap: 8 }}>
        <div style={{ fontSize: FS.sm, fontWeight: 600, color: C.text }}>Thêm nhiều bác sĩ một lần</div>
        <textarea value={namesText} onChange={e => setNamesText(e.target.value)} rows={3}
          aria-label="Tên các bác sĩ" placeholder="Dán tên, cách nhau bằng dấu phẩy hoặc xuống dòng. Vd: Hoàng Minh Tú, Hồ Điền"
          style={{ ...INPUT_STYLE, height: 'auto', padding: 8, resize: 'vertical' }} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ width: 220 }}>
            <PasswordInput value={bulkPassword} onChange={e => setBulkPassword(e.target.value)} label="Mật khẩu chung cho các bác sĩ vừa thêm" />
          </div>
          <Btn variant="solidPrimary" loading={adding} disabled={!names.length} onClick={addMany}>
            {names.length ? `Thêm ${names.length} bác sĩ` : 'Thêm bác sĩ'}
          </Btn>
          <span style={{ fontSize: FS.xs, color: C.text3, flex: '1 1 260px' }}>
            Tên đăng nhập tự tạo: chữ đầu của họ và tên đệm + tên, không dấu (Hoàng Minh Tú → hmtu). Bác sĩ đã có thì giữ tên
            đăng nhập, chỉ đổi mật khẩu nếu có nhập.
          </span>
        </div>
      </div>

      {error && <div role="alert" style={{ marginTop: 8, color: C.red, fontSize: FS.sm }}>Không tải được danh sách bác sĩ: {error}. Tải lại trang để thử lại.</div>}
      {rows == null && !error ? (
        <div role="status" aria-busy="true" aria-label="Đang tải tài khoản bác sĩ" style={{ marginTop: 10 }}><SkeletonTable rows={3} cols={3} /></div>
      ) : rows && rows.length === 0 ? (
        <div style={{ marginTop: 10, fontSize: FS.sm, color: C.text2 }}>Chưa có bác sĩ nào. Dán tên vào ô trên rồi bấm Thêm.</div>
      ) : rows && (
        <div style={{ overflowX: 'auto', marginTop: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Bác sĩ', 'Tên đăng nhập EMR', 'Mật khẩu EMR', '', ''].map((h, i) => (
                  <th key={i} style={{ textAlign: 'left', padding: '6px 8px', fontSize: FS.xs, color: C.text2, borderBottom: `1px solid ${C.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.name} style={{ borderBottom: `1px solid ${C.border2}` }}>
                  <td style={{ padding: '6px 8px', fontSize: FS.md, color: C.text, minWidth: 150 }}>{row.name}</td>
                  <td style={{ padding: '6px 8px', minWidth: 130 }}>
                    <input value={row.emr_username} onChange={e => change(row.name, 'emr_username', e.target.value)}
                      aria-label={`Tài khoản EMR của bác sĩ ${row.name}`} autoComplete="off" style={INPUT_STYLE} />
                  </td>
                  <td style={{ padding: '6px 8px', minWidth: 160 }}>
                    <PasswordInput value={row.emr_password} onChange={e => change(row.name, 'emr_password', e.target.value)} label={`Mật khẩu EMR của bác sĩ ${row.name}`} />
                  </td>
                  <td style={{ padding: '6px 8px', fontSize: FS.xs, minWidth: 130 }}>
                    {statusText(row.name) || (!row.emr_password ? <span style={{ color: C.amber }}>Thiếu mật khẩu</span> : null)}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <button type="button" className="emr-icon-btn emr-icon-btn--danger" onClick={() => remove(row.name)}
                      aria-label={`Bỏ bác sĩ ${row.name}`} title="Bỏ bác sĩ" style={{ width: 30, height: 30 }}>
                      <IconTrash size={16} stroke={1.75} />
                    </button>
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
