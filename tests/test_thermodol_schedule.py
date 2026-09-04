# -*- coding: utf-8 -*-
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

from xu_ly_config import parse_hours_from_gio_dung
from processing.infusion_scheduler import calculate_infusion_times
from processing.medication_catalog import complete_medication_from_catalog


def test_parse_hours_keeps_hhmm_as_one_time():
    assert parse_hours_from_gio_dung('03:35, 16 giờ, 23 giờ') == [3, 16, 23]


def test_thermodol_hhmm_infusion_schedule_not_split_minutes():
    result = calculate_infusion_times([
        {
            'ten_thuoc': 'THERMODOL',
            'ten_hien_thi': 'THERMODOL',
            'gio_dung': '03:35, 16 giờ, 23 giờ',
            'gio_y_lenh': '03:35',
            'toc_do': '100',
            'the_tich': 100,
            'duong_dung_goc': 'TTM',
        }
    ], ngay_mac_dinh='03/05/2026')

    starts = [x.get('tg_bat_dau') for x in result]
    labels = [x.get('gio_dung') for x in result]

    assert labels == ['03:35', '16 giờ', '23 giờ']
    assert '03:35 04/05/2026' in starts
    assert '16:00 03/05/2026' in starts
    assert '23:00 03/05/2026' in starts
    assert len(result) == 3


def test_catalog_completes_thermodol_even_when_route_exists():
    drug, med = complete_medication_from_catalog({
        'ten_thuoc': 'THERMODOL',
        'so_luong': '3',
        'duong_dung_goc': 'TTM',
        'gio_y_lenh': '03:35',
    }, only_if_missing_usage=True)

    assert med is not None
    assert drug['gio_dung'] == '03:35, 16 giờ, 23 giờ'
    assert drug['toc_do'] == '100'
    assert drug['the_tich'] == 100.0



def test_degevic_oral_not_misread_as_thermodol():
    from processing.patient_day_builder import build_patient_day_records

    raw_y_lenh = """+ Thuốc:
DEGEVIC (Paracetamol + Tramadol hydrochlorid) 325mg+37,5mg x 3 (Viên)
Uống, 1 ngày, sáng 1 viên, chiều 1 viên, tối 1 viên(8 giờ, 16 giờ, 22 giờ).
"""
    data = [{
        'ma_bn': 'BN_TEST',
        'ho_ten': 'TEST',
        'ngay_lam': '04/05/2026',
        'Y lệnh': raw_y_lenh,
        'Diễn biến': '',
        'Bác sĩ': 'BS TEST',
    }]

    record = build_patient_day_records(data)[0]
    oral_names = [d.get('ten_hien_thi') or d.get('ten_thuoc') for d in record['thuoc']['thuoc_uong']]
    infusion_names = [d.get('ten_hien_thi') or d.get('ten_thuoc') for d in record['thuoc']['dich_truyen']]

    assert 'DEGEVIC' in oral_names
    assert 'THERMODOL' not in oral_names
    assert 'THERMODOL' not in infusion_names
