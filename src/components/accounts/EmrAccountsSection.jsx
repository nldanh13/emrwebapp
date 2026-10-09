// src/components/accounts/EmrAccountsSection.jsx — Thiết lập tài khoản → Tài khoản EMR.
// Một chỗ cho mọi tài khoản EMR app giữ:
//   1. Tổng hợp: mỗi tài khoản EMR dùng vào việc gì, khai ở mấy chỗ (máy chủ tính sẵn,
//      GET /api/emr-accounts/overview, không có mật khẩu).
//   2. Tài khoản chung (chỉ xem; sửa trong secrets/secrets.json, xem docs/SECRETS.md).
//   3. Tài khoản theo điều dưỡng (nhập liệu theo lịch) — trước đây ở Lịch điều dưỡng.
//   4. Tài khoản đọc song song (Lấy chi tiết).
//   5. Máy góp sức: không có tài khoản nào để khai, chỉ chỉ chỗ xem.
// Tài khoản EMR dự phòng của từng người dùng Data Hub sửa ở mục Người dùng Data Hub (cùng hộp sửa
// người dùng), bảng tổng hợp vẫn liệt kê để thấy trùng.

import { useCallback, useEffect, useState } from 'react';
import { C, FS } from '../../tokens.js';
import { Badge } from '../shared.jsx';
import * as api from '../../api.js';
import { useOnTabReturn } from '../../hooks/useTabActivity.js';
import { SkeletonLines, SkeletonTable } from '../Skeleton.jsx';
import NurseEmrAccountsPanel from './NurseEmrAccountsPanel.jsx';
import FetchAccountsPanel from '../FetchAccountsPanel.jsx';

const USE_TONE = {
  shared: [C.blue, C.blueBg],
  hchanh: [C.blue, C.blueBg],
  nurse: [C.green, C.greenBg],
  user_fallback: [C.text2, C.surface2],
  read: [C.amber, C.amberBg],
};

function Card({ children }) {
  return <section style={{ padding: 12, background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8 }}>{children}</section>;
}

export function SharedAccountCard({ overview }) {
  const rows = [
    ['Tài khoản chung', overview?.shared, 'Quét danh sách, lấy dữ liệu, xem trước; dự phòng khi nhập liệu. Bắt buộc.'],
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
  const missing = overview?.nurses_missing || [];
  return (
    <Card>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>Tổng hợp tài khoản EMR</div>
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
      {missing.length > 0 && (
        <div style={{ marginTop: 10, fontSize: FS.sm, color: C.amber, lineHeight: 1.5 }}>
          {missing.length} điều dưỡng trong lịch chưa có tài khoản EMR ({missing.join(', ')}): ca của họ sẽ nhập bằng tài khoản
          dự phòng. Khai ở bảng "Tài khoản EMR của từng điều dưỡng" bên dưới.
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

export default function EmrAccountsSection({ toast, refreshKey = 0 }) {
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.getEmrAccountOverview();
      setOverview(data);
      setError('');
    } catch (e) {
      setError(String(e.message || e));
    }
  }, []);

  // refreshKey đổi khi mục Người dùng Data Hub vừa sửa tài khoản EMR dự phòng.
  useEffect(() => { load(); }, [load, refreshKey]);
  useOnTabReturn(() => load());

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {error && (
        <div role="alert" style={{ padding: '9px 12px', borderRadius: 7, background: C.redBg, border: `1px solid ${C.redBorder}`, fontSize: FS.sm, color: C.red }}>
          Không tải được tổng hợp tài khoản EMR: {error}
        </div>
      )}
      <EmrAccountsOverviewTable overview={overview} />
      <SharedAccountCard overview={overview} />
      <NurseEmrAccountsPanel onSaved={load} />
      <FetchAccountsPanel toast={toast} onSaved={load} />
      <HelperMachinesNote />
    </div>
  );
}
