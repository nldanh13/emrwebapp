'use strict';

const fs = require('fs');
const path = require('path');
const { readJsonSafe } = require('../../utils/file');
const { safeArray } = require('./common');

const DEFAULT_RULES = Object.freeze({
  supplyDictionary: [
    { match: ['truyen dich', 'natri clorid', 'ringer', 'glucose', 'mannitol', 'vancomycin'], supplies: [
      { label: 'Dây truyền dịch', qty: 1, category: 'required', source: 'dictionary:infusion' },
      { label: 'Kim luồn/kim truyền', qty: 1, category: 'required', source: 'dictionary:infusion' },
    ] },
    { match: ['tmc', 'tiem mach cham', 'tiem tinh mach', 'iv'], supplies: [
      { label: 'Bơm tiêm 20ml', qty: 1, category: 'required', source: 'dictionary:iv_push' },
      { label: 'Kim pha/kim tiêm', qty: 1, category: 'required', source: 'dictionary:iv_push' },
    ] },
    { match: ['tiem bap', 'tb'], supplies: [
      { label: 'Bơm tiêm 5ml', qty: 1, category: 'required', source: 'dictionary:im' },
      { label: 'Kim tiêm bắp', qty: 1, category: 'required', source: 'dictionary:im' },
    ] },
    { match: ['thay bang', 'cat chi', 'rua vet thuong'], supplies: [
      { label: 'Gạc vô khuẩn', qty: 1, category: 'required', source: 'dictionary:wound' },
      { label: 'Dung dịch sát khuẩn', qty: 1, category: 'required', source: 'dictionary:wound' },
    ] },
    { match: ['dat sonde tieu', 'thong tieu'], supplies: [
      { label: 'Sonde tiểu', qty: 1, category: 'required', source: 'dictionary:urinary_catheter' },
      { label: 'Túi nước tiểu', qty: 1, category: 'required', source: 'dictionary:urinary_catheter' },
    ] },
  ],
  routineSupplies: [
    { label: 'Găng tay khám', qty: 4, category: 'routine', routine: true, alert: false, source: 'routine:inpatient_day' },
  ],
  surgeryPackages: [
    { id: 'pttt_ket_hop_xuong', name: 'Kết hợp xương / nẹp vít', match: ['ket hop xuong', 'nep vit', 'dinh noi tuy', 'bat vit'], required: [
      { label: 'Bộ dụng cụ kết hợp xương', match: ['bo dung cu ket hop xuong', 'ket hop xuong'] },
      { label: 'Vít/nẹp theo mã PTTT', match: ['vit', 'nep', 'plate', 'screw'] },
      { label: 'Bơm rửa/sát khuẩn vùng mổ', match: ['bom rua', 'sat khuan', 'povidone', 'betadine'] },
    ], severity: 'error' },
    { id: 'pttt_noi_soi', name: 'Phẫu thuật nội soi', match: ['noi soi', 'cat tui mat noi soi', 'cat ruot thua noi soi', 'trocar'], required: [
      { label: 'Trocar/cổng nội soi theo mã PTTT', match: ['trocar', 'cong noi soi'] },
      { label: 'Bag extraction/túi lấy bệnh phẩm nếu có chỉ định', match: ['bag', 'tui lay benh pham', 'extraction'] },
      { label: 'Clip/dao đốt hoặc dụng cụ cầm máu theo ca', match: ['clip', 'dao dot', 'harmonic', 'ligasure', 'cam mau'] },
    ], severity: 'error' },
    { id: 'pttt_cot_song', name: 'Cột sống / giải ép / cố định', match: ['cot song', 'giai ep', 'co dinh cot song', 'thoat vi dia dem'], required: [
      { label: 'Bộ dụng cụ cột sống', match: ['bo dung cu cot song', 'cot song'] },
      { label: 'Vít/nẹp/rod theo mã PTTT nếu có cố định', match: ['vit', 'nep', 'rod', 'screw'] },
      { label: 'Vật tư dẫn lưu/khâu vết mổ', match: ['dan luu', 'chi khau', 'khau vet mo'] },
    ], severity: 'error' },
    { id: 'pttt_khop', name: 'Nội soi/thay khớp', match: ['noi soi khop', 'tai tao day chang', 'thay khop'], required: [
      { label: 'Bộ nội soi/thay khớp', match: ['noi soi khop', 'thay khop'] },
      { label: 'Lưỡi shaver/đầu đốt nếu có dùng', match: ['shaver', 'dau dot', 'dot'] },
      { label: 'VTYT đặc thù theo mã PTTT', match: ['vt yt dac thu', 'vat tu dac thu', 'dung cu dac thu'] },
    ], severity: 'warn' },
    { id: 'pttt_thao_dc', name: 'Tháo/lấy dụng cụ kết hợp xương', match: ['thao dung cu', 'lay dung cu'], required: [
      { label: 'Bộ tháo dụng cụ', match: ['bo thao dung cu', 'thao dung cu'] },
      { label: 'VTYT đặc thù tháo dụng cụ', match: ['vat tu dac thu', 'thao dung cu'] },
    ], severity: 'warn' },
  ],
  medicationRules: [
    { id: 'injectable_schedule', title: 'Thuốc tiêm/truyền phải có giờ dùng rõ', match: ['tmc', 'tiem', 'truyen', 'iv'], requireSchedule: true, severity: 'warn' },
    { id: 'cefazolin_postop_clean', title: 'Cefazolin sau mổ sạch vượt quy tắc khoa', match: ['cefazolin'], contextTags: ['POST_OP'], maxTimesPerDay: 1, requiresStopPlan: true, severity: 'error', action: 'Xác nhận lại phác đồ sau mổ sạch; nếu tiếp tục dùng phải có chỉ định/hồ sơ rõ.' },
    { id: 'metronidazole_exit_schedule', title: 'Metronidazole trước đóng hồ sơ cần đủ giờ dùng/hoàn trả', match: ['metronidazol', 'metronidazole'], contextTags: ['DISCHARGE', 'TRANSFER_WARD', 'TRANSFER_HOSPITAL'], requireSchedule: true, severity: 'warn' },
  ],
  duplicateIngredientGroups: [
    { id: 'duplicate_nsaid', group: 'NSAID', match: ['diclofenac', 'ketorolac', 'meloxicam', 'celecoxib', 'etoricoxib', 'ibuprofen'], maxActive: 1, severity: 'warn' },
    { id: 'duplicate_paracetamol', group: 'Paracetamol', match: ['paracetamol', 'acetaminophen', 'efferalgan', 'hapacol', 'perfalgan'], maxActive: 1, severity: 'warn' },
  ],
  billingKeywords: {
    bhyt: ['bhyt', 'bao hiem', '80%', '95%', '100%', 'dong chi tra'],
    selfPay: ['tt0', 'tu tuc', 'tu tra', 'ngoai bhyt', 'khong bhyt', 'dich vu'],
  },
  dischargeDocumentRules: {
    requireExitDatetime: true,
    requireDiagnosis: true,
    typoPairs: [
      { bad: 'chuan doan', good: 'chẩn đoán' },
      { bad: 'phau thuat', good: 'phẫu thuật' },
      { bad: 'phau thuat', good: 'phẫu thuật' },
      { bad: 'gay xuong', good: 'gãy xương' },
      { bad: 'tai kham', good: 'tái khám' }
    ],
  },
  sickLeaveRules: { maxExtraDaysAfterExit: 30, requireDateRange: true },
  followUpRules: { requireForEmergencyAdmission: true, requireForReferral: true },
  printDocuments: ['BANG_KE_CHI_PHI', 'PHIEU_CONG_KHAI'],
  spellingWatchWords: ['chẩn đoán', 'chuẩn đoán', 'gãy', 'gay', 'phẫu thuật', 'phẩu thuật', 'chuyển viện', 'chuyển khoa'],
});

