// src/components/FetchAccountsPanel.jsx — Tài khoản EMR thêm để "Lấy chi tiết" chạy song song.
// Máy chủ: server/services/fetch_accounts.js. Chỉ quản trị thấy (Thiết lập tài khoản → Tài khoản EMR).
// Mật khẩu không bao giờ được gửi về đây; để trống ô mật khẩu là giữ mật khẩu đã lưu.
// Mỗi dòng chọn một điều dưỡng/bác sĩ đã lưu (máy chủ lấy tên đăng nhập, mật khẩu của người đó lúc chạy,
// không chép mật khẩu sang) hoặc "Gõ tay tài khoản khác".

import { useCallback, useEffect, useState } from 'react';
import { C, FS } from '../tokens.js';
import { Btn, Badge } from './shared.jsx';
import * as api from '../api.js';
import { useOnTabReturn, useUnsavedChangesGuard } from '../hooks/useTabActivity.js';

const INPUT_STYLE = {
  width: '100%', padding: '5px 8px', borderRadius: 6,
  background: C.surface, border: `1px solid ${C.border}`,
  color: C.text, fontSize: FS.sm, boxSizing: 'border-box', fontFamily: 'inherit',
};

const MANUAL = '@manual';

function rowsFromServer(data) {
  return (data?.accounts || []).map(a => ({ ...a, source: a.source === 'saved' ? 'saved' : 'manual', emr_password: '' }));
}

/** Người đã lưu để chọn: { nurses, doctors } — mỗi người { name, emr_username, ready }. */
export function savedPeopleOptions(accounts = []) {
  const toOpt = (a) => ({ name: a.name, emr_username: a.emr_username || '', ready: Boolean(a.emr_username && a.emr_password) });
  const byName = (a, b) => a.name.localeCompare(b.name, 'vi');
  return {
    nurses: accounts.filter(a => a.kind !== 'doctor').map(toOpt).sort(byName),
    doctors: accounts.filter(a => a.kind === 'doctor').map(toOpt).sort(byName),
  };
}

/** Phần gửi lên máy chủ cho một dòng: chọn người đã lưu thì chỉ gửi tên. */
export function fetchAccountPayload(row) {
  if (row.source === 'saved') return { id: row.id, source: 'saved', name: row.name, enabled: row.enabled };
  const { id, name, emr_username, emr_password, enabled } = row;
  return { id, name, emr_username, emr_password, enabled };
}

