export const ANTIBIOTIC_KEYWORDS = Object.freeze([
  'cefoxitin', 'ceftriaxone', 'cefuroxime', 'ceftazidime', 'cefazolin', 'cefixime',
  'levofloxacin', 'ciprofloxacin', 'moxifloxacin', 'metronidazole', 'vancomycin',
  'amikacin', 'gentamicin', 'meropenem', 'imipenem', 'ertapenem', 'piperacillin',
  'tazobactam', 'augmentin', 'amoxicillin', 'clavulanate', 'clindamycin'
]);

export const VTYT_RULES = Object.freeze([
  {
    id: 'GANG_TAY_MOI_NGAY',
    label: 'Mỗi người bệnh lên găng tay mỗi ngày',
    type: 'daily_patient',
    supplies: [{ item: 'GANG_TAY_KHAM', quantityType: 'range_per_day', min: 4, max: 5 }],
  },
  {
    id: 'TRUYEN_DICH',
    label: 'Có truyền dịch/tiêm truyền',
    type: 'route',
    routeKeywords: ['truyền', 'tiêm truyền', 'tiêm truyền tĩnh mạch'],
    supplies: [{ item: 'DAY_TRUYEN_DICH', quantityType: 'per_medication_time', value: 1 }],
  },
  {
    id: 'KHANG_SINH_TMC',
    label: 'Kháng sinh TMC',
    type: 'antibiotic_tmc',
    supplies: [
      { item: 'BOM_TIEM_20ML', quantityType: 'per_dose', value: 1 },
      { item: 'KIM_TIEM_PHA', quantityType: 'per_dose', value: 1 },
    ],
  },
  {
    id: 'TIEM_BAP',
    label: 'Tiêm bắp',
    type: 'route',
    routeKeywords: ['tiêm bắp', 'tb'],
    supplies: [
      { item: 'BOM_TIEM_5ML', quantityType: 'per_dose', value: 1 },
      { item: 'KIM_TIEM_PHA', quantityType: 'per_dose', value: 1 },
    ],
  },
  {
    id: 'THUOC_TMC_KHAC',
    label: 'Thuốc TMC khác',
    type: 'other_tmc',
    supplies: [
      { item: 'BOM_TIEM_10ML', quantityType: 'per_dose', value: 1 },
      { item: 'KIM_TIEM_PHA', quantityType: 'per_dose', value: 1 },
    ],
  },
  {
    id: 'THUOC_PHA_NACL',
    label: 'Thuốc pha Natri clorid',
    type: 'mixed_with_nacl',
    supplies: [
      { item: 'BOM_TIEM_10ML', quantityType: 'per_dose', value: 1 },
      { item: 'KIM_TIEM_PHA', quantityType: 'per_dose', value: 1 },
    ],
  },
  {
    id: 'NUT_KIM_LUON_MOI_NGAY',
    label: 'Nút/khóa kim luồn mỗi ngày khi có TMC/truyền dịch',
    type: 'has_tmc_or_infusion_daily',
    supplies: [{ item: 'NUT_KIM_LUON_OR_KHOA_3_NGA', quantityType: 'per_day', value: 1 }],
  },
  {
    id: 'KIM_LUON',
    label: 'Kim luồn và băng dính kim luồn',
    type: 'iv_catheter_cycle',
    supplies: [
      { item: 'KIM_LUON_TM', quantityType: 'iv_catheter_cycle' },
      { item: 'BANG_DINH_KIM_LUON', quantityType: 'same_as_iv_catheter' },
    ],
  },
  {
    id: 'SONDE_TIEU',
    label: 'Đặt sonde tiểu',
    type: 'order_keywords',
    keywords: ['sonde tiểu', 'đặt sonde tiểu', 'foley', 'thông tiểu'],
    supplies: [
      { item: 'TUI_NUOC_TIEU', quantityType: 'one_time', value: 1 },
      { item: 'SONDE_FOLEY_2_NHANH', quantityType: 'one_time', value: 1 },
      { item: 'BOM_TIEM_10ML', quantityType: 'one_time', value: 1 },
    ],
  },
  {
    id: 'THO_OXY',
    label: 'Thở oxy',
    type: 'order_keywords',
    keywords: ['thở oxy', 'oxy'],
    supplies: [{ item: 'DAY_OXY', quantityType: 'one_time', value: 1 }],
  },
  {
    id: 'PHUN_KHI_DUNG',
    label: 'Phun/xông khí dung',
    type: 'order_keywords',
    keywords: ['phun khí dung', 'xông khí dung', 'khí dung'],
    supplies: [{ item: 'MAT_NA_KHI_DUNG', quantityType: 'one_time', value: 1 }],
  },
  {
    id: 'BOM_RUA_BANG_QUANG',
    label: 'Bơm rửa bàng quang',
    type: 'order_keywords',
    keywords: ['bơm rửa bàng quang', 'rửa bàng quang'],
    supplies: [{ item: 'BOM_TIEM_50ML_CHO_AN', quantityType: 'one_time', value: 1 }],
  },
  {
    id: 'SONDE_DA_DAY',
    label: 'Đặt sonde dạ dày',
    type: 'order_keywords',
    keywords: ['sonde dạ dày', 'đặt thông dạ dày', 'ống thông dạ dày'],
    supplies: [
      { item: 'BOM_TIEM_50ML_CHO_AN', quantityType: 'one_time', value: 1 },
      { item: 'ONG_THONG_DA_DAY', quantityType: 'one_time', value: 1 },
    ],
  },
]);

export const SURGERY_VTYT_RULES = Object.freeze([
  {
    id: 'MO_TAY_CHAN_BANG_THUN',
    label: 'Mổ tay/chân dùng băng thun 3-4 ngày đầu, sau đó băng dính 250',
    locationIncludes: ['tay', 'cẳng tay', 'cánh tay', 'bàn tay', 'chân', 'cẳng chân', 'đùi', 'bàn chân'],
    excludeIncludes: ['gãy xương đòn', 'thay khớp háng'],
    earlySupplies: [{ item: 'BANG_THUN_3_MOC', quantityType: 'postop_day_range', value: 1 }],
    lateSupplies: [{ item: 'BANG_DINH_250X90', quantityType: 'per_dressing_session', value: 1 }],
  },
  {
    id: 'MO_LUNG_KHOP_HANG_BANG_DINH',
    label: 'Mổ vùng lưng/khớp háng dùng băng dính',
    locationIncludes: ['lưng', 'cột sống', 'khớp háng', 'háng'],
    supplies: [{ item: 'BANG_DINH_250X90', quantityType: 'per_dressing_session', value: 1 }],
  },
  {
    id: 'MO_NOI_SOI',
    label: 'Mổ nội soi thêm 1-2 băng dính 6x7',
    methodIncludes: ['nội soi', 'noi soi'],
    supplies: [{ item: 'BANG_DINH_60X70', quantityType: 'range_per_session', min: 1, max: 2 }],
  },
]);
