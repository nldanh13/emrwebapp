// src/components/accounts/EmrAccountsSection.jsx — Thiết lập tài khoản → Tài khoản EMR.
// Bố cục:
//   - "Cần chú ý": chỉ hiện khi có tài khoản khai ở nhiều chỗ hoặc điều dưỡng chưa có tài khoản
//     (máy chủ tính sẵn, GET /api/emr-accounts/overview, không có mật khẩu).
//   - Bốn mục con, mỗi lúc một mục: Điều dưỡng, Bác sĩ phòng khám (cùng một kiểu bảng có Thêm/Xoá,
//     EmrPeoplePanel), Đọc song song, Tài khoản chung & tổng hợp (tài khoản trong secrets.json, bảng
//     mọi tài khoản EMR, ghi chú máy góp sức).
// Mục đã mở được giữ lại khi đổi mục để không mất phần đang gõ dở.

import { useCallback, useEffect, useState } from 'react';
import { C, FS } from '../../tokens.js';
import { Badge, Segmented } from '../shared.jsx';
import * as api from '../../api.js';
import { useOnTabReturn } from '../../hooks/useTabActivity.js';
import { SkeletonLines, SkeletonTable } from '../Skeleton.jsx';
import EmrPeoplePanel from './EmrPeoplePanel.jsx';
import FetchAccountsPanel from '../FetchAccountsPanel.jsx';

const USE_TONE = {
  shared: [C.blue, C.blueBg],
  hchanh: [C.blue, C.blueBg],
  nurse: [C.green, C.greenBg],
  doctor: [C.green, C.greenBg],
  read: [C.amber, C.amberBg],
};

function Card({ children }) {
  return <section style={{ padding: 12, background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8 }}>{children}</section>;
}

export function SharedAccountCard({ overview }) {
  const rows = [
    ['Tài khoản chung', overview?.shared, 'Quét danh sách, lấy dữ liệu, xem trước; nhập liệu khi người ca làm chưa có tài khoản riêng. Bắt buộc.'],
    ['Tài khoản Hành chánh', overview?.hchanh, 'Module Hành chánh / Kiểm hồ sơ. Chỉ cần nếu dùng module này.'],
  ];
  return (
    <Card>
      <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>Tài khoản chung của app</div>
      {!overview ? <div style={{ marginTop: 8 }}><SkeletonLines lines={2} /></div> : <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
        {rows.map(([label, info, use]) => (
          <div key={label} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline', fontSize: FS.sm, color: C.text2 }}>
            <b style={{ color: C.text, minWidth: 160 }}>{label}</b>
            {info?.configured
              ? <span><code>{info.username}</code> · lấy từ {info.source}</span>
              : <span style={{ color: label === 'Tài khoản chung' ? C.red : C.text3 }}>Chưa khai</span>}
            <span style={{ flexBasis: '100%', fontSize: FS.xs, color: C.text3 }}>{use}</span>
          </div>
        ))}
      </div>}
      <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 8, lineHeight: 1.5 }}>
        Hai tài khoản này chứa mật khẩu dùng chung nên chỉ sửa trên máy chủ: mở <code>secrets/secrets.json</code>,
        sửa <code>emr.username</code>/<code>emr.password</code> (hoặc <code>hchanh.*</code>), rồi khởi động lại máy chủ lúc không
        có tác vụ đang chạy. Kiểm tra bằng <code>npm run secrets:check</code>.
      </div>
    </Card>
  );
}

