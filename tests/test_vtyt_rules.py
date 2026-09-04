# -*- coding: utf-8 -*-
from worker.vtyt_rules import build_required_supplies, build_vtyt_jobs
from worker.care_templates import DIEN_BIEN_BASE_LINES, build_dien_bien, match_action_name


def names(plan):
    return {x['key']: x for x in plan}


def test_dien_bien_base_no_bung_mem_and_thay_bang_matches_or():
    assert 'Bụng mềm' not in DIEN_BIEN_BASE_LINES
    assert match_action_name('Thay băng vết mổ', 'THAY_BANG')
    assert match_action_name('Cắt chỉ vết mổ', 'THAY_BANG')
    text = build_dien_bien(DIEN_BIEN_BASE_LINES, {'THAY_BANG'}, {'vị trí đau': 'gối'})
    assert 'Đau vết mổ' in text
    assert 'Vết mổ rỉ dịch ít' in text
    assert 'Bụng mềm' not in text


def test_build_required_supplies_for_antibiotic_tmc_and_infusion():
    records = [{
        'ma_bn': 'BN01',
        'ngay_lam': '09/05/2026',
        'tuoi': 60,
        'thuoc': {
            'dich_truyen': [{'ten_thuoc': 'Natri Clorid 0,9% 500ml', 'gio_dung': '08:00'}],
            'thuoc_tiem': [{'ten_thuoc': 'Ceftriaxone 1g', 'duong_dung': 'TMC', 'gio_dung': '08:00-16:00'}],
        },
    }]
    plan = names(build_required_supplies(records))
    assert plan['GANG_TAY_KHAM']['required_quantity'] == 5
    assert plan['DAY_TRUYEN_DICH']['required_quantity'] == 1
    assert plan['BOM_TIEM_20ML']['required_quantity'] == 2
    assert plan['KIM_TIEM_PHA']['required_quantity'] >= 2
    assert plan['KIM_LUON_TM']['required_quantity'] == 2
    assert plan['BANG_DINH_KIM_LUON']['required_quantity'] == 2


def test_build_vtyt_jobs_respects_patient_dates():
    processed = [
        {'ma_bn': 'A', 'ngay_lam': '08/05/2026', 'thuoc': {'thuoc_tiem': [{'ten_thuoc': 'Vitamin K', 'duong_dung': 'Tiêm bắp', 'gio_dung': '08:00'}]}},
        {'ma_bn': 'A', 'ngay_lam': '09/05/2026', 'thuoc': {'thuoc_tiem': [{'ten_thuoc': 'Cefazolin', 'duong_dung': 'TMC', 'gio_dung': '08:00'}]}},
    ]
    jobs = build_vtyt_jobs(processed, {'patientIds': ['A'], 'patientDates': {'A': ['09/05/2026']}})
    assert len(jobs) == 1
    assert jobs[0]['key'] == 'A::09/05/2026'
    supply_keys = {x['key'] for x in jobs[0]['supplies']}
    assert 'BOM_TIEM_20ML' in supply_keys
    assert 'BOM_TIEM_5ML' not in supply_keys


def test_vtyt_classifies_daily_medication_dvkt_interval():
    records = [{
        'ma_bn': 'BN02',
        'ngay_lam': '10/05/2026',
        'tuoi': 40,
        'thuoc': {
            'dich_truyen': [{'ten_thuoc': 'Ringer lactat 500ml', 'gio_dung': '08:00-10:00'}],
            'thuoc_tiem': [{'ten_thuoc': 'Vitamin K', 'duong_dung': 'Tiêm bắp', 'gio_dung': '08:00'}],
        },
        'chi_dinh_khac': {'khac': ['Đặt sonde tiểu']},
    }]
    plan = build_required_supplies(records)
    by_key = names(plan)
    assert by_key['GANG_TAY_KHAM']['category'] == 'daily'
    assert by_key['DAY_TRUYEN_DICH']['category'] == 'medication'
    assert by_key['BOM_TIEM_5ML']['category'] == 'medication'
    assert by_key['TUI_NUOC_TIEU']['category'] == 'dvkt'
    assert by_key['KIM_LUON_TM']['category'] == 'interval'


def test_infusion_set_not_duplicated_when_sessions_are_continuous():
    processed = [
        {'ma_bn': 'A', 'ngay_lam': '09/05/2026', 'thuoc': {'dich_truyen': [{'ten_thuoc': 'Natri Clorid', 'gio_dung': '22:00-23:30'}]}},
        {'ma_bn': 'A', 'ngay_lam': '10/05/2026', 'thuoc': {'dich_truyen': [{'ten_thuoc': 'Glucose 5%', 'gio_dung': '00:30-02:00'}]}},
    ]
    jobs = build_vtyt_jobs(processed, {'patientIds': ['A'], 'patientDates': {'A': ['10/05/2026']}})
    plan = names(jobs[0]['supplies'])
    # Phiên truyền 00:30 liên tục với phiên trước đó, không cộng dây truyền mới.
    assert 'DAY_TRUYEN_DICH' not in plan


def test_infusion_set_added_when_new_session_after_gap():
    processed = [
        {'ma_bn': 'A', 'ngay_lam': '09/05/2026', 'thuoc': {'dich_truyen': [{'ten_thuoc': 'Natri Clorid', 'gio_dung': '08:00-10:00'}]}},
        {'ma_bn': 'A', 'ngay_lam': '10/05/2026', 'thuoc': {'dich_truyen': [{'ten_thuoc': 'Glucose 5%', 'gio_dung': '16:00-18:00'}]}},
    ]
    jobs = build_vtyt_jobs(processed, {'patientIds': ['A'], 'patientDates': {'A': ['10/05/2026']}})
    plan = names(jobs[0]['supplies'])
    assert plan['DAY_TRUYEN_DICH']['required_quantity'] == 1


def test_iv_catheter_skipped_when_recent_line_exists():
    processed = [
        {'ma_bn': 'A', 'ngay_lam': '08/05/2026', 'thuoc': {'thuoc_tiem': [{'ten_thuoc': 'Ceftriaxone', 'duong_dung': 'TMC', 'gio_dung': '08:00'}]}},
        {'ma_bn': 'A', 'ngay_lam': '10/05/2026', 'thuoc': {'thuoc_tiem': [{'ten_thuoc': 'Ceftriaxone', 'duong_dung': 'TMC', 'gio_dung': '08:00'}]}},
    ]
    jobs = build_vtyt_jobs(processed, {'patientIds': ['A'], 'patientDates': {'A': ['10/05/2026']}})
    plan = names(jobs[0]['supplies'])
    assert 'KIM_LUON_TM' not in plan
