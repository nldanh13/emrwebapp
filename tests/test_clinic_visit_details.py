# -*- coding: utf-8 -*-
"""worker/clinic_monitor.py — đọc chi tiết từng lượt khám (chỉ đọc) cho Kho người bệnh."""
import os
import sys
from datetime import datetime as DT

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WORKER = os.path.join(ROOT, 'worker')
if WORKER not in sys.path:
    sys.path.insert(0, WORKER)

import clinic_monitor as cm  # noqa: E402


def test_hen_tai_kham_from_label():
    fields = [{'label': 'Thời gian ra *', 'id': 'txtThoigianRa', 'value': '10:00 28/09/2026'},
              {'label': 'Ngày hẹn tái khám', 'id': 'txtNgayHen', 'value': '05/10/2026'}]
    assert cm.hen_tai_kham_from_xutri(fields) == '05/10/2026'
    assert cm.hen_tai_kham_from_xutri([{'label': 'Hẹn khám lại', 'value': '08:00 06/10/2026'}]) == '08:00 06/10/2026'
    assert cm.hen_tai_kham_from_xutri([{'label': 'Chẩn đoán', 'value': 'Tăng huyết áp'}]) == ''
    assert cm.hen_tai_kham_from_xutri([{'label': 'Ngày hẹn', 'value': ''}]) == ''


class FakeExam:
    """Thay ExamPage: trả kết quả JS theo script, ghi lại thao tác."""

    def __init__(self, xutri_ok=True):
        self.calls = []
        self.xutri_ok = xutri_ok

    def js(self, script, *args):
        if script is cm.clinic_bbhc.EXAM_INFO_JS:
            return {'ly_do': 'Đau gối', 'cd_chinh': 'M17.1 - Thoái hóa khớp gối', 'cd_kem_theo': ['I10 - Tăng huyết áp', ''], 'ket_luan': ''}
        if script is cm.clinic_bbhc.XUTRI_FIELDS_JS:
            return [{'label': 'txtThoigianRa', 'id': 'txtThoigianRa', 'value': '09:30 28/09/2026'},
                    {'label': 'Thời gian ra *', 'id': 'txtThoigianRa', 'value': '09:30 28/09/2026'},
                    {'label': 'Ngày hẹn tái khám', 'id': 'x', 'value': '05/10/2026'},
                    {'label': 'Ghi chú', 'id': 'y', 'value': ''}]
        return None

    def _open_xutri(self):
        self.calls.append('open_xutri')
        if not self.xutri_ok:
            raise cm.ExamStepError('Không mở được Chi tiết xử trí')

    def _close_xutri(self):
        self.calls.append('close_xutri')


def test_read_visit_details_is_read_only():
    page = FakeExam()
    row = {'stage': 'xong', 'trang_thai': 'Hoàn tất', 'xu_tri': 'Cho về'}
    d = cm.read_visit_details(page, row)
    assert d['status'] == 'ok' and d['stage'] == 'xong'
    assert d['cd_chinh'] == 'M17.1 - Thoái hóa khớp gối' and d['cd_kem_theo'] == ['I10 - Tăng huyết áp']
    assert d['thoi_gian_ra'] == '09:30 28/09/2026' and d['hen_tai_kham'] == '05/10/2026'
    assert [f['label'] for f in d['xu_tri_fields']] == ['Thời gian ra *', 'Ngày hẹn tái khám']
    assert page.calls == ['open_xutri', 'close_xutri']

    # Không mở được popup xử trí: vẫn giữ chẩn đoán.
    d = cm.read_visit_details(FakeExam(xutri_ok=False), row)
    assert d['status'] == 'ok' and d['cd_chinh'] and d['hen_tai_kham'] == '' and d['xu_tri_fields'] == []


def test_public_rows_carry_details_and_imaging():
    row = {'khambenhid': 'K1', 'href': '/secret', 'ma_bn': 'BN1', 'stage': 'xong', 'case': 'cho_ve', 'has_bhyt': True, 'services': []}
    out = cm.public_rows([row], {}, {}, imaging={'K1': {'orders': [{'kind': 'CT', 'name': 'Chụp CT', 'time': ''}]}},
                         details={'K1': {'status': 'ok', 'cd_chinh': 'A'}})
    assert 'href' not in out[0]
    assert out[0]['imaging_orders'][0]['kind'] == 'CT' and out[0]['details']['cd_chinh'] == 'A'
