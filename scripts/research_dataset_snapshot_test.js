#!/usr/bin/env node
'use strict';

// Kiểm thử snapshot dataset cuối (datasets/<tên>/) trong server/routes/research.js:
//  - ghi vào thư mục tạm, chỉ đổi tên thành snapshot chính thức sau khi đủ file + kiểm SHA-256;
//  - dừng giữa chừng không để lại snapshot "chính thức" dở dang; thư mục tạm được dọn;
//  - kiểm tra valid / missing / modified, không tự sửa snapshot sai checksum;
//  - tạo lại cùng nội dung: dùng lại snapshot còn nguyên, tạo mới bên cạnh snapshot hỏng;
//  - manifest đủ thông tin truy nguồn; không ghi dữ liệu người bệnh ra log.
// Dữ liệu giả, không có người bệnh thật. Chạy: node scripts/research_dataset_snapshot_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_dataset_snapshot_test_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;

const research = require('../server/routes/research');
const R = research._test;

// Ghi lại mọi dòng log trong lúc test để kiểm tra không lộ dữ liệu người bệnh.
const logged = [];
for (const k of ['log', 'warn', 'error', 'info']) {
  const orig = console[k].bind(console);
  console[k] = (...args) => { logged.push(args.map(String).join(' ')); if (k !== 'log' || !String(args[0]).startsWith('  ')) return; orig(...args); };
}
const say = (...a) => process.stdout.write(`${a.join(' ')}\n`);

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    say(`  ok - ${name}`);
  } catch (err) {
    say(`  FAIL - ${name}`);
    say(String(err && err.stack || err));
    process.exitCode = 1;
  }
}

const PATIENT_NAME = 'Nguyen Van Gia Lap';
const FINAL_CSV = `﻿research_code,patient_name,hb\nNC0001,${PATIENT_NAME},120\nNC0002,Tran Thi Gia,98\n`;

let seq = 0;
// Run nằm trong cấu trúc của nghiên cứu riêng: <store>/<study>/runs/<run>, có study.json.
function newStudyRun() {
  seq += 1;
  const studyDir = path.join(RUNTIME_ROOT, 'fixture', `nc_test_${seq}`);
  const runDir = path.join(studyDir, 'runs', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(studyDir, 'study.json'), JSON.stringify({
    id: `nc_test_${seq}`,
    name: 'Đề tài thử',
    governance: { protocol_code: 'DC-01', approval_status: 'approved', inclusion_criteria: 'Gãy cổ xương đùi', exclusion_criteria: 'Dưới 18 tuổi' },
    data_requirements: { parts: ['xn', 'cdha'], items: [{ kind: 'imaging_modality', value: 'CT', label: 'Có CT' }] },
  }));
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
    normalized_input_signature: 'sig_abc', normalized_schema_version: 12, normalized_at: '2026-09-01T00:00:00Z',
    normalized_qa: { status: 'ok', blocking: 0, warnings: 1 },
  }));
  fs.writeFileSync(path.join(runDir, 'analysis_final.csv'), FINAL_CSV);
  return runDir;
}

function snapshot(runDir, faults = null) {
  return R.writeDatasetSnapshot(runDir, { csvPath: path.join(runDir, 'analysis_final.csv'), kind: 'final', faults });
}

function dirs(runDir) {
  const d = path.join(runDir, 'datasets');
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
}

function crashAt(runDir, point) {
  let crashed = false;
  try { snapshot(runDir, { crashAt: point }); } catch (err) {
    if (err.code !== 'SIMULATED_CRASH') throw err;
    crashed = true;
  }
  assert.ok(crashed, `phải dừng tại ${point}`);
}

