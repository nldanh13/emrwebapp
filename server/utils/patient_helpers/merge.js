'use strict';

const { dedupeStrings, dedupeBy, firstNonEmpty } = require('./common');

function mergeDrugList(records, key) {
  return dedupeBy(
    records.flatMap(r => ((r.thuoc || {})[key] || [])),
    item => [
      String(item?.ten_hien_thi || item?.ten_thuoc || item?.hoat_chat || '').trim().toLowerCase(),
      String(item?.tg_bat_dau   || item?.gio_dung  || '').trim(),
      String(item?.duong_dung   || item?.duong_dung_goc || '').trim().toLowerCase(),
    ].join('|'),
  );
}

function mergeRecordGroup(record = {}, records = []) {
  const list = (Array.isArray(records) && records.length ? records : [record]).filter(Boolean);
  const base = { ...(record || {}) };

  base.thuoc = {
    ...(record.thuoc || {}),
    dich_truyen: mergeDrugList(list, 'dich_truyen'),
    thuoc_tiem:  mergeDrugList(list, 'thuoc_tiem'),
    thuoc_uong:  mergeDrugList(list, 'thuoc_uong'),
    thuoc_tra:   mergeDrugList(list, 'thuoc_tra'),
    khac:        mergeDrugList(list, 'khac'),
  };

  const allCs = list.map(r => r.chi_dinh_khac || {});
  base.chi_dinh_khac = {
    ...(record.chi_dinh_khac || {}),
    thay_bang_cat_chi: dedupeBy(
      allCs.flatMap(x => x.thay_bang_cat_chi || []),
      item => `${String(item?.ten || '').trim().toLowerCase()}|${String(item?.gio || '').trim()}`,
    ),
    duong_mau_mao_mach: dedupeBy(
      allCs.flatMap(x => x.duong_mau_mao_mach || []),
      item => `${String(item?.ten || '').trim().toLowerCase()}|${String(item?.gio || '').trim()}`,
    ),
    vat_ly_tri_lieu: firstNonEmpty(allCs.map(x => x.vat_ly_tri_lieu)),
    che_do_an:       firstNonEmpty(allCs.map(x => x.che_do_an)),
    canh_bao:        dedupeStrings(allCs.flatMap(x => x.canh_bao || [])),
  };

  base.chi_dinh_dvkt = dedupeBy(
    list.flatMap(r => r.chi_dinh_dvkt || []),
    item => `${String(item?.ten || '').trim().toLowerCase()}|${String(item?.gio || '').trim()}`,
  );

  const allYk = list.map(r => r.y_lenh_khac || {});
  base.y_lenh_khac = {
    moi_hoi_chan: dedupeStrings(allYk.flatMap(x => x.moi_hoi_chan || [])),
    khac:         dedupeStrings(allYk.flatMap(x => x.khac || [])),
  };

  return base;
}

module.exports = { mergeDrugList, mergeRecordGroup };
