# -*- coding: utf-8 -*-
"""worker/clinic_ngoaitru.py — TH6 điều trị ngoại trú: đọc danh sách, quy tắc giờ, thứ tự các bước."""
import os
import sys
from datetime import datetime as DT

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WORKER = os.path.join(ROOT, 'worker')
if WORKER not in sys.path:
    sys.path.insert(0, WORKER)

import clinic_ngoaitru as nt  # noqa: E402

NOW = DT(2026, 9, 28, 11, 0)


def _a(wpid, key, val, text):
    return f'<a href="home.aspx?scope=sys&amp;wpid={wpid}&amp;{key}={val}&amp;usid=x">{text}</a>'


def test_parse_lists():
    tn = ('<table id="tblDS"><thead><tr><th>STT</th><th>Thời gian</th><th>Mã BN</th><th>Họ tên</th><th>Tuổi</th>'
          '<th>Đối tượng</th><th>Nơi chuyển đến</th><th>Khoa tiếp nhận</th><th>Trạng thái</th></tr></thead><tbody>'
          '<tr>' + ''.join(f'<td>{_a("tiepnhanngoaitrudraw", "ttvaorakhoaid", "t1", x)}</td>' for x in
                          ['1', '10:35 28/09/2026', '26059292', 'NGƯỜI A', '63', 'Bảo hiểm', 'Khoa Khám Bệnh', 'Khoa Khám Bệnh', '<span class="badge">Chờ nhập khoa</span>']) +
          '</tr></tbody></table>')
    rows = nt.tiepnhan_rows(tn)
    assert rows[0]['id'] == 't1' and rows[0]['ma_bn'] == '26059292' and rows[0]['trang_thai'] == 'Chờ nhập khoa'

    ng = ('<table id="tblNgoaiTru"><thead><tr><th>Thời gian vào khoa</th><th>Kết quả</th><th>Mã BN</th><th>Họ tên</th>'
          '<th>Trạng thái</th><th>Chẩn đoán</th></tr></thead><tbody><tr>'
          f'<td>{_a("dieutringoaitrudraw", "ngoaitruid", "n1", "10:40 28/09/2026")}</td><td><a class="btn">Xem kết quả</a></td>'
          f'<td>{_a("dieutringoaitrudraw", "ngoaitruid", "n1", "26059292")}</td><td>{_a("dieutringoaitrudraw", "ngoaitruid", "n1", "NGƯỜI A")}</td>'
          '<td><span class="badge">Đang thực hiện</span></td><td>Ngón tay lò xo</td></tr></tbody></table>')
    rows = nt.ngoaitru_rows(ng)
    assert rows[0]['id'] == 'n1' and rows[0]['vao_khoa'] == '10:40 28/09/2026' and rows[0]['ma_bn'] == '26059292'

    pt = ('<div id="divDanhSachPhauThuatContent"><table><thead><tr><th>STT</th><th>Mã BN</th><th>Họ tên</th><th>Nơi chuyển mổ</th>'
          '<th>Nội dung phẫu thuật</th><th>Thời gian</th><th>Trạng thái</th></tr></thead><tbody><tr>'
          f'<td>1</td><td>{_a("phauthuatdraw", "phauthuatid", "p1", "26059292")}</td>'
          f'<td>{_a("phauthuatdraw", "phauthuatid", "p1", "NGƯỜI A (Phẫu thuật tại khoa)")}</td><td>Khoa Khám Bệnh</td>'
          '<td>Phẫu thuật điều trị ngón tay cò súng</td><td>28/09/2026</td><td>Chờ thực hiện</td></tr></tbody></table></div>')
    rows = nt.phauthuat_rows(pt)
    assert rows[0]['id'] == 'p1' and rows[0]['ho_ten'] == 'NGƯỜI A' and not nt.is_done(rows[0]['trang_thai'])
    assert nt.is_done('Hoàn tất')


