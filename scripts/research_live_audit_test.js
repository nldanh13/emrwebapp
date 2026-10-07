'use strict';

// Đối chiếu tự động với EMR: so sánh thuần + chạy trọn một lượt với EMR giả (không mở Chrome).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'live_audit_'));
process.env.EMR_RUNTIME_ROOT = ROOT;
process.env.EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT = '1';
const { RESEARCH_STORE_DIR } = require('../server/constants');
const { writeCsv, readCsvTable } = require('../server/research/table_io');
const R = require('../server/routes/research')._test;
const { compareCase, compareRows } = require('../server/research/live_audit_compare');
const live = require('../server/research/live_audit');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const put = (dir, file, rows) => writeCsv(path.join(dir, file), [...new Set(rows.flatMap(Object.keys))], rows);

test('so sánh: khớp, lệch giá trị, kho thiếu, kho thừa; dòng logic trùng chỉ tính một lần', () => {
  const lab = (t, name, v) => ({ lab_datetime: t, test_name_raw: name, result_raw: v, unit: 'G/L' });
  const r = compareRows('labs',
    [lab('2026-03-02 06:30', 'WBC', '9'), lab('2026-03-02 06:30', 'WBC', '9'), lab('2026-03-02 06:30', 'HGB', '120'), lab('2026-03-03 06:30', 'PLT', '200')],
    [lab('02/03/2026 06:30', 'wbc', '9'), lab('2026-03-02 06:30', 'WBC', '9'), lab('2026-03-02 06:30', 'HGB', '118'), lab('2026-03-04 06:30', 'CRP', '5')]);
  assert.deepStrictEqual([r.matched, r.mismatched, r.archive_only, r.emr_only], [1, 1, 1, 1]);
  assert.strictEqual(r.archive_count, 3);
  assert.strictEqual(r.emr_count, 4);
  assert.strictEqual(r.archive_raw_count, 4);
  assert.strictEqual(r.emr_raw_count, 4);
  assert.deepStrictEqual(r.examples.mismatched[0], { label: '2026-03-02 06:30 · HGB', archive: '120 g/l', emr: '118 g/l' });
});

test('so thuốc: thiếu route ở một phía không phải lệch; hai route thật khác nhau mới lệch', () => {
  const base = { order_datetime: '2026-05-16 05:00', drug_name_raw: 'AT Paracetamol', dose_raw: '1 g' };
  let r = compareRows('medications',
    [{ ...base, route_norm: 'truyền_tĩnh_mạch' }],
    [{ ...base, route_norm: '' }]);
  assert.deepStrictEqual([r.matched, r.mismatched, r.archive_only, r.emr_only], [1, 0, 0, 0]);

  r = compareRows('medications',
    [{ ...base, route_norm: 'truyền_tĩnh_mạch' }],
    [{ ...base, route_norm: 'uống' }]);
  assert.deepStrictEqual([r.matched, r.mismatched, r.archive_only, r.emr_only], [0, 1, 0, 0]);
});

test('so phẫu thuật: bỏ mã PT đầu tên và không coi thiếu giờ một phía là lệch', () => {
  const archive = [{
    surgery_date: '2026-05-15',
    surgery_datetime: '',
    surgery_name: '(PT.208)Phẫu thuật nội soi khâu sụn chêm',
    surgery_method: 'Phẫu thuật nội soi khâu sụn chêm',
  }];
  const emr = [{
    surgery_date: '2026-05-15',
    surgery_datetime: '2026-05-15 08:55',
    surgery_name: 'Phẫu thuật nội soi khâu sụn chêm',
    surgery_method: 'Phẫu thuật nội soi khâu sụn chêm',
  }];
  const r = compareRows('surgeries', archive, emr);
  assert.deepStrictEqual([r.matched, r.mismatched, r.archive_only, r.emr_only], [1, 0, 0, 0]);
});

test('so sánh mốc đợt: ngày ra khác thì lệch, đủ cả hai bên mới tính khớp', () => {
  const res = compareCase(
    { encounter: { admission_date: '2026-03-01 08:00', discharge_date: '2026-09-23', treatment_duration: '6' } },
    { encounter: { admission_date: '01/03/2026 08:00', discharge_date: '2026-08-22 13:00', treatment_duration: '6' } });
  const enc = res.kinds.find(k => k.kind === 'encounter');
  assert.deepStrictEqual([enc.matched, enc.mismatched], [2, 1]);
  assert.strictEqual(res.all_match, false);
});

