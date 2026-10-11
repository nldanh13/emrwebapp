// src/components/clinic/ClinicPanels.jsx — 3 khung của màn Phòng khám:
//   VisitPanel     lượt khám (chờ khám / đang thực hiện / hoàn tất) và người chờ hoàn tất khám theo đơn thuốc
//   TodoPanel      việc cần làm theo chỉ định: thủ thuật, phẫu thuật, SBBHC
//   SickLeavePanel người bệnh xin nghỉ ốm, cuối buổi chuyển sang tab Nghỉ ốm để nhập lên cổng BHXH
import { useMemo, useState } from 'react';
import { IconChecks, IconFileExport, IconPlus, IconX } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { Btn } from '../shared.jsx';
import * as api from '../../api.js';
import {
  completionGroups, drugLabel, sickLeaveKey, sickLeavePayload, sickLeaveSuggestions, stageCounts, todoCounts, todoItems,
} from './clinicBoard.js';

const TONE_COLOR = { ok: C.green, warn: C.amber, error: C.red, muted: C.text2 };

export function Panel({ title, aside, children }) {
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

function Stat({ label, value, tone }) {
  const color = tone === 'green' ? C.green : tone === 'amber' ? C.amber : tone === 'blue' ? C.blue : C.text;
  return (
    <div style={{ flex: '1 1 90px', padding: '8px 10px', border: `1px solid ${C.border2}`, borderRadius: 7, background: C.surface2 }}>
      <div style={{ fontSize: FS.xs, color: C.text2 }}>{label}</div>
      <div style={{ fontSize: FS.stat, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

function PatientLine({ row, right, sub }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0', borderTop: `1px solid ${C.border2}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: FS.md, color: C.text }}>{row.ho_ten}</div>
        <div style={{ fontSize: FS.xs, color: C.text2, fontVariantNumeric: 'tabular-nums' }}>
          {row.ma_bn}{row.nam_sinh ? ` · ${row.nam_sinh}` : ''}{row.xu_tri ? ` · ${row.xu_tri}` : ''}
        </div>
        {sub}
      </div>
      {right && <div style={{ flexShrink: 0, textAlign: 'right', maxWidth: '55%' }}>{right}</div>}
    </div>
  );
}

function Empty({ children }) {
  return <div style={{ fontSize: FS.sm, color: C.text2, padding: '8px 0' }}>{children}</div>;
}

export function VisitPanel({ rows, running, busy, actionRunning, onComplete, renderCompletion, dayText = 'hôm nay' }) {
  const counts = useMemo(() => stageCounts(rows), [rows]);
  const groups = useMemo(() => completionGroups(rows), [rows]);
  const waitingList = [...groups.noDrug, ...groups.pending];
  return (
    <Panel title={`Lượt khám ${dayText}`}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Stat label="Chờ khám" value={counts.cho_kham} tone="amber" />
        <Stat label="Đang thực hiện" value={counts.dang} tone="blue" />
        <Stat label="Hoàn tất khám" value={counts.xong} tone="green" />
      </div>
      <div style={{ fontSize: FS.xs, color: C.text2 }}>Đếm theo lượt khám, cộng lại = {counts.total} lượt.</div>

      <div>
        <div style={{ fontSize: FS.sm, fontWeight: 600, color: C.text, marginBottom: 4 }}>
          Đã có thuốc, hoàn tất được ({groups.ready.length})
        </div>
        {groups.ready.length ? groups.ready.map(r => (
          <PatientLine key={r.khambenhid} row={r} right={<span style={{ color: C.green, fontWeight: 600, fontSize: FS.sm }}>{drugLabel(r) || 'Sẵn sàng'}</span>} />
        )) : <Empty>Chưa có người bệnh nào đủ điều kiện hoàn tất.</Empty>}
        <div style={{ marginTop: 8 }}>
          <Btn variant="primary" icon={IconChecks} loading={busy === 'complete' || actionRunning}
            disabled={!running || !groups.ready.length || busy === 'complete' || actionRunning} onClick={() => onComplete(groups.ready.length)}>
            {actionRunning ? 'Đang thao tác trên EMR…' : `Hoàn tất khám ${groups.ready.length} người bệnh`}
          </Btn>
        </div>
      </div>

      {waitingList.length > 0 && (
        <div>
          <div style={{ fontSize: FS.sm, fontWeight: 600, color: C.text, marginBottom: 4 }}>Chưa hoàn tất được ({waitingList.length})</div>
          {waitingList.map(r => <PatientLine key={r.khambenhid} row={r} right={renderCompletion(r)} />)}
        </div>
      )}
      <div style={{ fontSize: FS.xs, color: C.text2 }}>
        Người bệnh BHYT xử trí Cho về hoặc Chuyển viện, dịch vụ đã xong. Cho về phải có thuốc trong đơn; hệ thống kiểm tra lại
        từng người ngay trước khi bấm Hoàn tất và dừng ở người nào EMR báo lỗi hoặc hỏi xác nhận.
      </div>
    </Panel>
  );
}

export function TodoPanel({ rows, running, busy, actionRunning, autoTasks, onRunTasks, onToggleAuto, ngoaitruCount, onRunNgoaiTru, children }) {
  const items = useMemo(() => todoItems(rows), [rows]);
  const counts = todoCounts(items);
  const ttRunnable = rows.filter(r => r.procedure_task).length;
  return (
    <Panel title="Việc cần làm" aside={<span style={{ fontSize: FS.xs, color: C.text2 }}>
      TT {counts.tt} · PT {counts.pt} · SBBHC {counts.sbbhc}</span>}>
      {items.length ? (
        <div>
          {items.map(it => (
            <PatientLine key={it.key} row={it.row}
              right={(
                <div style={{ fontSize: FS.sm }}>
                  <div style={{ fontWeight: 600, color: C.text }}>{it.label}</div>
                  <div style={{ color: TONE_COLOR[it.tone] || C.text2 }}>{it.status}</div>
                </div>
              )} />
          ))}
        </div>
      ) : <Empty>Không có thủ thuật, phẫu thuật hay SBBHC nào đang chờ.</Empty>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Btn variant="primary" icon={IconChecks} loading={busy === 'tasks'}
          disabled={!running || !ttRunnable || busy === 'tasks' || actionRunning} onClick={() => onRunTasks(ttRunnable)}>
          {`Hoàn thành thủ thuật ngay (${ttRunnable})`}
        </Btn>
        {ngoaitruCount > 0 && (
          <Btn icon={IconChecks} loading={busy === 'ngoaitru'} disabled={!running || busy === 'ngoaitru' || actionRunning} onClick={onRunNgoaiTru}
            title="Nhập khoa, kết thúc mổ nếu có, tổng kết ra khoa và kết thúc điều trị ngoại trú">
            {`Điều trị ngoại trú, kết thúc mổ (${ngoaitruCount})`}
          </Btn>
        )}
      </div>
      <label style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 6, fontSize: FS.sm, color: C.text }}>
        <input type="checkbox" checked={autoTasks} disabled={busy === 'auto'} onChange={e => onToggleAuto(e.target.checked)} style={{ marginTop: 2 }} />
        <span>
          Tự hoàn thành khi có chỉ định
          <span style={{ display: 'block', fontSize: FS.xs, color: C.text2 }}>
            Mỗi lần đọc danh sách, thủ thuật mới có chỉ định được nhập ngay (giờ chỉ định → +10 phút, thủ thuật viên theo Lịch Phòng khám)
            và SBBHC được soạn nháp sẵn. Lập SBBHC và kết thúc mổ vẫn chờ bấm nút. Người nào EMR báo lỗi thì dừng, không tự thử lại.
            Nhập thủ thuật xong mà người bệnh Cho về / Chuyển viện đã có thuốc thì Vào khám và Hoàn tất luôn; chưa có thuốc thì quay lại, không bấm gì.
            Làm người bệnh BHYT trước, viện phí sau: viện phí chỉ nhập được khi đã đóng tiền (chưa thấy trên D/s Thủ thuật thì 5 phút sau xem lại) và không tự hoàn tất khám.
          </span>
        </span>
      </label>
      {children}
    </Panel>
  );
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function SickLeavePanel({ rows, entries, onEntries, onOpenSickLeave, toast, day = '', dayText = 'hôm nay' }) {
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState('');
  const today = day || todayIso();
  const todayEntries = useMemo(() => (entries || []).filter(e => e.ngay === today)
    .sort((a, b) => String(a.thoi_gian).localeCompare(String(b.thoi_gian))), [entries, today]);
  const markedKeys = useMemo(() => new Set((entries || []).map(e => e.key)), [entries]);
  const suggestions = useMemo(() => sickLeaveSuggestions(rows, markedKeys), [rows, markedKeys]);

  const change = async (action, patient) => {
    setBusy(`${action}:${patient.ma_bn}`);
    try {
      const r = action === 'add' ? await api.addClinicSickLeave(patient) : await api.removeClinicSickLeave(patient);
      if (r.status !== 'ok') throw new Error(r.message);
      onEntries(r.entries || []);
      if (action === 'add') setPick('');
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setBusy('');
    }
  };

  const picked = suggestions.find(r => sickLeaveKey(r) === pick);
  return (
    <Panel title="Xin nghỉ ốm" aside={<span style={{ fontSize: FS.xs, color: C.text2 }}>{todayEntries.length} người {dayText}</span>}>
      {todayEntries.length ? todayEntries.map(e => (
        <PatientLine key={e.key} row={e}
          sub={e.chan_doan ? <div style={{ fontSize: FS.xs, color: C.text2 }}>{e.chan_doan}</div> : null}
          right={(
            <Btn icon={IconX} aria-label={`Bỏ ${e.ho_ten} khỏi danh sách nghỉ ốm`} loading={busy === `remove:${e.ma_bn}`}
              onClick={() => change('remove', e)} style={{ minHeight: 28, padding: '2px 8px' }}>Bỏ</Btn>
          )} />
      )) : <Empty>{`Chưa có người bệnh nào xin nghỉ ốm ${dayText}.`}</Empty>}

      <form onSubmit={ev => { ev.preventDefault(); if (picked) change('add', sickLeavePayload(picked)); }}
        style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <select value={pick} onChange={e => setPick(e.target.value)} aria-label="Chọn người bệnh xin nghỉ ốm"
          style={{ flex: '1 1 200px', minWidth: 0, height: 32, padding: '0 8px', border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface, color: C.text, fontSize: FS.md, fontFamily: 'inherit' }}>
          <option value="">{suggestions.length ? `Chọn người bệnh (${suggestions.length} người còn tuổi lao động)` : 'Không còn người bệnh để chọn'}</option>
          {suggestions.map(r => (
            <option key={sickLeaveKey(r)} value={sickLeaveKey(r)}>{r.ho_ten} · {r.ma_bn}{r.nam_sinh ? ` · ${r.nam_sinh}` : ''}</option>
          ))}
        </select>
        <Btn type="submit" icon={IconPlus} disabled={!picked} loading={busy.startsWith('add:')}>Thêm</Btn>
      </form>

      <div>
        <Btn variant="primary" icon={IconFileExport} disabled={!todayEntries.length} onClick={onOpenSickLeave}>
          Nhập lên cổng BHXH
        </Btn>
      </div>
      <div style={{ fontSize: FS.xs, color: C.text2 }}>
        Danh sách khám không cho biết ai xin giấy nghỉ, nên đánh dấu ở đây khi người bệnh xin. Cuối buổi bấm "Nhập lên cổng BHXH":
        danh sách được chuyển sang tab Nghỉ ốm (mục Ngoại trú) để nhập lên cổng và đánh dấu đã nộp.
      </div>
    </Panel>
  );
}