def test_time_rules():
    exam = DT(2026, 9, 28, 10, 0)
    # Giờ vào khoa EMR hợp lệ → giữ; sớm hơn giờ khám + 3 phút hoặc ở tương lai → = giờ khám + 3 phút.
    assert nt.admission_time(DT(2026, 9, 28, 10, 35), exam, NOW) == {'result': 'ok', 'value': DT(2026, 9, 28, 10, 35), 'changed': False}
    assert nt.admission_time(DT(2026, 9, 28, 10, 1), exam, NOW)['value'] == DT(2026, 9, 28, 10, 3)
    assert nt.admission_time(DT(2026, 9, 28, 11, 30), exam, NOW)['value'] == DT(2026, 9, 28, 10, 3)
    assert nt.admission_time(None, DT(2026, 9, 28, 10, 59), NOW)['result'] == 'waiting'

    admitted = DT(2026, 9, 28, 10, 5)
    # Bắt đầu mổ = vào khoa + 1 phút, kết thúc + 15 phút; chưa tới giờ kết thúc thì chờ.
    assert nt.surgery_window(admitted, NOW) == {'result': 'ok', 'start': DT(2026, 9, 28, 10, 6), 'end': DT(2026, 9, 28, 10, 21)}
    assert nt.surgery_window(DT(2026, 9, 28, 10, 50), NOW)['result'] == 'waiting'

    lower = DT(2026, 9, 28, 10, 35)
    assert nt.discharge_time(DT(2026, 9, 28, 10, 50), lower, NOW)['changed'] is False
    assert nt.discharge_time(DT(2026, 9, 28, 10, 30), lower, NOW) == {'result': 'ok', 'value': NOW, 'changed': True}
    assert nt.discharge_time(None, DT(2026, 9, 28, 10, 59, 30), NOW)['result'] == 'waiting'
    assert nt.same_diagnosis_text('M65.3 - Ngón tay lò xo') == 'Ngón tay lò xo'


class FakeFlow:
    def __init__(self, lists, admit_result=None, pt_result=None):
        self.lists, self.calls = lists, []
        self.admit_result = admit_result or {'result': 'done', 'value': DT(2026, 9, 28, 10, 5), 'steps': ['Nhập khoa']}
        self.pt_result = pt_result or {'result': 'done', 'end': DT(2026, 9, 28, 10, 21), 'steps': ['Kết thúc mổ']}
        self.driver = None

    def open_list(self, wpid):
        self.calls.append(('list', wpid))
        return self.lists[wpid]

    def admit(self, row, exam_time, now):
        self.calls.append(('admit', row['ma_bn']))
        return self.admit_result

    def finish_surgery(self, row, admitted, doctor, now, nurse='', has_bhyt=None):
        self.calls.append(('pt', row['ma_bn'], admitted, doctor))
        return self.pt_result

    def discharge(self, row, lower, now, texts):
        self.calls.append(('ra', row['ma_bn'], lower))
        return {'result': 'done', 'message': 'Đã kết thúc điều trị ngoại trú', 'steps': ['Kết thúc điều trị']}


def _lists(tn_status='Chờ nhập khoa', pt_status='Chờ thực hiện', in_nt=True):
    tn = f'<table id="tblDS"><thead><tr><th>Mã BN</th><th>Trạng thái</th></tr></thead><tbody><tr><td>{_a("x", "ttvaorakhoaid", "t1", "26059292")}</td><td>{tn_status}</td></tr></tbody></table>'
    ng = (f'<table id="tblNgoaiTru"><thead><tr><th>Thời gian vào khoa</th><th>Mã BN</th></tr></thead><tbody><tr>'
          f'<td>{_a("x", "ngoaitruid", "n1", "10:05 28/09/2026")}</td><td>{_a("x", "ngoaitruid", "n1", "26059292")}</td></tr></tbody></table>') if in_nt else '<table id="tblNgoaiTru"></table>'
    pt = f'<table><thead><tr><th>Mã BN</th><th>Trạng thái</th></tr></thead><tbody><tr><td>{_a("x", "phauthuatid", "p1", "26059292")}</td><td>{pt_status}</td></tr></tbody></table>'
    return {nt.WPID_TIEPNHAN: tn, nt.WPID_NGOAITRU: ng, nt.WPID_PHAUTHUAT: pt}


def test_run_all_goes_screen_by_screen():
    flow = FakeFlow(_lists())
    res = nt.run_all(flow, [{'ma_bn': '26059292', 'exam_time': DT(2026, 9, 28, 10, 0)}], 'Hồ Điền', lambda: NOW)
    assert res['26059292']['result'] == 'done'
    assert res['26059292']['steps'] == ['Nhập khoa', 'Kết thúc mổ', 'Kết thúc điều trị']
    assert [c[0] for c in flow.calls] == ['list', 'admit', 'list', 'list', 'pt', 'ra']
    assert flow.calls[4][2:] == (DT(2026, 9, 28, 10, 5), 'Hồ Điền')
    assert flow.calls[5][2] == DT(2026, 9, 28, 10, 21)   # thời gian ra sau kết thúc mổ


