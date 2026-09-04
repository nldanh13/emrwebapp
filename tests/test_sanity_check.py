# -*- coding: utf-8 -*-
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

from processing.validators.sanity_check import run_sanity_checks


def test_sanity_warns_when_infusion_text_but_empty():
    records = [{
        'ngay_lam': '01/05/2026',
        'ma_bn': 'BN001',
        'ho_ten': 'A',
        'nhap_cham_soc': {
            'dien_bien': '',
            'y_lenh': 'SODIUM CHLORIDE 0,9% 500ml x 1\nTiêm truyền tĩnh mạch 40g/ph.',
        },
        'thuoc': {'dich_truyen': [], 'thuoc_tiem': [], 'thuoc_uong': [], 'thuoc_tra': [], 'khac': []},
        'chi_dinh_khac': {},
    }]

    warnings = run_sanity_checks(records)
    codes = {w['code'] for w in warnings}
    assert 'INFUSION_TEXT_BUT_EMPTY' in codes
    assert 'MEDICATION_TEXT_BUT_NO_MED' in codes


def test_sanity_no_warning_when_infusion_exists():
    records = [{
        'ngay_lam': '01/05/2026',
        'ma_bn': 'BN001',
        'ho_ten': 'A',
        'nhap_cham_soc': {
            'dien_bien': '',
            'y_lenh': 'SODIUM CHLORIDE 0,9% 500ml x 1\nTiêm truyền tĩnh mạch 40g/ph.',
        },
        'thuoc': {
            'dich_truyen': [{'ten_thuoc': 'SODIUM CHLORIDE'}],
            'thuoc_tiem': [], 'thuoc_uong': [], 'thuoc_tra': [], 'khac': [],
        },
        'chi_dinh_khac': {},
    }]

    warnings = run_sanity_checks(records)
    codes = {w['code'] for w in warnings}
    assert 'INFUSION_TEXT_BUT_EMPTY' not in codes
    assert 'MEDICATION_TEXT_BUT_NO_MED' not in codes
