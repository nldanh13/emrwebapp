# -*- coding: utf-8 -*-
"""worker/clinic_monitor.py — đọc chi tiết từng lượt khám (chỉ đọc) cho Kho người bệnh."""
import os
import sys
from datetime import datetime as DT, timedelta

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


def test_need_details_rules():
    now = DT(2026, 9, 28, 10, 0)
    row = {'khambenhid': 'K1', 'href': '/x', 'stage': 'dang_kham', 'case': 'cho_ve', 'xu_tri': 'Cho về'}
    assert cm._need_details(row, None, now)
    assert not cm._need_details({**row, 'stage': 'cho_kham'}, None, now)
    assert not cm._need_details({**row, 'case': 'chua_xu_tri', 'xu_tri': ''}, None, now)
    assert not cm._need_details({**row, 'href': ''}, None, now)
    read = {'status': 'ok', 'stage': 'dang_kham', 'xu_tri': 'Cho về'}
    assert not cm._need_details(row, read, now)                              # đã đọc, chưa đổi gì
    assert cm._need_details({**row, 'stage': 'xong'}, read, now)             # Hoàn tất → đọc lại để chốt
    assert cm._need_details({**row, 'xu_tri': 'Nhập viện'}, read, now)       # xử trí đổi
    assert not cm._need_details({**row, 'stage': 'xong'}, {**read, 'stage': 'xong'}, now)
    err = {'status': 'error', 'errors': 1, 'at': (now - timedelta(minutes=5)).isoformat()}
    assert not cm._need_details(row, err, now)
    assert cm._need_details(row, {**err, 'at': (now - timedelta(minutes=20)).isoformat()}, now)
    assert not cm._need_details(row, {**err, 'errors': 3, 'at': (now - timedelta(hours=2)).isoformat()}, now)


class FakeMonitor:
    def __init__(self, fail=()):
        self.opened = []
        self.fail = set(fail)

    def on_exam_page(self, row, action, need_services=True):
        assert need_services is False  # không cần đọc giờ xong chỉ định
        self.opened.append(row['khambenhid'])
        if row['khambenhid'] in self.fail:
            return {'status': 'error', 'result': 'error', 'message': 'lỗi'}
        return action(FakeExam(), None, DT(2026, 9, 28, 10, 0))


def test_scan_visit_details_limits_and_prioritises_completed():
    rows = [{'khambenhid': f'K{i}', 'href': '/x', 'stage': 'dang_kham', 'case': 'cho_ve', 'xu_tri': 'Cho về'} for i in range(6)]
    rows[5]['stage'] = 'xong'
    cache = {}
    mon = FakeMonitor()
    cm.scan_visit_details(mon, rows, cache)
    assert len(mon.opened) == cm.MAX_DETAILS_PER_CYCLE and mon.opened[0] == 'K5'
    assert cache['K5']['status'] == 'ok' and cache['K5']['hen_tai_kham'] == '05/10/2026'

    # Đọc lại lỗi → giữ bản đọc được trước đó.
    mon = FakeMonitor(fail={'K5'})
    rows[5]['xu_tri'] = 'Nhập viện'
    cm.scan_visit_details(mon, [rows[5]], cache)
    assert cache['K5']['status'] == 'ok' and cache['K5']['cd_chinh']


def test_public_rows_carry_details_and_imaging():
    row = {'khambenhid': 'K1', 'href': '/secret', 'ma_bn': 'BN1', 'stage': 'xong', 'case': 'cho_ve', 'has_bhyt': True, 'services': []}
    out = cm.public_rows([row], {}, {}, imaging={'K1': {'orders': [{'kind': 'CT', 'name': 'Chụp CT', 'time': ''}]}},
                         details={'K1': {'status': 'ok', 'cd_chinh': 'A'}})
    assert 'href' not in out[0]
    assert out[0]['imaging_orders'][0]['kind'] == 'CT' and out[0]['details']['cd_chinh'] == 'A'
