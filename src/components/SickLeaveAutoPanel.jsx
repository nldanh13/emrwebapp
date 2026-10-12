// Nhập nghỉ ốm lên cổng BHXH tự động (tab Nghỉ ốm). Người dùng chỉ gõ mã CAPTCHA: máy chủ điền tài
// khoản cổng đã lưu, đăng nhập EMR cho công cụ, rồi công cụ (tools/bhyt_selenium_app, gọi qua máy chủ) tự
// quét Danh sách Khám bệnh (phiếu nghỉ) và người bệnh ra viện (giấy ra viện), nhập thật lên cổng các
// hồ sơ đủ dữ liệu. Ca thẻ DN chưa ghi nghỉ ốm chờ người dùng hỏi người bệnh (Có nghỉ / Không nghỉ).
// Trạng thái lượt chạy giữ ở công cụ, giao diện chỉ đọc lại. Xem tools/bhyt_selenium_app/bhyt/auto_run.py.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconCheck, IconLogin, IconPlayerPlay, IconPlayerStop, IconRefresh, IconX } from '@tabler/icons-react';
import { C, FS } from '../tokens.js';
import { Badge, Btn } from './shared.jsx';
import DateField, { formatDmy } from './DateField.jsx';
import * as api from '../api.js';
import { useOnTabReturn } from '../hooks/useTabActivity.js';
import {
  DOC_GRV, DOC_PHIEU, GROUP_LABELS, countGroups, listByDoc, recordProblem, runSummaryLines,
} from '../utils/sickLeaveAuto.js';

// Mọi lời gọi công cụ nhập cổng đi qua máy chủ (/api/bhyt-tool/...), xem server/services/bhyt_tool.js.
const tool = (path) => api.getBhytTool(path);
const postJson = (path, body) => api.postBhytTool(path, body);

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoToDmy(iso) { return formatDmy(iso) || iso; }

const INPUT = {
  height: 32, padding: '0 8px', border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface,
  color: C.text, fontSize: FS.md, fontFamily: 'inherit', minWidth: 0,
};
const LABEL = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: FS.sm, fontWeight: 600, color: C.text2 };

const GROUP_TONE = {
  hoi: { bg: C.amberBg, color: C.amber },
  loi: { bg: C.redBg, color: C.red },
  cho: { bg: C.blueBg, color: C.blue },
  xong: { bg: C.greenBg, color: C.green },
  bo: { bg: C.surface2, color: C.text2 },
};

const PHASE_TEXT = {
  clinic: 'Đang quét phòng khám',
  discharge: 'Đang quét ra viện',
  submit: 'Đang nhập lên cổng',
};

function Card({ title, aside, children }) {
  return (
    <section style={{ border: `1px solid ${C.border2}`, borderRadius: 7, background: C.surface, padding: 12, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: FS.lg, fontWeight: 700, color: C.text }}>{title}</h2>
        {aside && <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>{aside}</div>}
      </div>
      {children}
    </section>
  );
}

