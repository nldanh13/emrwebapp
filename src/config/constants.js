export const RUN_MODES = Object.freeze({
  CHECK_ONLY: 'check_only',
  PREVIEW: 'preview',
  EXECUTE: 'execute',
});

export const EXIT_TYPES = Object.freeze(['Ra viện', 'Chuyển khoa', 'Chuyển viện', 'Tử vong']);

export const LOAI_HANG = Object.freeze({
  THUOC: '0',
  VAT_TU: '1',
  MAU: '2',
  HOA_CHAT: '3',
  THUOC_YHCT: '4',
});

export const DU_TRU_ACTION = Object.freeze({
  LINH: '0',
  TRA: '1',
});

export const DEFAULT_QUANTITY_CONFIG = Object.freeze({
  glovesPerPatientPerDayMin: 4,
  glovesPerPatientPerDayMax: 5,
  infusionSetPerMedicationTime: 1,
  antibioticTmcSyringe20mlPerDose: 1,
  imSyringe5mlPerDose: 1,
  otherTmcSyringe10mlPerDose: 1,
  naclMixSyringe10mlPerDose: 1,
  mixingNeedlePerDose: 1,
  ivCatheterPlugPerDay: 1,
  ivCatheterCycleDays: 3,
  ivCatheterDefaultQuantity: 1,
  ivCatheterAge55PlusQuantity: 2,
  postopElasticBandageDays: 4,
  arthroscopySmallDressingMin: 1,
  arthroscopySmallDressingMax: 2,
});