def test_run_all_stops_patient_when_surgery_must_wait_and_skips_done_steps():
    flow = FakeFlow(_lists(), pt_result={'result': 'waiting', 'message': 'chờ tới 11:10'})
    res = nt.run_all(flow, [{'ma_bn': '26059292'}], 'Hồ Điền', lambda: NOW)
    assert res['26059292']['result'] == 'waiting' and not any(c[0] == 'ra' for c in flow.calls)

    # Đã nhập khoa, mổ đã hoàn tất → chỉ còn Tổng kết + Kết thúc điều trị (giờ vào khoa lấy từ danh sách).
    flow = FakeFlow(_lists(tn_status='Đã nhập khoa', pt_status='Hoàn tất'))
    res = nt.run_all(flow, [{'ma_bn': '26059292'}], 'Hồ Điền', lambda: NOW)
    assert [c[0] for c in flow.calls if c[0] != 'list'] == ['ra'] and res['26059292']['result'] == 'done'
    assert flow.calls[-1][2] == DT(2026, 9, 28, 10, 5)

    # Nhập khoa lỗi → không làm tiếp người đó.
    flow = FakeFlow(_lists(), admit_result={'result': 'waiting', 'message': 'Chờ tới 10:03'})
    res = nt.run_all(flow, [{'ma_bn': '26059292'}], '', lambda: NOW)
    assert res['26059292']['result'] == 'waiting' and not any(c[0] in {'pt', 'ra'} for c in flow.calls)


def test_clinic_doctor_from_schedule_and_candidates():
    import clinic_monitor as cm
    from clinic_input_care import clinic_doctors_for_date

    sched = {'days': {'2026-09-28': {'work': ['ĐD A'], 'doctor': ['Hồ Điền']}}, 'Monday': {'doctor': ['BS Thứ Hai']}}
    assert clinic_doctors_for_date(sched, '28/09/2026') == ['Hồ Điền']
    assert clinic_doctors_for_date(sched, '05/10/2026') == ['BS Thứ Hai']          # thứ hai, không có lịch riêng
    assert cm.clinic_doctor({'clinic_nurse_schedule': sched}, NOW) == 'Hồ Điền'
    assert cm.clinic_doctor({}, NOW) == ''
    assert cm.ngoaitru_candidate({'has_bhyt': True, 'case': 'ngoai_tru', 'stage': 'ngoai_tru'}) is True
    assert cm.ngoaitru_candidate({'has_bhyt': False, 'case': 'ngoai_tru', 'stage': 'ngoai_tru'}) is True  # viện phí như BHYT
    assert cm.ngoaitru_candidate({'has_bhyt': True, 'case': 'cho_ve', 'stage': 'dang_kham'}) is False


