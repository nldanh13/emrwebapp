// src/components/FetchAccountsPanel.jsx — Tài khoản EMR thêm để "Lấy chi tiết" chạy song song.
// Máy chủ: server/services/fetch_accounts.js. Chỉ quản trị thấy (AccountSettingsTab).
// Mật khẩu không bao giờ được gửi về đây; để trống ô mật khẩu là giữ mật khẩu đã lưu.

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

function rowsFromServer(data) {
  return (data?.accounts || []).map(a => ({ ...a, emr_password: '' }));
}

export default function FetchAccountsPanel({ toast }) {
  const [data, setData] = useState(null);
  const [rows, setRows] = useState([]);
  const [maxParallel, setMaxParallel] = useState(2);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useUnsavedChangesGuard(dirty);

  const apply = useCallback((next) => {
    setData(next);
    setRows(rowsFromServer(next));
    setMaxParallel(next?.max_parallel || 2);
    setDirty(false);
  }, []);

  const load = useCallback(async ({ keepEdits = false } = {}) => {
    try {
      const next = await api.getFetchAccounts();
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
        accounts: rows.map(({ id, name, emr_username, emr_password, enabled }) => ({ id, name, emr_username, emr_password, enabled })),
      });
      apply(next);
      toast?.('Đã lưu tài khoản lấy dữ liệu.', 'ok');
    } catch (e) {
      toast?.(`Chưa lưu được: ${String(e.message || e)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const statusById = new Map((data?.accounts || []).map(a => [a.id, a]));
  const limit = data?.max_parallel_limit || 4;
  const usableCount = (data?.accounts || []).filter(a => a.usable).length;
  const effective = Math.min(maxParallel, 1 + usableCount);

  return (
    <div style={{ marginTop: 18, padding: 12, background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 420px' }}>
          <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>Tài khoản EMR để lấy dữ liệu song song</div>
          <div style={{ fontSize: FS.sm, color: C.text2, marginTop: 4, lineHeight: 1.5 }}>
            Khai thêm tài khoản EMR chỉ dùng để đọc. Bước <b>Lấy chi tiết</b> sẽ chia danh sách người bệnh cho tài khoản
            chung và các tài khoản này chạy cùng lúc, nên nhanh hơn. Nên dùng tài khoản không ai dùng hằng ngày, vì EMR có
            thể đăng xuất người đang dùng cùng tài khoản. Tài khoản đã dùng để nhập liệu sẽ không được dùng.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {dirty && <Badge text="Chưa lưu" bg={C.amberBg} color={C.amber} />}
          <Btn onClick={() => { setRows(list => [...list, { id: '', name: '', emr_username: '', emr_password: '', enabled: true }]); setDirty(true); }}>
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
                {['Tên gợi nhớ', 'Tên đăng nhập EMR', 'Mật khẩu', 'Dùng', 'Trạng thái', ''].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: FS.xs, color: C.text2, borderBottom: `1px solid ${C.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const saved = row.id ? statusById.get(row.id) : null;
                return (
                  <tr key={row.id || `new-${i}`}>
                    <td style={{ padding: '5px 8px', minWidth: 140 }}>
                      <input style={INPUT_STYLE} value={row.name} placeholder="vd. Tài khoản đọc 1" onChange={e => edit(i, { name: e.target.value })} />
                    </td>
                    <td style={{ padding: '5px 8px', minWidth: 140 }}>
                      <input style={INPUT_STYLE} value={row.emr_username} autoComplete="off" onChange={e => edit(i, { emr_username: e.target.value })} />
                    </td>
                    <td style={{ padding: '5px 8px', minWidth: 150 }}>
                      <input style={INPUT_STYLE} type="password" autoComplete="new-password" value={row.emr_password}
                        placeholder={saved?.has_password ? 'Đã lưu, để trống nếu không đổi' : 'Nhập mật khẩu'}
                        onChange={e => edit(i, { emr_password: e.target.value })} />
                    </td>
                    <td style={{ padding: '5px 8px' }}>
                      <input type="checkbox" checked={row.enabled !== false} aria-label="Dùng tài khoản này" onChange={e => edit(i, { enabled: e.target.checked })} />
                    </td>
                    <td style={{ padding: '5px 8px', fontSize: FS.xs, color: saved?.usable ? C.green : C.text2, maxWidth: 260 }}>
                      {!saved ? 'Chưa lưu' : saved.usable ? 'Sẵn sàng' : saved.note}
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
