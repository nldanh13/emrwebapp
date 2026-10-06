// Thiết bị tin cậy: đăng ký máy/điện thoại này, xác nhận bằng mã 8 số (thiết bị đầu tiên), duyệt
// hoặc thu hồi thiết bị khác. Thiết bị tin cậy: mở lại không phải đăng nhập, mọi yêu cầu tự ký.
import { useCallback, useEffect, useState } from 'react';
import { C, FS } from '../tokens.js';
import { Btn, Spinner } from './shared.jsx';
import { SkeletonLines } from './Skeleton.jsx';
import * as api from '../api.js';
import { ensureDeviceKey, getDeviceId, setDeviceId } from '../utils/deviceTrust.js';
import { formatWhen } from './research/researchFormat.js';

const STATUS = {
  trusted: ['Tin cậy', C.green, C.greenBg],
  pending: ['Chờ duyệt', C.amber, C.amberBg],
  revoked: ['Đã thu hồi', C.text3, C.surface2],
};

const INPUT = { height: 30, padding: '0 9px', borderRadius: 6, border: `1px solid ${C.border}`, fontSize: FS.sm, fontFamily: 'inherit', color: C.text, background: C.surface };

function guessName() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/iPhone|Android.+Mobile/i.test(ua)) return 'Điện thoại của tôi';
  if (/iPad|Android/i.test(ua)) return 'Máy tính bảng';
  return 'Máy tính';
}

function Badge({ status }) {
  const [label, color, bg] = STATUS[status] || [status, C.text2, C.surface2];
  return <span style={{ fontSize: FS.xs, fontWeight: 700, color, background: bg, borderRadius: 4, padding: '1px 7px' }}>{label}</span>;
}

