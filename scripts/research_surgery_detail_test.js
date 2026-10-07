'use strict';

const assert = require('assert');
const { hchanhFetchOutputToRows } = require('../server/research/research_source');
const { repairSurgeryRow } = require('../server/research/surgery_raw_repair');
const { NORMALIZED_COLUMNS, NORMALIZED_SCHEMA_VERSION } = require('../server/research/normalized_schema');

const output = {
  surgery: {
    _fetch_status: 'ok',
    surgeries: [{
      ho_ten: 'NGƯỜI BỆNH THỬ',
      thoi_gian: '21/04/2026 07:30',
      phong_mo: 'Phòng 1',
      trang_thai: 'Hoàn tất',
      detail: {
        bat_dau: '21/04/2026 08:15',
        ket_thuc: '09:45',
        dich_vu_phau_thuat: 'Kết hợp xương',
        doi_tuong_dv: 'BHYT',
        phuong_phap_pt: 'Kết hợp xương bằng nẹp vít',
        pp_vo_cam: 'Tê tủy sống',
        phan_loai_pt: 'Loại 1',
        icd9: '79.36',
        chan_doan_truoc_pt: 'Gãy xương cẳng chân',
        icd10_truoc_pt: 'S82.2',
        chan_doan_sau_pt: 'Gãy xương cẳng chân đã kết hợp xương',
        icd10_sau_pt: 'S82.2',
        mo_ta_pppt: 'Bộc lộ ổ gãy và đặt nẹp vít',
        trinh_tu_phau_thuat: 'Rạch da · bộc lộ · đặt nẹp vít · đóng vết mổ',
        bs_mo_chinh: 'BS A',
        gay_me_chinh: 'BS B',
        ptv_phu_1: 'BS C',
        ptv_phu_2: 'BS D',
        dd_dung_cu: 'ĐD E',
        ktv_phu_me: 'KTV F',
        dien_bien_benh: 'Ổn định',
        dan_do_sau_pt: 'Theo dõi sau mổ',
        benh_kem_theo_sau_pt: ['Tăng huyết áp', 'Đái tháo đường'],
        hoan_tat_text: 'BS A hoàn tất',
      },
    }],
  },
};

const source = {
  'Mã NC': 'NC0001',
  'Mã BN': 'BN0001',
  'Họ tên': 'NGƯỜI BỆNH THỬ',
  'Ngày vào viện': '20/04/2026',
  'Ngày ra viện': '25/04/2026',
};

const rows = hchanhFetchOutputToRows(output, source, 'run_test').surgeryRows;
assert.strictEqual(rows.length, 1);
const row = rows[0];

assert.strictEqual(row['Kết thúc phẫu thuật'], '09:45');
assert.strictEqual(row['Đối tượng DV'], 'BHYT');
assert.strictEqual(row.ICD9, '79.36');
assert.strictEqual(row['Chẩn đoán trước mổ'], 'Gãy xương cẳng chân');
assert.strictEqual(row['ICD10 trước mổ'], 'S82.2');
assert.strictEqual(row['Chẩn đoán sau mổ'], 'Gãy xương cẳng chân đã kết hợp xương');
assert.strictEqual(row['ICD10 sau mổ'], 'S82.2');
assert.ok(row['Trình tự phẫu thuật'].includes('đặt nẹp vít'));
assert.strictEqual(row['Phẫu thuật viên chính'], 'BS A');
assert.strictEqual(row['Bác sĩ gây mê chính'], 'BS B');
assert.strictEqual(row['Phụ mổ 1'], 'BS C');
assert.strictEqual(row['Phụ mổ 2'], 'BS D');
assert.strictEqual(row['Điều dưỡng dụng cụ'], 'ĐD E');
assert.strictEqual(row['KTV phụ mê'], 'KTV F');
assert.strictEqual(row['Diễn biến bệnh'], 'Ổn định');
assert.strictEqual(row['Dặn dò sau PT'], 'Theo dõi sau mổ');
assert.strictEqual(row['Bệnh kèm sau PT'], 'Tăng huyết áp · Đái tháo đường');
assert.strictEqual(row['Người hoàn tất'], 'BS A hoàn tất');

const repaired = repairSurgeryRow({
  'Mã BN': 'BN0001',
  'Raw JSON': JSON.stringify(output.surgery.surgeries[0]),
});
assert.strictEqual(repaired['Chẩn đoán trước mổ'], 'Gãy xương cẳng chân');
assert.strictEqual(repaired['Trình tự phẫu thuật'], 'Rạch da · bộc lộ · đặt nẹp vít · đóng vết mổ');
assert.strictEqual(repaired['Phẫu thuật viên chính'], 'BS A');
assert.strictEqual(repaired['Bệnh kèm sau PT'], 'Tăng huyết áp · Đái tháo đường');

assert.ok(NORMALIZED_SCHEMA_VERSION >= 33, `schema version phải ≥ 33, đang là ${NORMALIZED_SCHEMA_VERSION}`);
for (const key of [
  'surgery_end_datetime', 'icd9_code', 'preop_icd10', 'postop_icd10',
  'procedure_description', 'surgery_sequence', 'primary_surgeon',
  'primary_anesthesiologist', 'assistant_surgeon_1', 'assistant_surgeon_2',
  'scrub_nurse', 'anesthesia_technician', 'disease_course',
  'postop_instructions', 'postop_comorbidities', 'completed_by',
]) {
  assert.ok(NORMALIZED_COLUMNS.surgery_results.includes(key), `Thiếu cột surgery_results: ${key}`);
}

console.log('research_surgery_detail_test: ok');
