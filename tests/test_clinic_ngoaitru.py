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

    def finish_surgery(self, row, admitted, doctor, now):
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
    assert cm.ngoaitru_candidate({'has_bhyt': False, 'case': 'ngoai_tru', 'stage': 'ngoai_tru'}) is False
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