export function EmrAccountsOverviewTable({ overview }) {
  const accounts = overview?.accounts || [];
  return (
    <Card>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>Tất cả tài khoản EMR</div>
        {overview && (overview.duplicate_count
          ? <Badge text={`${overview.duplicate_count} tài khoản khai ở nhiều chỗ`} bg={C.amberBg} color={C.amber} />
          : <Badge text="Không có tài khoản khai trùng" bg={C.greenBg} color={C.green} />)}
      </div>
      <div style={{ fontSize: FS.sm, color: C.text2, marginTop: 4, lineHeight: 1.5 }}>
        Mỗi dòng là một tài khoản EMR và mọi chỗ đang khai nó. Tài khoản khai ở nhiều chỗ thì mỗi chỗ giữ một bản mật
        khẩu: đổi mật khẩu EMR phải sửa đủ các chỗ, hoặc bỏ bớt chỗ không cần.
      </div>
      {!overview ? (
        <div role="status" aria-busy="true" aria-label="Đang tải tổng hợp tài khoản EMR" style={{ marginTop: 10 }}><SkeletonTable rows={3} cols={3} /></div>
      ) : !accounts.length ? (
        <div style={{ marginTop: 10, fontSize: FS.sm, color: C.text2 }}>Chưa khai tài khoản EMR nào. Khai tài khoản chung trong <code>secrets/secrets.json</code> trước.</div>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Tài khoản EMR', 'Dùng vào việc', 'Lưu ý'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: FS.xs, color: C.text2, borderBottom: `1px solid ${C.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {accounts.map(acc => (
                <tr key={acc.username.toLowerCase()} style={{ borderBottom: `1px solid ${C.border2}`, background: acc.duplicate ? C.amberBg : 'transparent' }}>
                  <td style={{ padding: '6px 8px', fontSize: FS.sm, color: C.text, whiteSpace: 'nowrap' }}><code>{acc.username}</code></td>
                  <td style={{ padding: '6px 8px' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {acc.uses.map((u, i) => {
                        const [color, bg] = USE_TONE[u.use] || [C.text2, C.surface2];
                        return <Badge key={i} text={`${u.label}${u.owner ? `: ${u.owner}` : ''}${u.enabled === false ? ' (đang tắt)' : ''}`} bg={bg} color={color} />;
                      })}
                    </div>
                  </td>
                  <td style={{ padding: '6px 8px', fontSize: FS.xs, color: C.text2, maxWidth: 360 }}>{acc.notes.join(' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function HelperMachinesNote() {
  return (
    <Card>
      <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>Máy góp sức lấy dữ liệu</div>
      <div style={{ fontSize: FS.sm, color: C.text2, marginTop: 4, lineHeight: 1.5 }}>
        Máy góp sức dùng phiên EMR mà người dùng máy đó tự đăng nhập; app không giữ tài khoản hay mật khẩu nào của họ,
        nên không có gì để khai ở đây. Xem ai đang góp sức và lấy nút "Góp sức lấy dữ liệu" ở
        <b> Lấy dữ liệu → Lấy chi tiết → Thêm máy góp sức</b>.
      </div>
    </Card>
  );
}

/** Những việc cần sửa: tài khoản khai ở nhiều chỗ, điều dưỡng trong lịch chưa có tài khoản. */
export function AttentionCard({ overview, onOpen }) {
  if (!overview) return null;
  const dups = (overview.accounts || []).filter(a => a.duplicate);
  const missing = overview.nurses_missing || [];
  if (!dups.length && !missing.length) {
    return <div style={{ fontSize: FS.sm, color: C.green }}>Không có tài khoản khai trùng; mọi điều dưỡng trong lịch đã có tài khoản EMR.</div>;
  }
  return (
    <section aria-label="Cần chú ý" style={{ padding: '10px 12px', background: C.amberBg, border: `1px solid ${C.amberBorder}`, borderRadius: 8, fontSize: FS.sm, color: C.text, lineHeight: 1.6 }}>
      <b>Cần chú ý</b>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
        {dups.map(a => (
          <li key={a.username}>
            <code>{a.username}</code> đang khai ở {a.uses.length} chỗ ({a.uses.map(u => `${u.label}${u.owner ? `: ${u.owner}` : ''}`).join('; ')}).
            Đổi mật khẩu EMR thì phải sửa đủ các chỗ.
          </li>
        ))}
        {missing.length > 0 && (
          <li>
            {missing.length} điều dưỡng chưa có tài khoản EMR ({missing.join(', ')}): ca của họ nhập bằng tài khoản chung.{' '}
            <button type="button" onClick={() => onOpen?.('nurse')} style={{ border: 0, padding: 0, background: 'none', color: C.blue, cursor: 'pointer', font: 'inherit', textDecoration: 'underline' }}>Khai ngay</button>
          </li>
        )}
      </ul>
    </section>
  );
}

const SUB_KEY = 'emr_account_subsection_v1';
const SUBSECTIONS = [
  { value: 'nurse', label: 'Điều dưỡng' },
  { value: 'doctor', label: 'Bác sĩ phòng khám' },
  { value: 'read', label: 'Đọc song song' },
  { value: 'shared', label: 'Tài khoản chung & tổng hợp' },
];

function loadSub() {
  try {
    const saved = localStorage.getItem(SUB_KEY);
    if (SUBSECTIONS.some(s => s.value === saved)) return saved;
  } catch { /* trình duyệt chặn lưu trữ */ }
  return 'nurse';
}

export default function EmrAccountsSection({ toast }) {
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');
  const [sub, setSubState] = useState(loadSub);
  const [visited, setVisited] = useState(() => new Set([sub]));

  const load = useCallback(async () => {
    try {
      const data = await api.getEmrAccountOverview();
      setOverview(data);
      setError('');
    } catch (e) {
      setError(String(e.message || e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useOnTabReturn(() => load());

  const setSub = useCallback((next) => {
    setSubState(next);
    setVisited(prev => (prev.has(next) ? prev : new Set([...prev, next])));
    try { localStorage.setItem(SUB_KEY, next); } catch { /* bỏ qua */ }
  }, []);

  const render = (id) => {
    if (id === 'nurse') return <EmrPeoplePanel kind="nurse" toast={toast} onSaved={load} />;
    if (id === 'doctor') return <EmrPeoplePanel kind="doctor" toast={toast} onSaved={load} />;
    if (id === 'read') return <FetchAccountsPanel toast={toast} onSaved={load} />;
    return (
      <div style={{ display: 'grid', gap: 12 }}>
        <SharedAccountCard overview={overview} />
        <EmrAccountsOverviewTable overview={overview} />
        <HelperMachinesNote />
      </div>
    );
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {error && (
        <div role="alert" style={{ padding: '9px 12px', borderRadius: 7, background: C.redBg, border: `1px solid ${C.redBorder}`, fontSize: FS.sm, color: C.red }}>
          Không tải được tổng hợp tài khoản EMR: {error}
        </div>
      )}
      <AttentionCard overview={overview} onOpen={setSub} />
      <div><Segmented label="Loại tài khoản EMR" value={sub} onChange={setSub} options={SUBSECTIONS} /></div>
      {SUBSECTIONS.map(({ value }) => (visited.has(value) || value === sub ? (
        <div key={value} hidden={value !== sub}>{render(value)}</div>
      ) : null))}
    </div>
  );
}