def test_server_keeps_clinic_doctor_outside_nurse_roster():
    import json
    import subprocess
    out = subprocess.run(['node', '-e', (
        "const n=require('./server/utils/nurse_config.js');"
        "const s=n.filterScheduleByNurseList({days:{'2026-09-28':{work:['ĐD A','Người lạ'],doctor:['Hồ Điền']}},Default:{work:['ĐD A']}},['ĐD A']);"
        "console.log(JSON.stringify({day:s.days['2026-09-28'],def:s.Default}));")],
        cwd=ROOT, capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    assert data['day'] == {'admin': [], 'work': ['ĐD A'], 'oncall': [], 'doctor': ['Hồ Điền']}
    assert 'doctor' not in data['def']   # không thêm khoá rỗng vào lịch cũ


def test_extra_emr_box_is_described_for_the_user():
    msg = nt.describe_modal({'id': 'divFormModalLyDoHoanTat', 'title': 'Lý do hoàn tất',
                             'text': 'Thời gian thực hiện ngắn hơn định mức. Nhập lý do.', 'fields': ['Lý do *']})
    assert msg == '«Lý do hoàn tất» — nội dung: Thời gian thực hiện ngắn hơn định mức. Nhập lý do. — ô cần điền: Lý do *'
    assert nt.describe_modal({'id': 'x'}) == '«x»'


class SurgeryForm(nt.NgoaiTruFlow):
    """Phiếu phẫu thuật giả: ghi lại ô nào được điền / chọn gì."""

    def __init__(self, templates, chi_dinh='Cắt u bã đậu vùng lưng'):
        super().__init__(None, {}, None, pause=lambda _s: None, templates=templates)
        self.values = {'txtBatDauPT': '', 'txtKetThucPT': ''}
        self.selected = {'cbbChiDinhMoPT': chi_dinh, 'cbbPhuongPhapPT': 'Cắt u', 'cbbICD9': '86.3',
                         'cbbIcdChanDoanTruocPT': 'L72.1 - U bã đậu', 'cbbChuanDoanSauPT': ''}
        self.clicked = []

    def open(self, href): pass
    def wait_for(self, element_id, seconds=12.0): return True
    def visible(self, element_id): return True

    def js(self, script, *args):
        if script == nt.SELECTED_TEXT_JS:
            return self.selected.get(args[0], '')
        if script == nt.VALUE_JS:
            return self.values.get(args[0], '')
        raise AssertionError(script)

    def set_value(self, element_id, value): self.values[element_id] = value

    def pick(self, field_id, text):
        self.selected[field_id] = text
        return True

    def click(self, element_id, what, pause=2.0):
        self.clicked.append(element_id)
        return []


def _pt_tpl(**kw):
    base = {'id': 'pt', 'kind': 'phau_thuat', 'name': 'Cắt u bã đậu', 'keywords': ['u bã đậu'], 'performer': 'bac_si',
            'minutes': 20, 'anesthesia': 'Gây Tê Tại Chỗ', 'position': 'Nằm sấp', 'mo_ta': 'Rạch da, bóc u',
            'report': 'Sát khuẩn\nRạch da\nBóc trọn u', 'dan_do': 'Thay băng mỗi ngày', 'applies_to': 'all',
            'auto': True, 'enabled': True}
    return {**base, **kw}


def test_finish_surgery_fills_form_from_matching_template():
    flow = SurgeryForm([_pt_tpl()])
    res = flow.finish_surgery({'href': 'x', 'noi_dung': ''}, DT(2026, 9, 28, 10, 5), 'BS Hồ Điền', NOW, 'ĐD Lan')
    assert res['result'] == 'done' and res['end'] == DT(2026, 9, 28, 10, 26)
    assert flow.values['txtBatDauPT'] == '10:06 28/09/2026' and flow.values['txtKetThucPT'] == '10:26 28/09/2026'
    assert flow.values['txtTuTheMoPT'] == 'Nằm sấp'
    assert flow.values['txtMoTaPPPT'] == 'Rạch da, bóc u'
    assert flow.values['trinhTuPhauThuatInput'] == 'Sát khuẩn\nRạch da\nBóc trọn u'
    assert flow.values['txtDanDoSauPT'] == 'Thay băng mỗi ngày'
    assert flow.selected['cbbBacSiPT'] == flow.selected['cbbBacSiGayMeChinh'] == 'BS Hồ Điền'
    assert flow.clicked == ['btnHOANTAT']

    # Mẫu giao cho điều dưỡng → người mổ chính là điều dưỡng trong lịch.
    flow = SurgeryForm([_pt_tpl(performer='dieu_duong', report='')])
    flow.finish_surgery({'href': 'x'}, DT(2026, 9, 28, 10, 5), 'BS Hồ Điền', NOW, 'ĐD Lan')
    assert flow.selected['cbbBacSiPT'] == 'ĐD Lan' and 'trinhTuPhauThuatInput' not in flow.values


def test_finish_surgery_without_template_does_not_touch_form():
    flow = SurgeryForm([_pt_tpl()], chi_dinh='Nối gân gấp')
    res = flow.finish_surgery({'href': 'x', 'noi_dung': 'Nối gân gấp'}, DT(2026, 9, 28, 10, 5), 'BS Hồ Điền', NOW)
    assert res['result'] == 'incomplete' and 'Chưa có mẫu phẫu thuật' in res['message']
    assert flow.values == {'txtBatDauPT': '', 'txtKetThucPT': ''} and flow.clicked == []


def test_run_all_waits_when_ordered_surgery_is_not_on_list_yet():
    lists = _lists()
    lists[nt.WPID_PHAUTHUAT] = '<table><thead><tr><th>Mã BN</th></tr></thead><tbody></tbody></table>'
    flow = FakeFlow(lists)
    flow.driver = type('D', (), {'page_source': ''})()
    flow.wait = None
    import input_procedures as ip
    original = ip._try_search_on_list
    ip._try_search_on_list = lambda *a, **k: None
    try:
        res = nt.run_all(flow, [{'ma_bn': '26059292', 'has_bhyt': False, 'pending_pt': 1}], 'Hồ Điền', lambda: NOW)
    finally:
        ip._try_search_on_list = original
    assert res['26059292']['result'] == 'waiting' and 'đóng tiền' in res['26059292']['message']
    assert not any(c[0] in {'pt', 'ra'} for c in flow.calls)   # không kết thúc điều trị khi chưa mổ