test('Snapshot hoàn tất: đủ file, SHA256SUMS, manifest truy nguồn được; kiểm tra = valid', () => {
  const runDir = newStudyRun();
  const snap = snapshot(runDir);
  assert.deepStrictEqual(dirs(runDir), [snap.name], 'chỉ có thư mục chính thức, không còn thư mục tạm');
  const dir = path.join(runDir, 'datasets', snap.name);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['SHA256SUMS', 'analysis_final.csv', 'data_dictionary.json', 'dataset_manifest.json']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'analysis_final.csv'), 'utf-8'), FINAL_CSV);
  const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf-8');
  for (const f of ['analysis_final.csv', 'data_dictionary.json', 'dataset_manifest.json']) assert.ok(new RegExp(`^[0-9a-f]{64}  ${f.replace('.', '\\.')}$`, 'm').test(sums), f);
  assert.strictEqual(snap.manifest_version, 2);
  assert.ok(snap.files['analysis_final.csv'].sha256 === snap.sha256 && snap.files['data_dictionary.json'].sha256);
  // Truy nguồn: run, chữ ký dữ liệu chuẩn hóa, schema, từ điển, cấu hình biến, tiêu chí nghiên cứu.
  assert.strictEqual(snap.run_id, 'r1');
  assert.strictEqual(snap.normalized_input_signature, 'sig_abc');
  assert.strictEqual(snap.normalized_schema_version, 12);
  assert.ok(snap.data_dictionary_version && snap.data_dictionary_sha256);
  assert.ok('analysis_config' in snap && snap.variable_selection_hash);
  assert.strictEqual(snap.study.governance.inclusion_criteria, 'Gãy cổ xương đùi');
  assert.deepStrictEqual(snap.study.data_requirements.parts, ['xn', 'cdha']);
  assert.ok(snap.study.requirements.parts.includes('cdha'));
  const v = R.verifyDatasetSnapshot(runDir, snap.name);
  assert.strictEqual(v.status, 'valid');
  assert.strictEqual(v.files.length, 3);
});

for (const point of ['after_csv', 'after_dictionary', 'after_manifest', 'before_rename']) {
  test(`Dừng giữa chừng (${point}): không có snapshot chính thức dở dang; lần sau dọn thư mục tạm và tạo đúng 1 snapshot`, () => {
    const runDir = newStudyRun();
    // Một snapshot cũ đã hoàn tất (nội dung khác) phải được giữ nguyên.
    fs.writeFileSync(path.join(runDir, 'old.csv'), '﻿research_code,hb\nNC0009,111\n');
    const old = R.writeDatasetSnapshot(runDir, { csvPath: path.join(runDir, 'old.csv'), kind: 'superseded_by_normalize' });
    const oldBytes = fs.readFileSync(path.join(runDir, 'datasets', old.name, 'dataset_manifest.json'));

    crashAt(runDir, point);
    const left = dirs(runDir).filter(d => d.startsWith('.tmp_'));
    assert.strictEqual(left.length, 1, 'thư mục tạm còn lại sau sự cố');
    assert.deepStrictEqual(R.listDatasetSnapshots(runDir).map(s => s.name), [old.name], 'thư mục tạm không được coi là snapshot');
    assert.deepStrictEqual(R.verifyAllDatasetSnapshots(runDir).map(r => r.status), ['valid']);

    const snap = snapshot(runDir);
    assert.deepStrictEqual(dirs(runDir), [old.name, snap.name].sort(), 'thư mục tạm đã dọn, không trùng snapshot');
    assert.strictEqual(R.verifyDatasetSnapshot(runDir, snap.name).status, 'valid');
    assert.ok(fs.readFileSync(path.join(runDir, 'datasets', old.name, 'dataset_manifest.json')).equals(oldBytes), 'snapshot cũ không bị đụng');
  });
}