export default function DeviceTrustPanel({ isAdmin = false, toast }) {
  const [me, setMe] = useState(null);
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [name, setName] = useState(guessName);
  const [code, setCode] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [status, list] = await Promise.all([api.getDeviceStatus(), api.listDevices()]);
      const localId = await getDeviceId();
      setMe({ ...status, localId });
      setDevices(list.devices || []);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (key, fn, okMsg) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      if (okMsg) toast?.(okMsg, 'ok');
      await load();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy('');
    }
  };

  const register = () => run('register', async () => {
    const jwk = await ensureDeviceKey();
    const r = await api.registerDevice(name.trim() || guessName(), jwk);
    await setDeviceId(r.device.id);
  }, 'Đã đăng ký thiết bị này. Chờ xác nhận.');

  const confirmCode = () => run('code', async () => {
    if (!/^\d{8}$/.test(code.trim())) throw new Error('Mã xác nhận gồm 8 chữ số.');
    await api.approveDevice(me.localId, code.trim());
    api.rememberAuthOnTrustedDevice(true);
    setCode('');
  }, 'Thiết bị này đã tin cậy. Lần sau mở lại không phải đăng nhập.');

  if (loading) return <div role="status" aria-busy="true" aria-label="Đang tải thiết bị tin cậy" style={{ padding: 12 }}><SkeletonLines lines={3} /></div>;

  const local = me?.local_only;
  const thisDevice = devices.find(d => d.id === me?.localId) || me?.device || null;
  const thisStatus = me?.trusted ? 'trusted' : (thisDevice?.status || (me?.localId ? 'pending' : ''));

  return (
    <section aria-labelledby="device-trust-title" style={{ border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface, padding: 14, display: 'grid', gap: 10 }}>
      <div>
        <h3 id="device-trust-title" style={{ margin: 0, fontSize: FS.md, fontWeight: 700, color: C.text }}>Thiết bị tin cậy</h3>
        <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 2, lineHeight: 1.5 }}>
          Chỉ thiết bị tin cậy được xem dữ liệu thật. Đăng ký một lần; sau đó mở lại không phải đăng nhập.
          Khóa của thiết bị nằm trong trình duyệt này, không chép sang máy khác được.
        </div>
      </div>

      {local ? (
        <div style={{ fontSize: FS.sm, color: C.text2 }}>Đang chạy trên chính máy này (không đăng nhập), không cần thiết bị tin cậy.</div>
      ) : thisStatus === 'trusted' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: FS.sm, color: C.text }}>
          <Badge status="trusted" /> Thiết bị này: <b>{thisDevice?.name || 'đã tin cậy'}</b>
        </div>
      ) : thisStatus === 'pending' ? (
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ fontSize: FS.sm, color: C.text }}><Badge status="pending" /> Thiết bị này: <b>{thisDevice?.name}</b> — chờ xác nhận.</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <input aria-label="Mã xác nhận 8 số" inputMode="numeric" maxLength={8} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} placeholder="Mã 8 số" style={{ ...INPUT, width: 120, letterSpacing: 2 }} />
            <Btn variant="solidPrimary" onClick={confirmCode} disabled={busy === 'code'} style={{ height: 30 }}>{busy === 'code' ? <><Spinner size={10} /> Đang xác nhận…</> : 'Xác nhận'}</Btn>
          </div>
          <div style={{ fontSize: FS.xs, color: C.text3, lineHeight: 1.5 }}>
            Lấy mã trên máy chủ: <code>node scripts/users_cli.js ma-tin-cay</code> (dùng một lần, trong 10 phút).
            Hoặc nhờ quản trị bấm Duyệt từ một thiết bị đã tin cậy.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <input aria-label="Tên thiết bị" value={name} onChange={e => setName(e.target.value)} style={{ ...INPUT, width: 220 }} />
          <Btn variant="solidPrimary" onClick={register} disabled={busy === 'register'} style={{ height: 30 }}>{busy === 'register' ? <><Spinner size={10} /> Đang đăng ký…</> : 'Đăng ký thiết bị này'}</Btn>
        </div>
      )}

      {error && <div role="alert" style={{ fontSize: FS.xs, color: C.red }}>{error}</div>}

      {devices.length > 0 && (
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={{ fontSize: FS.xs, fontWeight: 700, color: C.text2 }}>{isAdmin ? 'Mọi thiết bị' : 'Thiết bị của bạn'}</div>
          {devices.map(d => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: FS.sm, padding: '6px 0', borderTop: `1px solid ${C.border2}` }}>
              <Badge status={d.status} />
              <b style={{ color: C.text }}>{d.name}</b>
              {isAdmin && <span style={{ color: C.text3, fontSize: FS.xs }}>{d.user_id}</span>}
              {d.id === me?.localId && <span style={{ color: C.blue, fontSize: FS.xs }}>(máy này)</span>}
              <span style={{ color: C.text3, fontSize: FS.xs }}>{d.last_seen_at ? `dùng lúc ${formatWhen(d.last_seen_at)}` : `đăng ký ${formatWhen(d.created_at)}`}</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                {isAdmin && d.status === 'pending' && me?.trusted && (
                  <Btn onClick={() => run(`a${d.id}`, () => api.approveDevice(d.id), `Đã duyệt "${d.name}".`)} disabled={busy === `a${d.id}`} style={{ height: 26, fontSize: FS.xs }}>Duyệt</Btn>
                )}
                {d.status !== 'revoked' && (
                  <Btn onClick={() => run(`r${d.id}`, () => api.revokeDevice(d.id), `Đã thu hồi "${d.name}".`)} disabled={busy === `r${d.id}`} style={{ height: 26, fontSize: FS.xs }}>Thu hồi</Btn>
                )}
              </span>
            </div>
          ))}
          {isAdmin && !me?.trusted && devices.some(d => d.status === 'pending') && (
            <div style={{ fontSize: FS.xs, color: C.text3 }}>Muốn duyệt thiết bị khác, hãy mở trang này trên một thiết bị đã tin cậy.</div>
          )}
        </div>
      )}
    </section>
  );
}
