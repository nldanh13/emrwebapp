// src/components/accounts/EmrPeoplePanel.jsx — Danh sách tài khoản EMR theo người: điều dưỡng (nhập liệu
// theo Lịch điều dưỡng) hoặc bác sĩ phòng khám (đăng nhập Phòng khám / Nghỉ ốm). Một bảng gọn, có ô tìm,
// nút "Thêm" (một hoặc nhiều người, tên đăng nhập tự gợi ý) và nút xoá trên từng dòng.
// - Sửa tên đăng nhập/mật khẩu: tự lưu từng người (~0,8 giây) qua PUT /api/nurse-emr-accounts/account/:name,
//   không gửi cả danh sách để không ghi đè chữ ký vừa đổi ở Lịch điều dưỡng.
// - Điều dưỡng: thêm ở đây thì thêm luôn vào Lịch điều dưỡng; xoá thì bỏ cả tài khoản, chữ ký và tên trong
//   Lịch điều dưỡng (giống nút xoá ở tab Lịch điều dưỡng).
// - Bác sĩ: lưu chung file với "kind": "doctor"; máy chủ điền mật khẩu khi đăng nhập phòng khám.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconEye, IconEyeOff, IconPlus, IconSearch, IconTrash, IconX } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { Btn } from '../shared.jsx';
import * as api from '../../api.js';
import { useOnTabReturn, useUnsavedChangesGuard } from '../../hooks/useTabActivity.js';
import { SkeletonTable } from '../Skeleton.jsx';
import { uniqueEmrUsernames } from '../../utils/emrUsername.js';

const AUTOSAVE_MS = 800;

const INPUT_STYLE = {
  width: '100%', height: 30, padding: '0 8px', borderRadius: 5, boxSizing: 'border-box',
  background: C.surface, border: `1px solid ${C.border}`, color: C.text, fontSize: FS.sm, fontFamily: 'inherit',
};

const KIND_TEXT = {
  nurse: {
    one: 'điều dưỡng',
    title: 'Điều dưỡng',
    intro: 'Khi nhập chăm sóc, dịch truyền, thủ thuật, VTYT, app đăng nhập EMR bằng tài khoản của người ca làm theo Lịch điều dưỡng. Người chưa có tài khoản thì nhập bằng tài khoản chung.',
    empty: 'Chưa có điều dưỡng nào. Bấm "Thêm điều dưỡng".',
    removeConfirm: (n) => `Xoá điều dưỡng ${n}?\n\nTài khoản EMR, ảnh chữ ký và tên trong Lịch điều dưỡng (cả các ca đã xếp) sẽ bị bỏ.`,
  },
  doctor: {
    one: 'bác sĩ',
    title: 'Bác sĩ phòng khám',
    intro: 'Phòng khám và Nghỉ ốm đăng nhập EMR bằng bác sĩ xếp ở tab Lịch làm việc (hoặc bác sĩ chọn tay). Mật khẩu không gửi về trình duyệt người dùng.',
    empty: 'Chưa có bác sĩ nào. Bấm "Thêm bác sĩ".',
    removeConfirm: (n) => `Xoá bác sĩ ${n}? Phòng khám sẽ không đăng nhập bằng bác sĩ này nữa.`,
  },
};