test('Thư mục tạm của tiến trình khác chỉ bị dọn khi đã cũ; snapshot hoàn tất không bao giờ bị dọn', () => {
  const runDir = newStudyRun();
  const done = snapshot(runDir);
  const fresh = path.join(runDir, 'datasets', '.tmp_final_x_1111');
  const stale = path.join(runDir, 'datasets', '.tmp_final_y_2222');
  for (const d of [fresh, stale]) {
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, '.owner.json'), JSON.stringify({ process_instance_id: 'tien-trinh-khac' }));
  }
  const old = (Date.now() - 60 * 60 * 1000) / 1000;
  fs.utimesSync(stale, old, old);
  fs.utimesSync(path.join(runDir, 'datasets', done.name), old, old);
  const removed = R.cleanupStaleDatasetStaging(runDir);
  assert.deepStrictEqual(removed, ['.tmp_final_y_2222']);
  assert.ok(fs.existsSync(fresh), 'thư mục tạm còn mới của tiến trình khác được giữ');
  assert.ok(fs.existsSync(path.join(runDir, 'datasets', done.name)), 'snapshot hoàn tất cũ vẫn giữ');
});

test('File bị sửa → modified; không tự sửa; tạo lại cùng nội dung → snapshot mới bên cạnh', () => {
  const runDir = newStudyRun();
  const snap = snapshot(runDir);
  const csv = path.join(runDir, 'datasets', snap.name, 'analysis_final.csv');
  fs.appendFileSync(csv, 'NC0003,Sua Tay,1\n');
  const tampered = fs.readFileSync(csv);
  const v = R.verifyDatasetSnapshot(runDir, snap.name);
  assert.strictEqual(v.status, 'modified');
  assert.deepStrictEqual(v.files.filter(f => f.status === 'modified').map(f => f.file), ['analysis_final.csv']);
  assert.ok(fs.readFileSync(csv).equals(tampered), 'kiểm tra không được sửa file');

  const again = snapshot(runDir);
  assert.notStrictEqual(again.name, snap.name, 'không dùng lại snapshot sai checksum');
  assert.strictEqual(R.verifyDatasetSnapshot(runDir, again.name).status, 'valid');
  assert.ok(fs.readFileSync(csv).equals(tampered), 'snapshot hỏng giữ nguyên để điều tra');
  assert.strictEqual(R.verifyDatasetSnapshot(runDir, snap.name).status, 'modified');
});

test('Manifest bị sửa → modified (checksum manifest nằm trong SHA256SUMS)', () => {
  const runDir = newStudyRun();
  const snap = snapshot(runDir);
  const mf = path.join(runDir, 'datasets', snap.name, 'dataset_manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf-8'));
  m.rows = 999;
  fs.writeFileSync(mf, JSON.stringify(m));
  const v = R.verifyDatasetSnapshot(runDir, snap.name);
  assert.strictEqual(v.status, 'modified');
  assert.ok(v.files.some(f => f.file === 'dataset_manifest.json' && f.status === 'modified'));
});

test('File bị thiếu → missing; cả snapshot bị xóa → missing', () => {
  const runDir = newStudyRun();
  const snap = snapshot(runDir);
  fs.rmSync(path.join(runDir, 'datasets', snap.name, 'data_dictionary.json'));
  const v = R.verifyDatasetSnapshot(runDir, snap.name);
  assert.strictEqual(v.status, 'missing');
  assert.deepStrictEqual(v.files.filter(f => f.status === 'missing').map(f => f.file), ['data_dictionary.json']);
  fs.rmSync(path.join(runDir, 'datasets', snap.name, 'SHA256SUMS'));
  assert.strictEqual(R.verifyDatasetSnapshot(runDir, snap.name).status, 'missing', 'thiếu SHA256SUMS ở snapshot bản mới');
  assert.strictEqual(R.verifyDatasetSnapshot(runDir, 'khong_ton_tai').status, 'missing');
  // Tạo lại cùng nội dung: không dùng lại snapshot thiếu file.
  const again = snapshot(runDir);
  assert.notStrictEqual(again.name, snap.name);
  assert.strictEqual(R.verifyDatasetSnapshot(runDir, again.name).status, 'valid');
});