function mergeRules(base, override) {
  const o = override && typeof override === 'object' ? override : {};
  return {
    ...base,
    ...o,
    supplyDictionary: safeArray(o.supplyDictionary).length ? safeArray(o.supplyDictionary) : base.supplyDictionary,
    routineSupplies: safeArray(o.routineSupplies).length ? safeArray(o.routineSupplies) : base.routineSupplies,
    surgeryPackages: safeArray(o.surgeryPackages).length ? safeArray(o.surgeryPackages) : base.surgeryPackages,
    medicationRules: safeArray(o.medicationRules).length ? safeArray(o.medicationRules) : base.medicationRules,
    duplicateIngredientGroups: safeArray(o.duplicateIngredientGroups).length ? safeArray(o.duplicateIngredientGroups) : base.duplicateIngredientGroups,
    billingKeywords: o.billingKeywords && typeof o.billingKeywords === 'object' ? { ...base.billingKeywords, ...o.billingKeywords } : base.billingKeywords,
    dischargeDocumentRules: o.dischargeDocumentRules && typeof o.dischargeDocumentRules === 'object' ? { ...base.dischargeDocumentRules, ...o.dischargeDocumentRules } : base.dischargeDocumentRules,
    sickLeaveRules: o.sickLeaveRules && typeof o.sickLeaveRules === 'object' ? { ...base.sickLeaveRules, ...o.sickLeaveRules } : base.sickLeaveRules,
    followUpRules: o.followUpRules && typeof o.followUpRules === 'object' ? { ...base.followUpRules, ...o.followUpRules } : base.followUpRules,
    printDocuments: safeArray(o.printDocuments).length ? safeArray(o.printDocuments) : base.printDocuments,
    spellingWatchWords: safeArray(o.spellingWatchWords).length ? safeArray(o.spellingWatchWords) : base.spellingWatchWords,
  };
}

function loadAdminWorkflowRules(ctx) {
  const candidates = [
    ctx?.ADMIN_WORKFLOW_RULES_PATH,
    ctx?.dir ? path.join(ctx.dir, 'admin_workflow_rules.json') : '',
    path.join(process.cwd(), 'config', 'admin_workflow_rules.json'),
    path.join(process.cwd(), 'config', 'admin_workflow_rules.example.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return mergeRules(DEFAULT_RULES, readJsonSafe(file, {}));
    } catch (_) {}
  }
  return { ...DEFAULT_RULES };
}

module.exports = { DEFAULT_RULES, loadAdminWorkflowRules };