function buildArchive() {
  const dir = path.join(RESEARCH_STORE_DIR, 'du_lieu_goc', 'runs', 'r1');
  fs.mkdirSync(dir, { recursive: true });
  put(dir, 'du_lieu_ban_dau.csv', [
    { 'T/G vào': '08:00 01/03/2026', 'Mã BN': '777', 'Họ tên': 'A', 'Ngày ra viện': '05/03/2026' },
    { 'T/G vào': '08:00 01/04/2026', 'Mã BN': '888', 'Họ tên': 'B', 'Ngày ra viện': '05/04/2026' },
  ]);
  put(dir, 'lich_su_xn.csv', [
    { 'Mã BN': '777', 'TG chỉ định': '06:30 02/03/2026', 'Chỉ số': 'WBC', 'Kết quả': '9', 'Đơn vị': 'G/L' },
    { 'Mã BN': '777', 'TG chỉ định': '06:30 03/03/2026', 'Chỉ số': 'HGB', 'Kết quả': '120', 'Đơn vị': 'g/L' },
    { 'Mã BN': '888', 'TG chỉ định': '06:30 02/04/2026', 'Chỉ số': 'WBC', 'Kết quả': '7', 'Đơn vị': 'G/L' },
  ]);
  R.normalizeRunOutputs(dir, { sourceRunId: 'r1', force: true });
  return dir;
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = `${st.size}:${st.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

test('chạy trọn một lượt với EMR giả: lấy vào thư mục riêng, không đụng kho gốc, đếm đúng khác biệt', async () => {
  const archiveDir = buildArchive();
  const enc = readCsvTable(path.join(archiveDir, 'encounters.csv')).rows.find(e => e.patient_code === '777');
  const before = snapshot(archiveDir);
  const audit = live.startLiveAudit(archiveDir, { runId: 'r1', encounterId: enc.encounter_id });
  assert.strictEqual(audit.status, 'queued');
  assert.strictEqual(audit.patient_code, '777');

  const calls = {};
  const runners = {
    hchanh: async (_ctx, opts) => {
      calls.hchanh = opts;
      fs.writeFileSync(path.join(opts.runDir, 'hchanh_auto_progress.json'), JSON.stringify({ k: { status: 'done' } }));
      return { ok: 1 };
    },
    xnCdha: async (_ctx, opts) => {
      calls.xn = opts;
      // EMR hôm nay: HGB đã sửa thành 118, thêm CRP; WBC giữ nguyên.
      put(opts.runDir, 'lich_su_xn.csv', [
        { 'Mã BN': '777', 'TG chỉ định': '06:30 02/03/2026', 'Chỉ số': 'WBC', 'Kết quả': '9', 'Đơn vị': 'G/L' },
        { 'Mã BN': '777', 'TG chỉ định': '06:30 03/03/2026', 'Chỉ số': 'HGB', 'Kết quả': '118', 'Đơn vị': 'g/L' },
        { 'Mã BN': '777', 'TG chỉ định': '06:30 04/03/2026', 'Chỉ số': 'CRP', 'Kết quả': '5', 'Đơn vị': 'mg/L' },
      ]);
      return { ok: true };
    },
    normalize: async (dir, opts) => { calls.normalize = opts; return R.normalizeRunOutputs(dir, opts); },
  };
  const done = await live.runLiveAudit({ sid: 'test' }, { runDir: archiveDir, id: audit.id, storeRoot: RESEARCH_STORE_DIR, runners });

  // Lấy lại đúng người bệnh, vào thư mục riêng, bắt buộc mở EMR, không ghi kho dùng chung / không lấy bù.
  const auditDir = live.liveRunDir(RESEARCH_STORE_DIR, audit.id);
  assert.strictEqual(calls.hchanh.runDir, auditDir);
  assert.strictEqual(calls.hchanh.force, true);
  assert.strictEqual(calls.hchanh.recordStore, false);
  assert.deepStrictEqual([...new Set(calls.hchanh.sourceRows.map(r => r['Mã BN']))], ['777']);
  assert.strictEqual(calls.xn.runDir, auditDir);
  assert.strictEqual(calls.xn.scope, live.LIVE_PROJECT);
  assert.strictEqual(calls.xn.isArchive, false);
  assert.strictEqual(calls.normalize.skipPatientDbOverlay, true);

  // Kho gốc: chỉ thêm file kết quả đối chiếu, mọi file khác giữ nguyên.
  const after = snapshot(archiveDir);
  for (const [file, sig] of Object.entries(before)) assert.strictEqual(after[file], sig, `kho gốc bị đổi: ${file}`);
  assert.deepStrictEqual(Object.keys(after).filter(f => !(f in before)), [live.STORE_FILE]);

  assert.strictEqual(done.status, 'done', done.message);
  const labs = done.result.kinds.find(k => k.kind === 'labs');
  assert.deepStrictEqual([labs.matched, labs.mismatched, labs.archive_only, labs.emr_only], [1, 1, 0, 1]);
  const summary = live.summarizeLive(archiveDir);
  assert.strictEqual(summary.case_count, 1);
  assert.strictEqual(summary.running, null);
  assert.strictEqual(summary.kinds.find(k => k.kind === 'labs').compared, 3);
});

test('kết quả đối chiếu logic cũ không được cộng vào tỉ lệ sau khi parser thay đổi', () => {
  const dir = path.join(RESEARCH_STORE_DIR, 'du_lieu_goc', 'runs', 'r1');
  const storePath = path.join(dir, live.STORE_FILE);
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const done = Object.values(store.audits).find(a => a.status === 'done' && a.result);
  assert.ok(done);
  const originalVersion = done.audit_version;
  done.audit_version = 0;
  fs.writeFileSync(storePath, JSON.stringify(store), 'utf8');
  const stale = live.summarizeLive(dir);
  assert.strictEqual(stale.case_count, 0);
  assert.ok(stale.recent.some(a => a.id === done.id && a.outdated === true));
  done.audit_version = originalVersion;
  fs.writeFileSync(storePath, JSON.stringify(store), 'utf8');
});

test('lấy lại từ EMR lỗi: không so (tránh "kho thừa" giả), không tính vào tỉ lệ', async () => {
  const archiveDir = path.join(RESEARCH_STORE_DIR, 'du_lieu_goc', 'runs', 'r1');
  const enc = readCsvTable(path.join(archiveDir, 'encounters.csv')).rows.find(e => e.patient_code === '888');
  const audit = live.startLiveAudit(archiveDir, { runId: 'r1', encounterId: enc.encounter_id });
  const runners = {
    hchanh: async () => ({ ok: 1 }),
    xnCdha: async () => ({ error: 'Lấy XN/CĐHA lỗi: TimeoutException' }),
    normalize: async () => { throw new Error('không được chuẩn hóa khi lấy lỗi'); },
  };
  const res = await live.runLiveAudit({ sid: 'test' }, { runDir: archiveDir, id: audit.id, storeRoot: RESEARCH_STORE_DIR, runners });
  assert.strictEqual(res.status, 'fetch_error');
  assert.match(res.message, /XN\/CĐHA/);
  assert.strictEqual(live.summarizeLive(archiveDir).case_count, 1);
});

test('chọn ca: chỉ đợt đã lấy đủ (ready_for_analysis = 1), ưu tiên đợt chưa đối chiếu', () => {
  const dir = path.join(RESEARCH_STORE_DIR, 'du_lieu_goc', 'runs', 'r1');
  const encs = readCsvTable(path.join(dir, 'encounters.csv')).rows;
  const statusPath = path.join(dir, 'extract_status.csv');
  const original = fs.readFileSync(statusPath);
  try {
    put(dir, 'extract_status.csv', encs.map(e => ({ encounter_id: e.encounter_id, ready_for_analysis: e.patient_code === '888' ? '1' : '0' })));
    assert.strictEqual(live.pickCandidate(dir, { random: () => 0 }).patient_code, '888');
    put(dir, 'extract_status.csv', encs.map(e => ({ encounter_id: e.encounter_id, ready_for_analysis: '0' })));
    assert.throws(() => live.pickCandidate(dir), /chưa có đợt nào đã lấy đủ/);
  } finally {
    fs.writeFileSync(statusPath, original);
  }
});

test('máy chủ khởi động lại giữa lúc đối chiếu: lượt dở ghi rõ để chạy lại', () => {
  const dir = path.join(RESEARCH_STORE_DIR, 'du_lieu_goc', 'runs', 'r1');
  const enc = readCsvTable(path.join(dir, 'encounters.csv')).rows[0];
  const a = live.startLiveAudit(dir, { encounterId: enc.encounter_id });
  assert.strictEqual(live.markInterruptedLiveAudits(dir, new Set([a.id])), 0);
  assert.strictEqual(live.markInterruptedLiveAudits(dir, new Set()), 1);
  assert.strictEqual(live.getLiveAudit(dir, a.id).status, 'cancelled');
});

test('API: /audit/live không bị nhầm thành mã lượt kiểm tay; cần quyền xem định danh; kho bận thì từ chối', async () => {
  const express = require('express');
  const { RESEARCH_SCOPE_LOCKS } = require('../server/research/research_http');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.auth = { id: 'u1', name: 'Kiểm tra', role: 'supervisor' }; next(); });
  app.use('/api', require('../server/routes/research'));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/research/archive/audit/live`;
  try {
    let r = await fetch(`${base}?identified=1`);
    let j = await r.json();
    assert.strictEqual(r.status, 200, JSON.stringify(j));
    assert.ok(Array.isArray(j.kinds) && j.kinds.length === 5, JSON.stringify(j));

    r = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(r.status, 403);

    RESEARCH_SCOPE_LOCKS.set('archive', { label: 'Thu thập tự động', since: '2026-10-07T08:00:00Z' });
    r = await fetch(`${base}?identified=1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    j = await r.json();
    assert.strictEqual(r.status, 409);
    assert.match(j.message, /Thu thập tự động/);
    RESEARCH_SCOPE_LOCKS.delete('archive');
  } finally {
    server.close();
  }
});

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  ok - ${t.name}`);
    } catch (err) {
      console.error(`  FAIL - ${t.name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${passed} test(s) passed.`);
})();
