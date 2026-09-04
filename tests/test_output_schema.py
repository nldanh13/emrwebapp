# -*- coding: utf-8 -*-
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

from processing.output_schema import make_patient_day_record
from processing.medication_parser import clean_text_for_entry


def test_make_patient_day_record_has_expected_buckets():
    record = make_patient_day_record(
        {'Mã BN': 'BN001', 'Họ tên': 'Nhân Viên A', 'Vi_Tri': 'P01'},
        ngay_lam='01/05/2026',
        raw_dien_bien='Người bệnh tỉnh',
        raw_y_lenh='THERMODOL x 1',
        doc_name='BS A',
        doc_content='THERMODOL x 1',
        order_header_time='05:00',
        clean_text_for_entry=clean_text_for_entry,
    )

    assert record['ma_bn'] == 'BN001'
    assert record['ho_ten'] == 'Nhân Viên A'
    assert record['ngay_lam'] == '01/05/2026'
    assert record['gio_y_lenh'] == '05:00'
    assert set(record['thuoc'].keys()) == {'dich_truyen', 'thuoc_tiem', 'thuoc_uong', 'thuoc_tra', 'khac'}
