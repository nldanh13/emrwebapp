#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { checkDischarge, checkSurgeryCompleteness } = require('../server/services/hchanh/discharge_qa');

const dischargeRules = { discharge_paper_rules: { require_loi_dan: true } };
const dischargeIssues = checkDischarge({ xu_tri:'Ra viện', ngay_ra:'29/09/2026', chan_doan_chinh:'Gãy xương đùi' }, {}, dischargeRules);
assert.ok(dischargeIssues.some(issue => issue.code === 'DISCHARGE_ADVICE_MISSING'));
assert.ok(!checkDischarge({ xu_tri:'Ra viện', ngay_ra:'29/09/2026', chan_doan_chinh:'Gãy xương đùi', loi_dan:'Tái khám sau 7 ngày' }, {}, dischargeRules).some(issue => issue.code === 'DISCHARGE_ADVICE_MISSING'));

const incompleteSurgery = checkSurgeryCompleteness({ surgeries: [{
  noi_dung_phau_thuat:'Kết hợp xương đùi', bat_dau:'08:00 29/09/2026',
}] });
assert.ok(incompleteSurgery.some(issue => issue.code === 'SURGERY_TIME_MISSING'));
assert.ok(incompleteSurgery.some(issue => issue.code === 'SURGERY_METHOD_MISSING'));
assert.ok(incompleteSurgery.some(issue => issue.code === 'SURGERY_MAIN_SURGEON_MISSING'));
assert.ok(incompleteSurgery.some(issue => issue.code === 'SURGERY_ANESTHESIA_MISSING'));

const completeSurgery = checkSurgeryCompleteness({ surgeries: [{ detail: {
  dich_vu_phau_thuat:'Kết hợp xương đùi', bat_dau:'08:00 29/09/2026', ket_thuc:'10:00 29/09/2026',
  phuong_phap_pt:'Kết hợp xương nẹp vít', bs_mo_chinh:'BS A', pp_vo_cam:'Tê tủy sống',
} }] });
assert.deepStrictEqual(completeSurgery, []);

console.log('hchanh_record_completeness_test: ok');