/** Tách danh sách tên dán vào (phẩy, chấm phẩy hoặc xuống dòng), bỏ trùng. */
export function splitNames(text) {
  return [...new Set(String(text || '').split(/[,;\n]+/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

/** Điều dưỡng: mọi tên trong lịch, cộng người đã có tài khoản mà không còn trong lịch. */
export function buildNurseAccountRows(roster = [], allAccounts = []) {
  const accounts = (allAccounts || []).filter(a => a.kind !== 'doctor');
  const byName = new Map(accounts.map(a => [a.name, a]));
  const names = [...(roster || [])];
  for (const a of accounts) {
    if (!names.includes(a.name) && (a.emr_username || a.emr_password)) names.push(a.name);
  }
  return names.map(name => ({
    name,
    inRoster: (roster || []).includes(name),
    emr_username: byName.get(name)?.emr_username || '',
    emr_password: byName.get(name)?.emr_password || '',
  })).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

export function buildDoctorAccountRows(allAccounts = []) {
  return (allAccounts || []).filter(a => a.kind === 'doctor')
    .map(a => ({ name: a.name, inRoster: true, emr_username: a.emr_username || '', emr_password: a.emr_password || '' }))
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

export function matchesSearch(row, query) {
  const q = String(query || '').trim();
  if (!q) return true;
  const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
  return plain(row.name).includes(plain(q)) || plain(row.emr_username).includes(plain(q));
}

function PasswordInput({ value, onChange, label, placeholder = 'Mật khẩu EMR' }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input type={revealed ? 'text' : 'password'} value={value} onChange={onChange} placeholder={placeholder}
        aria-label={label} autoComplete="new-password" style={{ ...INPUT_STYLE, paddingRight: 32 }} />
      <button type="button" className="emr-icon-btn" onClick={() => setRevealed(v => !v)}
        aria-label={revealed ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} title={revealed ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
        style={{ position: 'absolute', right: 1, top: 1, width: 28, height: 28 }}>
        {revealed ? <IconEyeOff size={15} stroke={1.75} /> : <IconEye size={15} stroke={1.75} />}
      </button>
    </div>
  );
}

function AddForm({ kind, existingNames, takenUsernames, onAdd, onCancel, busy }) {
  const t = KIND_TEXT[kind];
  const [namesText, setNamesText] = useState('');
  const [username, setUsername] = useState('');
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [password, setPassword] = useState('');
  const names = splitNames(namesText);
  const fresh = names.filter(n => !existingNames.includes(n));
  const already = names.filter(n => existingNames.includes(n));
  const generated = uniqueEmrUsernames(fresh, takenUsernames);
  const single = fresh.length === 1;
  const singleUsername = usernameEdited ? username : (generated[0] || '');

  const submit = (e) => {
    e.preventDefault();
    if (!fresh.length) return;
    const usernames = single ? [singleUsername.trim()] : generated;
    onAdd(fresh.map((name, i) => ({ name, emr_username: usernames[i], emr_password: password })));
  };

  return (
    <form onSubmit={submit} aria-label={`Thêm ${t.one}`} style={{ marginTop: 10, padding: 10, borderRadius: 6, background: C.surface2, border: `1px solid ${C.border2}`, display: 'grid', gap: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 2fr) minmax(120px, 1fr) minmax(140px, 1fr)', gap: 8, alignItems: 'start' }}>
        <label style={{ display: 'grid', gap: 3, fontSize: FS.xs, color: C.text2 }}>
          Họ tên
          <textarea value={namesText} onChange={e => setNamesText(e.target.value)} rows={names.length > 1 ? 3 : 1} autoFocus
            aria-label={`Họ tên ${t.one} cần thêm`} placeholder="Vd: Hoàng Minh Tú (dán nhiều tên, cách nhau dấu phẩy)"
            style={{ ...INPUT_STYLE, height: 'auto', minHeight: 30, padding: '5px 8px', resize: 'vertical' }} />
        </label>
        <label style={{ display: 'grid', gap: 3, fontSize: FS.xs, color: C.text2 }}>
          Tên đăng nhập EMR
          {single || !fresh.length ? (
            <input value={singleUsername} onChange={e => { setUsername(e.target.value); setUsernameEdited(true); }}
              aria-label="Tên đăng nhập EMR của người cần thêm" placeholder="Tự gợi ý theo tên" autoComplete="off" style={INPUT_STYLE} />
          ) : (
            <div style={{ fontSize: FS.xs, color: C.text, lineHeight: 1.6 }}>
              {fresh.map((n, i) => <div key={n}>{n} → <code>{generated[i]}</code></div>)}
            </div>
          )}
        </label>
        <label style={{ display: 'grid', gap: 3, fontSize: FS.xs, color: C.text2 }}>
          {fresh.length > 1 ? 'Mật khẩu (dùng chung)' : 'Mật khẩu EMR'}
          <PasswordInput value={password} onChange={e => setPassword(e.target.value)} label="Mật khẩu EMR của người cần thêm" placeholder="Để trống: nhập sau" />
        </label>
      </div>
      {already.length > 0 && (
        <div style={{ fontSize: FS.xs, color: C.amber }}>Đã có trong danh sách, bỏ qua: {already.join(', ')}.</div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Btn type="submit" variant="solidPrimary" icon={IconPlus} loading={busy} disabled={!fresh.length || (single && !singleUsername.trim())}>
          {fresh.length > 1 ? `Thêm ${fresh.length} ${t.one}` : `Thêm ${t.one}`}
        </Btn>
        <Btn icon={IconX} onClick={onCancel} disabled={busy}>Huỷ</Btn>
        {kind === 'nurse' && <span style={{ fontSize: FS.xs, color: C.text3 }}>Người mới được thêm luôn vào Lịch điều dưỡng.</span>}
      </div>
    </form>
  );
}

export default function EmrPeoplePanel({ kind = 'nurse', toast, onSaved }) {
  const t = KIND_TEXT[kind];
  const [rows, setRows] = useState(null);
  const [allAccounts, setAllAccounts] = useState([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState({}); // name -> { state: 'pending'|'saving'|'saved'|'error', at, message }
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const timers = useRef({});
  const pending = useRef({}); // name -> phần sửa chưa gửi
  const extra = kind === 'doctor' ? { kind: 'doctor' } : {};

  const dirty = Object.values(status).some(s => s.state === 'pending' || s.state === 'saving');
  useUnsavedChangesGuard(dirty);

  const apply = useCallback((accounts, roster) => {
    setAllAccounts(accounts || []);
    const next = kind === 'doctor' ? buildDoctorAccountRows(accounts) : buildNurseAccountRows(roster, accounts);
    // Dòng đang gõ dở giữ nguyên phần đang gõ.
    setRows(prev => next.map(r => (pending.current[r.name] ? ((prev || []).find(p => p.name === r.name) || r) : r)));
  }, [kind]);

  const load = useCallback(async () => {
    try {
      const [settings, accounts] = await Promise.all([
        kind === 'nurse' ? api.getNurseSettings() : Promise.resolve(null),
        api.getNurseEmrAccounts(),
      ]);
      setError('');
      apply(accounts?.accounts || [], settings?.roster || []);
    } catch (e) {
      setError(String(e.message || e));
    }
  }, [kind, apply]);

  useEffect(() => { load(); }, [load]);
  useOnTabReturn(() => load());

  const flush = useCallback(async (name) => {
    const patch = pending.current[name];
    if (!patch) return;
    delete pending.current[name];
    setStatus(s => ({ ...s, [name]: { state: 'saving' } }));
    try {
      const r = await api.updateNurseEmrAccount(name, { ...patch, ...(kind === 'doctor' ? { kind: 'doctor' } : {}) });
      if (r?.status !== 'ok') throw new Error(r?.message || 'Máy chủ không nhận.');
      setStatus(s => (pending.current[name] ? s : { ...s, [name]: { state: 'saved', at: new Date() } }));
      onSaved?.();
    } catch (e) {
      pending.current[name] = { ...patch, ...(pending.current[name] || {}) };
      setStatus(s => ({ ...s, [name]: { state: 'error', message: `Chưa lưu được: ${String(e.message || e)}. Sửa lại ô này để thử lưu lần nữa.` } }));
    }
  }, [kind, onSaved]);

  // Rời màn hình khi còn phần chưa lưu: lưu ngay.
  useEffect(() => () => {
    for (const name of Object.keys(timers.current)) clearTimeout(timers.current[name]);
    for (const name of Object.keys(pending.current)) {
      api.updateNurseEmrAccount(name, { ...pending.current[name], ...(kind === 'doctor' ? { kind: 'doctor' } : {}) }).catch(() => {});
    }
  }, [kind]);

  const change = (name, field, value) => {
    setRows(list => list.map(r => (r.name === name ? { ...r, [field]: value } : r)));
    pending.current[name] = { ...(pending.current[name] || {}), [field]: value };
    setStatus(s => ({ ...s, [name]: { state: 'pending' } }));
    clearTimeout(timers.current[name]);
    timers.current[name] = setTimeout(() => { delete timers.current[name]; flush(name); }, AUTOSAVE_MS);
  };

  const addPeople = async (people) => {
    setBusy(true);
    try {
      let accounts = null;
      for (const p of people) {
        const r = await api.updateNurseEmrAccount(p.name, { emr_username: p.emr_username, emr_password: p.emr_password, ...extra });
        if (r?.status !== 'ok') throw new Error(r?.message || `Máy chủ không nhận ${p.name}.`);
        accounts = r.accounts || accounts;
      }
      let roster = null;
      if (kind === 'nurse') {
        // Lấy lịch mới nhất ngay trước khi ghi, để không ghi đè người vừa thêm ở tab Lịch điều dưỡng.
        const settings = await api.getNurseSettings();
        const current = settings?.roster || [];
        roster = [...new Set([...current, ...people.map(p => p.name)])].sort((a, b) => a.localeCompare(b, 'vi'));
        const s = await api.saveNurseSettings({ roster });
        if (s?.status !== 'ok') throw new Error(s?.message || 'Chưa thêm được vào Lịch điều dưỡng.');
      }
      apply(accounts || allAccounts, roster || []);
      if (kind === 'nurse') await load();
      setAdding(false);
      toast?.(people.length > 1 ? `Đã thêm ${people.length} ${t.one}.` : `Đã thêm ${t.one} ${people[0].name}.`, 'ok');
      onSaved?.();
    } catch (e) {
      toast?.(`Chưa thêm được ${t.one}: ${String(e.message || e)}. Kiểm tra lại rồi bấm Thêm lần nữa.`, 'error');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row) => {
    if (!window.confirm(t.removeConfirm(row.name))) return;
    try {
      clearTimeout(timers.current[row.name]);
      delete pending.current[row.name];
      const hasAccount = allAccounts.some(a => a.name === row.name);
      if (hasAccount) {
        const r = await api.removeNurseEmrAccount(row.name);
        if (r?.status !== 'ok') throw new Error(r?.message || 'Máy chủ không nhận.');
      }
      if (kind === 'nurse' && row.inRoster) {
        const settings = await api.getNurseSettings();
        const roster = (settings?.roster || []).filter(n => n !== row.name);
        const s = await api.saveNurseSettings({ roster });
        if (s?.status !== 'ok') throw new Error(s?.message || 'Chưa bỏ được khỏi Lịch điều dưỡng.');
      }
      setStatus(s => { const next = { ...s }; delete next[row.name]; return next; });
      await load();
      toast?.(`Đã xoá ${t.one} ${row.name}.`, 'ok');
      onSaved?.();
    } catch (e) {
      toast?.(`Chưa xoá được ${row.name}: ${String(e.message || e)}`, 'error');
    }
  };

  const statusText = (row) => {
    const s = status[row.name];
    if (s?.state === 'pending') return <span style={{ color: C.amber }}>Chưa lưu…</span>;
    if (s?.state === 'saving') return <span style={{ color: C.text2 }}>Đang lưu…</span>;
    if (s?.state === 'error') return <span role="alert" style={{ color: C.red }}>{s.message}</span>;
    const saved = s?.state === 'saved'
      ? <span style={{ color: C.green }}>Đã lưu {s.at.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span>
      : null;
    const lack = !row.emr_username ? 'Chưa có tài khoản' : (!row.emr_password ? 'Thiếu mật khẩu' : '');
    if (lack) return <>{saved}{saved && ' · '}<span style={{ color: C.amber }}>{lack}</span></>;
    if (saved) return saved;
    return null;
  };

  const visible = useMemo(() => (rows || []).filter(r => matchesSearch(r, query)), [rows, query]);
  const existingNames = useMemo(() => [...new Set([...(rows || []).map(r => r.name), ...allAccounts.map(a => a.name)])], [rows, allAccounts]);
  const takenUsernames = useMemo(() => allAccounts.map(a => a.emr_username).filter(Boolean), [allAccounts]);
  const missing = (rows || []).filter(r => !r.emr_username || !r.emr_password).length;

  return (
    <section style={{ padding: 12, background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>{t.title}</div>
        {rows && <span style={{ fontSize: FS.sm, color: C.text2 }}>{rows.length} người{missing ? ` · ${missing} chưa đủ tài khoản` : ''}</span>}
        <div style={{ flex: 1 }} />
        <div style={{ position: 'relative', width: 220, maxWidth: '100%' }}>
          <IconSearch size={14} stroke={1.75} color={C.text3} aria-hidden="true" style={{ position: 'absolute', left: 8, top: 8 }} />
          <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm tên hoặc tài khoản"
            aria-label={`Tìm ${t.one}`} style={{ ...INPUT_STYLE, paddingLeft: 26 }} />
        </div>
        {!adding && <Btn variant="solidPrimary" icon={IconPlus} onClick={() => setAdding(true)}>Thêm {t.one}</Btn>}
      </div>
      <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 4, lineHeight: 1.5 }}>{t.intro}</div>

      {adding && (
        <AddForm kind={kind} existingNames={existingNames} takenUsernames={takenUsernames} busy={busy}
          onAdd={addPeople} onCancel={() => setAdding(false)} />
      )}

      {error && <div role="alert" style={{ marginTop: 8, color: C.red, fontSize: FS.sm }}>Không tải được danh sách {t.one}: {error}. Chuyển sang mục khác rồi quay lại để thử lại.</div>}
      {rows == null && !error ? (
        <div role="status" aria-busy="true" aria-label={`Đang tải danh sách ${t.one}`} style={{ marginTop: 10 }}><SkeletonTable rows={4} cols={4} /></div>
      ) : rows && rows.length === 0 ? (
        <div style={{ marginTop: 10, fontSize: FS.sm, color: C.text2 }}>{t.empty}</div>
      ) : rows && (
        <div style={{ overflowX: 'auto', marginTop: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 620 }}>
            <colgroup><col style={{ width: '30%' }} /><col style={{ width: '22%' }} /><col style={{ width: '24%' }} /><col /><col style={{ width: 40 }} /></colgroup>
            <thead>
              <tr>
                {['Họ tên', 'Tên đăng nhập EMR', 'Mật khẩu EMR', '', ''].map((h, i) => (
                  <th key={i} style={{ textAlign: 'left', padding: '6px 8px', fontSize: FS.xs, color: C.text2, borderBottom: `1px solid ${C.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map(row => (
                <tr key={row.name} style={{ borderBottom: `1px solid ${C.border2}` }}>
                  <td style={{ padding: '4px 8px', fontSize: FS.md, color: C.text }}>
                    {row.name}
                    {!row.inRoster && <div style={{ fontSize: FS.xs, color: C.text3 }}>Không còn trong Lịch điều dưỡng</div>}
                  </td>
                  <td style={{ padding: '4px 8px' }}>
                    <input value={row.emr_username} onChange={e => change(row.name, 'emr_username', e.target.value)}
                      placeholder="Tài khoản EMR" aria-label={`Tài khoản EMR của ${row.name}`} autoComplete="off" style={INPUT_STYLE} />
                  </td>
                  <td style={{ padding: '4px 8px' }}>
                    <PasswordInput value={row.emr_password} onChange={e => change(row.name, 'emr_password', e.target.value)} label={`Mật khẩu EMR của ${row.name}`} />
                  </td>
                  <td style={{ padding: '4px 8px', fontSize: FS.xs }}>{statusText(row)}</td>
                  <td style={{ padding: '4px 4px' }}>
                    <button type="button" className="emr-icon-btn emr-icon-btn--danger" onClick={() => remove(row)}
                      aria-label={`Xoá ${t.one} ${row.name}`} title={`Xoá ${t.one}`} style={{ width: 30, height: 30 }}>
                      <IconTrash size={16} stroke={1.75} />
                    </button>
                  </td>
                </tr>
              ))}
              {!visible.length && (
                <tr><td colSpan={5} style={{ padding: '10px 8px', fontSize: FS.sm, color: C.text2 }}>Không có ai khớp "{query}".</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