test('Tạo lại snapshot cùng nội dung khi bản cũ còn nguyên → dùng lại, không tạo thêm', () => {
  const runDir = newStudyRun();
  const a = snapshot(runDir);
  const b = snapshot(runDir);
  assert.strictEqual(b.name, a.name);
  assert.deepStrictEqual(dirs(runDir), [a.name]);
  fs.writeFileSync(path.join(runDir, 'analysis_final.csv'), `${FINAL_CSV}NC0004,Khac,77\n`);
  const c = snapshot(runDir);
  assert.notStrictEqual(c.name, a.name, 'nội dung khác → snapshot mới');
  assert.strictEqual(R.listDatasetSnapshots(runDir).length, 2);
});

test('Snapshot bản cũ (chưa có SHA256SUMS) vẫn kiểm được CSV theo sha256 trong manifest', () => {
  const runDir = newStudyRun();
  const dir = path.join(runDir, 'datasets', 'final_20260101_000000_abcd1234');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'analysis_final.csv'), FINAL_CSV);
  const crypto = require('crypto');
  const sha = crypto.createHash('sha256').update(FINAL_CSV).digest('hex');
  fs.writeFileSync(path.join(dir, 'dataset_manifest.json'), JSON.stringify({ name: path.basename(dir), kind: 'final', created_at: '2026-01-01', sha256: sha, file: 'analysis_final.csv' }));
  const v = R.verifyDatasetSnapshot(runDir, path.basename(dir));
  assert.deepStrictEqual([v.status, v.legacy], ['valid', true]);
  // Tạo lại cùng nội dung: snapshot cũ còn nguyên → dùng lại (giữ hành vi cũ).
  assert.strictEqual(snapshot(runDir).name, path.basename(dir));
  fs.appendFileSync(path.join(dir, 'analysis_final.csv'), 'x\n');
  assert.strictEqual(R.verifyDatasetSnapshot(runDir, path.basename(dir)).status, 'modified');
});

test('Chuẩn hóa lại vẫn lưu bản superseded (hành vi cũ) và bản đó kiểm tra valid', () => {
  const runDir = path.join(RUNTIME_ROOT, 'fixture', 'archive_like', 'runs', 'r9');
  fs.mkdirSync(runDir, { recursive: true });
  const cols = ['T/G vào', 'Mã BN', 'Mã nội trú', 'Họ tên', 'Tuổi', 'GT', 'Trạng thái', 'Khoa chuyển đến', 'Xử trí'];
  fs.writeFileSync(path.join(runDir, 'du_lieu_ban_dau.csv'), `﻿${cols.join(',')}\n02/03/2026 08:00,BNX,NTX,${PATIENT_NAME},60,Nam,Hoàn tất,,Ra viện\n`);
  R.normalizeRunOutputs(runDir, { sourceRunId: 'r9' });
  fs.writeFileSync(path.join(runDir, 'analysis_final.csv'), FINAL_CSV);
  R.normalizeRunOutputs(runDir, { sourceRunId: 'r9', force: true });
  const snaps = R.listDatasetSnapshots(runDir);
  assert.strictEqual(snaps.length, 1);
  assert.strictEqual(snaps[0].kind, 'superseded_by_normalize');
  assert.ok(snaps[0].normalized_input_signature);
  assert.strictEqual(snaps[0].study, null, 'kho gốc không có nghiên cứu');
  assert.strictEqual(R.verifyDatasetSnapshot(runDir, snaps[0].name).status, 'valid');
});

test('Không ghi dữ liệu người bệnh ra log; kết quả kiểm tra chỉ có tên file và checksum', () => {
  const leaked = logged.filter(l => l.includes(PATIENT_NAME) || l.includes('Tran Thi Gia'));
  assert.deepStrictEqual(leaked, []);
  const runDir = newStudyRun();
  const snap = snapshot(runDir);
  const out = JSON.stringify(R.verifyAllDatasetSnapshots(runDir));
  assert.ok(!out.includes(PATIENT_NAME) && out.includes(snap.name));
});

say(`\n${passed} kịch bản pass.`);