// Tài khoản cổng BHXH lưu một lần trên máy chủ (mật khẩu không về đây).
function AccountForm({ account, doctors, onSaved, onCancel, toast }) {
  const [form, setForm] = useState({
    facility_code: account?.facility_code || '', username: account?.username || '', password: '',
    emr_account_name: account?.emr_account_name || '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const r = await api.saveBhytPortalAccount(form);
      if (r.status !== 'ok') throw new Error(r.message);
      onSaved(r.account);
      toast?.('Đã lưu tài khoản cổng BHXH. Từ giờ chỉ cần gõ mã CAPTCHA.', 'ok');
    } catch (err) {
      toast?.(String(err.message || err), 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
        <label style={LABEL}>Mã cơ sở KCB<input value={form.facility_code} onChange={set('facility_code')} style={INPUT} autoComplete="off" /></label>
        <label style={LABEL}>Tên đăng nhập cổng<input value={form.username} onChange={set('username')} style={INPUT} autoComplete="off" /></label>
        <label style={LABEL}>Mật khẩu cổng
          <input type="password" value={form.password} onChange={set('password')} style={INPUT} autoComplete="new-password"
            placeholder={account?.has_password ? 'Để trống = giữ mật khẩu đã lưu' : ''} />
        </label>
        <label style={LABEL}>Tài khoản EMR để đọc giấy
          <select value={form.emr_account_name} onChange={set('emr_account_name')} style={INPUT}>
            <option value="">Tài khoản EMR chung</option>
            <option value="@lich">Bác sĩ theo Lịch phòng khám</option>
            {doctors.filter(d => d.ready).map(d => <option key={d.name} value={d.name}>{d.name}</option>)}
          </select>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Btn type="submit" variant="solidPrimary" loading={saving}>Lưu tài khoản</Btn>
        {onCancel && <Btn onClick={onCancel}>Thôi</Btn>}
      </div>
    </form>
  );
}

function AnswerRow({ record, onAnswer, busy }) {
  const [yes, setYes] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  if (!yes) {
    return (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Btn variant="primary" icon={IconCheck} onClick={() => setYes(true)} disabled={busy}>Có nghỉ</Btn>
        <Btn icon={IconX} onClick={() => onAnswer(record, 'khong')} loading={busy}>Không nghỉ</Btn>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: FS.sm, color: C.text2 }}>
      Nghỉ từ <DateField value={from} onChange={setFrom} label="Nghỉ từ ngày" />
      đến hết <DateField value={to} onChange={setTo} label="Nghỉ đến hết ngày" />
      <Btn variant="solidPrimary" disabled={!from || !to} loading={busy}
        onClick={() => onAnswer(record, 'co', isoToDmy(from), isoToDmy(to))}>Lưu và nhập</Btn>
      <Btn onClick={() => setYes(false)} disabled={busy}>Thôi</Btn>
    </div>
  );
}

function RecordList({ title, list, emptyText, onAnswer, busyId }) {
  const counts = countGroups(list);
  return (
    <Card title={title} aside={(
      <>
        {counts.hoi > 0 && <Badge text={`${counts.hoi} cần hỏi`} bg={C.amberBg} color={C.amber} />}
        {counts.loi > 0 && <Badge text={`${counts.loi} chưa nhập được`} bg={C.redBg} color={C.red} />}
        <Badge text={`${counts.xong}/${list.length - counts.bo} đã nhập`} bg={C.greenBg} color={C.green} />
      </>
    )}>
      {list.length ? list.map(r => {
        const f = r.fields || {};
        const tone = GROUP_TONE[r.group];
        const problem = r.group === 'loi' || r.group === 'bo' ? recordProblem(r) : '';
        const dates = r.doc_type === DOC_GRV
          ? [f.tu_ngay && `vào ${f.tu_ngay.slice(0, 10)}`, f.den_ngay && `ra ${f.den_ngay.slice(0, 10)}`]
          : [f.tu_ngay && `nghỉ ${f.tu_ngay}`, f.den_ngay && `đến ${f.den_ngay}`];
        return (
          <div key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0', borderTop: `1px solid ${C.border2}` }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: FS.md, color: C.text }}>{r.patient_name}</div>
                <div style={{ fontSize: FS.xs, color: C.text2, fontVariantNumeric: 'tabular-nums' }}>
                  {[f.ma_the || f.ma_bhxh, ...dates].filter(Boolean).join(' · ')}
                </div>
                {f.chan_doan && <div style={{ fontSize: FS.xs, color: C.text2 }}>{f.chan_doan}</div>}
              </div>
              <Badge text={GROUP_LABELS[r.group]} bg={tone.bg} color={tone.color} />
            </div>
            {problem && <div style={{ fontSize: FS.xs, color: r.group === 'loi' ? C.red : C.text2 }}>{problem}</div>}
            {r.group === 'hoi' && (
              <>
                <div style={{ fontSize: FS.xs, color: C.amber }}>Thẻ DN, giấy chưa ghi nghỉ ốm: hỏi người bệnh có xin nghỉ ốm không.</div>
                <AnswerRow record={r} onAnswer={onAnswer} busy={busyId === r.id} />
              </>
            )}
          </div>
        );
      }) : <div style={{ fontSize: FS.sm, color: C.text2, padding: '8px 0' }}>{emptyText}</div>}
    </Card>
  );
}

export default function SickLeaveAutoPanel({ toast }) {
  const [available, setAvailable] = useState(null); // null = chưa biết
  const [account, setAccount] = useState(null);
  const [editAccount, setEditAccount] = useState(false);
  const [doctorAccounts, setDoctorAccounts] = useState([]);
  const [captchaImg, setCaptchaImg] = useState('');
  const [captchaText, setCaptchaText] = useState('');
  const [loadingCaptcha, setLoadingCaptcha] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [portalOk, setPortalOk] = useState(false);
  const [emrOk, setEmrOk] = useState(false);
  const [records, setRecords] = useState([]);
  const [auto, setAuto] = useState(null);
  const [worker, setWorker] = useState({ running: false, message: '' });
  const [day, setDay] = useState(todayIso);
  const [khoa, setKhoa] = useState('');
  const [doctor, setDoctor] = useState('');
  const [doctors, setDoctors] = useState([]);
  const [starting, setStarting] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const loadAccount = useCallback(async () => {
    try {
      const [acc, docs] = await Promise.all([api.getBhytPortalAccount(), api.getClinicDoctorAccounts().catch(() => ({}))]);
      setAccount(acc.account || null);
      setDoctorAccounts(Array.isArray(docs?.doctors) ? docs.doctors : []);
    } catch (err) {
      toast?.(String(err.message || 'Không tải được tài khoản cổng BHXH.'), 'error');
    }
  }, [toast]);

  // Danh sách hồ sơ + trạng thái lượt chạy từ công cụ. Công cụ chưa chạy thì giữ nguyên màn hình.
  const lastToolError = useRef('');
  const refresh = useCallback(async () => {
    try {
      const [summary, list] = await Promise.all([tool('/api/summary'), tool('/api/records')]);
      setAvailable(true);
      setAuto(summary.auto || null);
      setWorker(summary.worker || { running: false });
      setRecords(Array.isArray(list.records) ? list.records : []);
      lastToolError.current = '';
      return true;
    } catch (err) {
      lastToolError.current = String(err?.message || '');
      setAvailable(false);
      return false;
    }
  }, []);

  const loadSessions = useCallback(async () => {
    const [p, e, d] = await Promise.all([
      tool('/api/browser/status').catch(() => ({})),
      tool('/api/emr/status').catch(() => ({})),
      tool('/api/emr/grv-defaults').catch(() => null),
    ]);
    setPortalOk(Boolean(p.logged_in));
    setEmrOk(Boolean(e.logged_in));
    if (d) {
      setKhoa(k => k || d.ma_khoa || '');
      setDoctor(x => x || d.doctor_text || '');
      setDoctors(Array.isArray(d.doctors) ? d.doctors : []);
    }
  }, []);

  const load = useCallback(async () => {
    loadAccount();
    if (await refresh()) loadSessions();
  }, [loadAccount, refresh, loadSessions]);

  useEffect(() => { load(); }, [load]);
  useOnTabReturn(load);

  const running = Boolean(auto?.running || worker?.running);
  // ux-rules: polling-ok — chỉ hỏi công cụ khi lượt nhập đang chạy.
  // ux-rules: no-realtime — công cụ nhập cổng là tiến trình riêng, máy chủ app chỉ chuyển tiếp, không đẩy tiến độ.
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => { refresh(); }, 2000);
    return () => clearInterval(id);
  }, [running, refresh]);

  // Công cụ chưa chạy thì khởi động (như bấm start.bat), rồi lấy ảnh CAPTCHA từ cổng.
  const getCaptcha = useCallback(async (fresh = false) => {
    setLoadingCaptcha(true);
    try {
      let ok = await refresh();
      if (!ok) {
        const r = await api.launchBhytTool();
        if (r?.status !== 'ok') throw new Error(r?.message || 'Không khởi động được công cụ nhập cổng BHXH.');
        for (let i = 0; i < 10 && !ok; i += 1) {
          await new Promise(res => setTimeout(res, 500));
          ok = await refresh();
        }
        if (!ok) throw new Error(lastToolError.current || 'Công cụ nhập cổng BHXH chưa sẵn sàng. Thử lại sau giây lát.');
        loadSessions();
      }
      const d = fresh ? await postJson('/api/browser/refresh-captcha') : await tool('/api/browser/captcha');
      setCaptchaImg(d.image || '');
      setCaptchaText('');
    } catch (err) {
      setCaptchaImg('');
      toast?.(String(err.message || 'Không lấy được mã CAPTCHA.'), 'error');
    } finally {
      setLoadingCaptcha(false);
    }
  }, [refresh, loadSessions, toast]);

  const startRun = useCallback(async () => {
    setStarting(true);
    try {
      const d = await postJson('/api/auto-run', { date: day, ma_khoa: khoa, doctor_text: doctor });
      setAuto(d);
      toast?.(`Đã bắt đầu nhập tự động cho ngày ${isoToDmy(day)}.`, 'ok');
    } catch (err) {
      toast?.(String(err.message || 'Không bắt đầu được lượt nhập tự động.'), 'error');
    } finally {
      setStarting(false);
    }
  }, [day, khoa, doctor, toast]);

  const login = useCallback(async (e) => {
    e?.preventDefault?.();
    if (!captchaText.trim()) return;
    setLoggingIn(true);
    try {
      const r = await api.loginBhytPortal(captchaText.trim());
      if (r.status !== 'ok') throw new Error(r.message);
      setPortalOk(Boolean(r.portal?.logged_in));
      setEmrOk(Boolean(r.emr?.logged_in));
      if (!r.portal?.logged_in) {
        toast?.(r.portal?.message || 'Mã CAPTCHA chưa đúng. Gõ lại mã mới.', 'error');
        await getCaptcha();
        return;
      }
      setCaptchaImg('');
      setCaptchaText('');
      if (!r.emr?.logged_in) {
        toast?.(`Đã đăng nhập cổng BHXH, nhưng chưa đăng nhập được EMR: ${r.emr?.message || ''}`, 'error');
        return;
      }
      toast?.('Đã đăng nhập cổng BHXH và EMR. Bắt đầu nhập tự động.', 'ok');
      await startRun();
    } catch (err) {
      toast?.(String(err.message || 'Không đăng nhập được cổng BHXH.'), 'error');
    } finally {
      setLoggingIn(false);
    }
  }, [captchaText, getCaptcha, startRun, toast]);

  const saveDefaults = useCallback(async (nextKhoa, nextDoctor) => {
    if (!nextKhoa.trim() || !nextDoctor.trim()) return;
    try {
      await postJson('/api/emr/grv-defaults', { ma_khoa: nextKhoa, doctor_text: nextDoctor });
    } catch (err) {
      toast?.(String(err.message || 'Không lưu được khoa/bác sĩ mặc định.'), 'error');
    }
  }, [toast]);

  const answer = useCallback(async (record, value, from = '', to = '') => {
    setBusyId(record.id);
    try {
      await postJson(`/api/records/${record.id}/sick-leave`, { answer: value, tu_ngay: from, den_ngay: to });
      if (value === 'co' && portalOk && !running) {
        // Có nghỉ: hồ sơ đủ dữ liệu thì nhập luôn, không chờ lượt sau.
        await postJson('/api/run', { record_ids: [record.id], dry_run: false, confirmation: 'NHẬP THẬT' })
          .then(() => toast?.(`Đang nhập ${record.patient_name} lên cổng.`, 'ok'))
          .catch(err => toast?.(`Đã lưu, nhưng chưa nhập được: ${err.message}`, 'error'));
      } else {
        toast?.(value === 'co' ? 'Đã lưu. Hồ sơ sẽ được nhập ở lượt sau.' : 'Đã ghi không nghỉ ốm, không nhập hồ sơ này.', 'ok');
      }
      await refresh();
    } catch (err) {
      toast?.(String(err.message || 'Không lưu được câu trả lời.'), 'error');
    } finally {
      setBusyId(null);
    }
  }, [portalOk, running, refresh, toast]);

  const stop = useCallback(async () => {
    try {
      await postJson('/api/stop');
      toast?.('Đã yêu cầu dừng sau hồ sơ đang nhập.', 'ok');
    } catch (err) {
      toast?.(String(err.message || 'Không dừng được.'), 'error');
    }
  }, [toast]);

  const discharge = useMemo(() => listByDoc(records, DOC_GRV), [records]);
  const clinic = useMemo(() => listByDoc(records, DOC_PHIEU), [records]);
  const summaryLines = runSummaryLines(auto);
  const loggedIn = portalOk && emrOk;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card title="Đăng nhập cổng BHXH" aside={(
        <>
          <Badge text={portalOk ? 'Cổng BHXH: đã đăng nhập' : 'Cổng BHXH: chưa đăng nhập'} bg={portalOk ? C.greenBg : C.surface2} color={portalOk ? C.green : C.text2} />
          <Badge text={emrOk ? 'EMR: đã đăng nhập' : 'EMR: chưa đăng nhập'} bg={emrOk ? C.greenBg : C.surface2} color={emrOk ? C.green : C.text2} />
        </>
      )}>
        {account && (!account.ready || editAccount) ? (
          <>
            <div style={{ fontSize: FS.sm, color: C.text2 }}>
              Lưu tài khoản cổng BHXH một lần. Từ đó mỗi lần nhập chỉ cần gõ mã CAPTCHA.
            </div>
            <AccountForm account={account} doctors={doctorAccounts} toast={toast}
              onSaved={acc => { setAccount(acc); setEditAccount(false); }}
              onCancel={account.ready ? () => setEditAccount(false) : null} />
          </>
        ) : (
          <form onSubmit={login} style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
            <div style={{
              width: 180, height: 56, border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface2,
              display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0,
            }}>
              {captchaImg
                ? <img src={captchaImg} alt="Mã CAPTCHA của cổng BHXH" style={{ maxWidth: '100%', maxHeight: '100%' }} />
                : <span style={{ fontSize: FS.xs, color: C.text2, padding: 6, textAlign: 'center' }}>
                  {portalOk ? 'Đang giữ phiên đăng nhập' : 'Bấm "Lấy mã CAPTCHA"'}
                </span>}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Btn icon={IconRefresh} loading={loadingCaptcha} onClick={() => getCaptcha(Boolean(captchaImg))}>
                {captchaImg ? 'Đổi mã khác' : 'Lấy mã CAPTCHA'}
              </Btn>
            </div>
            <label style={{ ...LABEL, flex: '1 1 160px' }}>Mã CAPTCHA
              <input value={captchaText} onChange={e => setCaptchaText(e.target.value)} disabled={!captchaImg}
                style={INPUT} autoComplete="off" placeholder="Gõ mã nhìn thấy bên trái" />
            </label>
            <Btn type="submit" variant="solidPrimary" icon={IconLogin} loading={loggingIn} disabled={!captchaImg || !captchaText.trim()}>
              Đăng nhập và nhập tự động
            </Btn>
            {account?.ready && (
              <button type="button" onClick={() => setEditAccount(true)} style={{
                border: 'none', background: 'none', color: C.blue, cursor: 'pointer', fontSize: FS.sm, padding: 0, fontFamily: 'inherit',
              }}>Tài khoản cổng BHXH ({account.username})</button>
            )}
          </form>
        )}
      </Card>

      <Card title="Nhập tự động" aside={running
        ? <Badge text={PHASE_TEXT[auto?.phase] || 'Đang nhập'} bg={C.blueBg} color={C.blue} />
        : null}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={LABEL}>Ngày ra viện
            <DateField value={day} max={todayIso()} onChange={v => setDay(v || todayIso())} label="Ngày ra viện" />
          </label>
          <label style={{ ...LABEL, flex: '1 1 260px' }}>Khoa (giấy ra viện)
            <input value={khoa} onChange={e => setKhoa(e.target.value)} onBlur={() => saveDefaults(khoa, doctor)}
              style={INPUT} placeholder="Ngoại Chấn thương chỉnh hình - Thần kinh (K24)" />
          </label>
          <label style={LABEL}>Bác sĩ (giấy ra viện)
            <select value={doctor} onChange={e => { setDoctor(e.target.value); saveDefaults(khoa, e.target.value); }} style={INPUT}>
              {[...new Set([doctor, ...doctors].filter(Boolean))].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <Btn variant="primary" icon={IconPlayerPlay} onClick={startRun} loading={starting}
            disabled={!loggedIn || running} title={loggedIn ? '' : 'Đăng nhập cổng BHXH trước'}>
            Quét và nhập lại
          </Btn>
          {auto?.phase === 'submit' && running && <Btn icon={IconPlayerStop} onClick={stop}>Dừng nhập</Btn>}
        </div>
        <div style={{ fontSize: FS.sm, color: C.text2, lineHeight: 1.5 }}>
          Đăng nhập xong, công cụ tự quét Danh sách Khám bệnh (hôm nay) và người bệnh ra viện ngày đã chọn trên EMR,
          đọc phiếu nghỉ và giấy ra viện, rồi nhập lên cổng BHXH các hồ sơ đủ dữ liệu. Phiên đăng nhập được giữ để
          nhập hết danh sách.
        </div>
        {running && auto?.message && <div style={{ fontSize: FS.sm, color: C.blue }}>{auto.message}</div>}
        {!running && worker?.running === false && auto?.phase === 'error' && (
          <div style={{ fontSize: FS.sm, color: C.red }}>{auto.message}</div>
        )}
        {summaryLines.length > 0 && (
          <div style={{ fontSize: FS.sm, color: C.text2, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ fontWeight: 600, color: C.text }}>Lượt gần nhất{auto?.day ? ` (ngày ${auto.day})` : ''}</div>
            {summaryLines.map(line => <div key={line}>{line}</div>)}
          </div>
        )}
        {available === false && (
          <div style={{ fontSize: FS.sm, color: C.text2 }}>
            Công cụ nhập cổng chưa chạy. Bấm "Lấy mã CAPTCHA" ở trên để khởi động.
          </div>
        )}
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 12 }}>
        <RecordList title="Ra viện (giấy ra viện)" list={discharge} onAnswer={answer} busyId={busyId}
          emptyText="Chưa có ca ra viện nào. Đăng nhập để công cụ tự quét." />
        <RecordList title="Phòng khám (phiếu nghỉ)" list={clinic} onAnswer={answer} busyId={busyId}
          emptyText="Chưa có phiếu nghỉ phòng khám nào. Đăng nhập để công cụ tự quét." />
      </div>
    </div>
  );
}