export default function FetchAccountsPanel({ toast, onSaved }) {
  const [data, setData] = useState(null);
  const [rows, setRows] = useState([]);
  const [maxParallel, setMaxParallel] = useState(2);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [people, setPeople] = useState({ nurses: [], doctors: [] });

  useUnsavedChangesGuard(dirty);

  const apply = useCallback((next) => {
    setData(next);
    setRows(rowsFromServer(next));
    setMaxParallel(next?.max_parallel || 2);
    setDirty(false);
  }, []);

  const load = useCallback(async ({ keepEdits = false } = {}) => {
    try {
      const [next, saved] = await Promise.all([
        api.getFetchAccounts(),
        api.getNurseEmrAccounts().catch(() => ({ accounts: [] })),
      ]);
      setPeople(savedPeopleOptions(saved?.accounts || []));
      setError('');
      if (keepEdits) setData(next); else apply(next);
    } catch (e) {
      setError(String(e.message || e));
    }
  }, [apply]);

  useEffect(() => { load(); }, [load]);
  // Quay lại tab: cập nhật trạng thái từng tài khoản, không xoá phần đang sửa dở.
  useOnTabReturn(() => load({ keepEdits: dirty }));

  const edit = (index, patch) => {
    setRows(list => list.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const next = await api.saveFetchAccounts({
        max_parallel: maxParallel,
        accounts: rows.filter(r => r.source !== 'saved' || r.name).map(fetchAccountPayload),
      });
      apply(next);
      toast?.('Đã lưu tài khoản lấy dữ liệu.', 'ok');
      onSaved?.();
    } catch (e) {
      toast?.(`Chưa lưu được: ${String(e.message || e)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const statusById = new Map((data?.accounts || []).map(a => [a.id, a]));
  const allPeople = [...people.nurses, ...people.doctors];
  const savedUsername = (row) => allPeople.find(p => p.name === row.name)?.emr_username || '';
  const takenNames = (index) => new Set(rows.filter((r, j) => j !== index && r.source === 'saved' && r.name).map(r => r.name));
  const limit = data?.max_parallel_limit || 4;
  const usableCount = (data?.accounts || []).filter(a => a.usable).length;
  const effective = Math.min(maxParallel, 1 + usableCount);

  return (
    <div style={{ padding: 12, background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 420px' }}>
          <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>Tài khoản EMR để lấy dữ liệu song song</div>
          <div style={{ fontSize: FS.sm, color: C.text2, marginTop: 4, lineHeight: 1.5 }}>
            Bước <b>Lấy chi tiết</b> chia danh sách người bệnh cho tài khoản chung và các tài khoản ở đây chạy cùng lúc, nên
            nhanh hơn. Chọn điều dưỡng hoặc bác sĩ đã lưu (dùng luôn mật khẩu đã lưu), hoặc gõ tay tài khoản khác. App không
            lấy dữ liệu cùng lúc với nhập liệu, nhưng nếu chính người đó đang mở EMR thì EMR có thể đăng xuất họ: nên chọn
            người không làm lúc lấy dữ liệu.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {dirty && <Badge text="Chưa lưu" bg={C.amberBg} color={C.amber} />}
          <Btn onClick={() => { setRows(list => [...list, { id: '', source: 'saved', name: '', emr_username: '', emr_password: '', enabled: true }]); setDirty(true); }}>
            + Thêm tài khoản đọc
          </Btn>
          <Btn variant="solidPrimary" loading={saving} disabled={!dirty} onClick={save}>Lưu</Btn>
        </div>
      </div>

      {error && <div style={{ marginTop: 8, color: C.red, fontSize: FS.sm }}>Không tải được danh sách: {error}</div>}

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: FS.sm, color: C.text2 }}>
        Chạy tối đa
        <select value={maxParallel} onChange={e => { setMaxParallel(Number(e.target.value)); setDirty(true); }}
          style={{ ...INPUT_STYLE, width: 'auto' }}>
          {Array.from({ length: limit }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        tài khoản cùng lúc (kể cả tài khoản chung). Hiện dùng được {effective}.
      </label>

      {rows.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Tài khoản', 'Tên đăng nhập EMR', 'Mật khẩu', 'Dùng', 'Trạng thái', ''].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: FS.xs, color: C.text2, borderBottom: `1px solid ${C.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const saved = row.id ? statusById.get(row.id) : null;
                return (
                  <tr key={row.id || `new-${i}`}>
                    <td style={{ padding: '5px 8px', minWidth: 190 }}>
                      <PersonSelect row={row} people={people} taken={takenNames(i)}
                        onChange={v => edit(i, v === MANUAL
                          ? { source: 'manual', name: '', emr_username: '', emr_password: '' }
                          : { source: 'saved', name: v, emr_username: '', emr_password: '' })} />
                      {row.source === 'manual' && (
                        <input style={{ ...INPUT_STYLE, marginTop: 4 }} value={row.name} placeholder="Tên gợi nhớ, vd. Tài khoản đọc 1"
                          aria-label="Tên gợi nhớ" onChange={e => edit(i, { name: e.target.value })} />
                      )}
                    </td>
                    {row.source === 'saved' ? (
                      <>
                        <td style={{ padding: '5px 8px', fontSize: FS.sm, color: C.text }}>
                          {savedUsername(row) ? <code>{savedUsername(row)}</code> : <span style={{ color: C.text3 }}>—</span>}
                        </td>
                        <td style={{ padding: '5px 8px', fontSize: FS.xs, color: C.text2 }}>{row.name ? 'Dùng mật khẩu đã lưu' : ''}</td>
                      </>
                    ) : (
                      <>
                        <td style={{ padding: '5px 8px', minWidth: 140 }}>
                          <input style={INPUT_STYLE} value={row.emr_username} autoComplete="off" aria-label="Tên đăng nhập EMR" onChange={e => edit(i, { emr_username: e.target.value })} />
                        </td>
                        <td style={{ padding: '5px 8px', minWidth: 150 }}>
                          <input style={INPUT_STYLE} type="password" autoComplete="new-password" value={row.emr_password} aria-label="Mật khẩu EMR"
                            placeholder={saved?.has_password ? 'Đã lưu, để trống nếu không đổi' : 'Nhập mật khẩu'}
                            onChange={e => edit(i, { emr_password: e.target.value })} />
                        </td>
                      </>
                    )}
                    <td style={{ padding: '5px 8px' }}>
                      <input type="checkbox" checked={row.enabled !== false} aria-label="Dùng tài khoản này" onChange={e => edit(i, { enabled: e.target.checked })} />
                    </td>
                    <td style={{ padding: '5px 8px', fontSize: FS.xs, color: saved?.usable ? C.green : C.text2, maxWidth: 260 }}>
                      {!saved || saved.name !== row.name || (saved.source || 'manual') !== row.source ? 'Chưa lưu'
                        : saved.usable ? (saved.note || 'Sẵn sàng') : saved.note}
                    </td>
                    <td style={{ padding: '5px 8px' }}>
                      <Btn style={{ fontSize: FS.xs, padding: '2px 10px', color: C.red }}
                        onClick={() => { setRows(list => list.filter((_, j) => j !== i)); setDirty(true); }}>
                        Bỏ
                      </Btn>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PersonSelect({ row, people, taken, onChange }) {
  const value = row.source === 'manual' ? MANUAL : row.name;
  const known = !row.name || row.source === 'manual' || [...people.nurses, ...people.doctors].some(p => p.name === row.name);
  const option = (p) => (
    <option key={p.name} value={p.name} disabled={!p.ready || taken.has(p.name)}>
      {p.name}{p.emr_username ? ` · ${p.emr_username}` : ''}{!p.ready ? ' (chưa đủ tài khoản)' : taken.has(p.name) ? ' (đã chọn)' : ''}
    </option>
  );
  return (
    <select value={value} onChange={e => onChange(e.target.value)} aria-label="Chọn tài khoản đọc"
      style={{ ...INPUT_STYLE, color: value ? C.text : C.text3 }}>
      <option value="" disabled>Chọn điều dưỡng hoặc bác sĩ…</option>
      {!known && <option value={row.name}>{row.name} (không còn tài khoản đã lưu)</option>}
      {people.nurses.length > 0 && <optgroup label="Điều dưỡng">{people.nurses.map(option)}</optgroup>}
      {people.doctors.length > 0 && <optgroup label="Bác sĩ phòng khám">{people.doctors.map(option)}</optgroup>}
      <option value={MANUAL}>Gõ tay tài khoản khác…</option>
    </select>
  );
}
