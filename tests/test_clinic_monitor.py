# -*- coding: utf-8 -*-
"""worker/clinic_monitor.py — theo dõi Danh sách Khám bệnh (chỉ đọc): phân loại
người bệnh theo xử trí/trạng thái và tự đăng nhập lại khi EMR hết phiên."""
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WORKER = os.path.join(ROOT, 'worker')
if WORKER not in sys.path:
    sys.path.insert(0, WORKER)

import clinic_monitor as cm  # noqa: E402

HEAD = ('<table class="table"><thead><tr><th></th><th>STT</th><th>SĐK</th><th>Mã BN</th><th>Họ tên</th>'
        '<th>Năm sinh</th><th>Đối tượng</th><th>Thời gian</th><th>Lý do đến khám</th><th>Trạng thái</th>'
        '<th>Kết quả dịch vụ</th><th>Xử trí</th><th>Nơi thực hiện</th><th>Ghi chú</th></tr></thead><tbody>')


def _row(kbid, stt, name_html, doi_tuong, trang_thai, dich_vu, xu_tri):
    return (f'<tr access_id="{kbid}"><td></td><td>{stt}</td><td>001</td><td><a href="home.aspx?khambenhid={kbid}">'
            f'9900000{stt}</a></td><td>{name_html}</td><td>1950</td><td>{doi_tuong}</td><td>08:00 20/09/2026</td>'
            f'<td>đau</td><td><span class="badge">{trang_thai}</span></td><td>{dich_vu}</td><td>{xu_tri}</td>'
            f'<td>PHÒNG KHÁM CHẤN THƯƠNG CHỈNH HÌNH - 20</td><td></td></tr>')


def _table(*rows, pages=1):
    return HEAD + ''.join(rows) + '</tbody></table>' + (f'<ul class="pagination"><li><a>Trang 1/{pages}</a></li></ul>')


BHYT = '<a>AB1234567890123<br></a><a style="color:red;">(Người già)</a>'
VIEN_PHI = '<a>Viện phí<br></a>'


def _classified(html):
    return {r['khambenhid']: r for r in cm.rows_from_html(html)}


def test_classify_cases_and_blockers():
    html = _table(
        _row('a', 1, '<a>NGUOI A</a>', BHYT, 'Đang thực hiện', '<a>CDHA: 1/1</a>', 'Cho về'),
        _row('b', 2, '<a>NGUOI B <br></a><a style="color:red;">(Chờ đọc KQ)</a>', BHYT, 'Đang làm dịch vụ',
             '<a>XN: 2/5</a> | <a>CDHA: 1/1</a>', ''),
        _row('c', 3, '<a>NGUOI C</a>', BHYT, 'Đang thực hiện', '<a>TT: 0/1</a>', 'Cho về'),
        _row('d', 4, '<a>NGUOI D</a>', BHYT, 'Đang thực hiện', '', 'Nhập viện'),
        _row('e', 5, '<a>NGUOI E</a>', BHYT, 'Đang thực hiện', '', 'Chuyển viện'),
        _row('f', 6, '<a>NGUOI F</a>', BHYT, 'Hoàn tất', '', 'Chuyển khám chuyên khoa'),
        _row('g', 7, '<a>NGUOI G</a>', VIEN_PHI, 'Chờ thực hiện', '', ''),
        _row('h', 8, '<a>NGUOI H</a>', BHYT, 'Điều trị ngoại trú', '', ''),
    )
    rows = _classified(html)

    assert rows['a']['case'] == 'cho_ve' and rows['a']['ready'] is True
    assert rows['a']['has_bhyt'] is True and rows['a']['doi_tuong'] == 'BHYT' and rows['a']['uu_tien'] == 'Người già'
    assert rows['a']['next_action'] == 'Hoàn tất khám'

    b = rows['b']
    assert b['ho_ten'] == 'NGUOI B' and b['cho_doc_kq'] is True
    assert b['stage'] == 'dang_lam_dv' and b['case'] == 'chua_xu_tri'
    # Chờ đọc KQ không còn là điều vướng: xử lý bằng cách xem đơn thuốc trên màn khám.
    assert b['blockers'] == ['XN chưa xong (2/5)', 'Chưa có xử trí']
    assert b['ready'] is False

    assert rows['c']['has_tt'] is True and rows['c']['blockers'] == ['TT chưa xong (0/1)']
    assert rows['c']['next_action'] == 'Hoàn tất thủ thuật rồi hoàn tất khám'
    assert rows['d']['case'] == 'nhap_vien' and rows['d']['next_action'] == 'Nhập chăm sóc'
    assert rows['e']['case'] == 'chuyen_vien' and rows['e']['next_action'] == 'Nhập BBHC'
    assert rows['f']['stage'] == 'xong' and rows['f']['ready'] is False and rows['f']['next_action'] == 'Đã xong'
    assert rows['g']['has_bhyt'] is False and rows['g']['doi_tuong'] == 'Viện phí'
    assert rows['g']['stage'] == 'cho_kham' and rows['g']['blockers'] == [] and rows['g']['next_action'] == 'Chờ khám'
    assert rows['h']['case'] == 'ngoai_tru'

    summary = cm.summarize(list(rows.values()))
    assert summary['total'] == 8 and summary['bhyt'] == 7 and summary['cho_doc_kq'] == 1
    assert summary['by_case']['cho_ve'] == 2 and 'chuyen_kham_ck' not in summary['by_case']


class FakeDriver:
    """Giả lập trang Danh sách Khám bệnh: execute_script trả lần lượt các kết quả cho sẵn."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.current_url = 'https://emr/home.aspx?wpid=khambenhdanhsachdraw'

    def execute_script(self, script, args):
        self.calls.append(args)
        return self.responses.pop(0)

    def quit(self):
        pass


def test_fetch_reads_all_pages_with_large_page_size():
    p1 = _table(_row('a', 1, '<a>A</a>', BHYT, 'Đang thực hiện', '', 'Cho về'), pages=2)
    p2 = _table(_row('b', 2, '<a>B</a>', BHYT, 'Đang thực hiện', '', 'Nhập viện'), pages=2)
    driver = FakeDriver([{'ok': True, 'html': p1}, {'ok': True, 'html': p2}])
    rows = cm.fetch_today_rows(driver)
    assert [r['khambenhid'] for r in rows] == ['a', 'b']
    assert [c['page'] for c in driver.calls] == [0, 1]
    assert all(c['pageSize'] == cm.PAGE_SIZE for c in driver.calls)


def test_monitor_relogins_when_emr_session_expires(monkeypatch):
    html = _table(_row('a', 1, '<a>A</a>', BHYT, 'Đang thực hiện', '', 'Cho về'))
    driver = FakeDriver([{'ok': False, 'reason': 'no_page'}, {'ok': True, 'html': html}])
    mon = cm.Monitor({}, 'https://emr/list', True)
    mon.driver = driver
    events = []

    def fake_open_list():
        events.append('open_list')
        driver.current_url = 'https://emr/login.aspx'  # hết phiên → bị đẩy về trang đăng nhập

    def fake_login():
        events.append('login')
        mon.login_count += 1
        driver.current_url = 'https://emr/home.aspx?wpid=khambenhdanhsachdraw'

    monkeypatch.setattr(mon, '_open_list', fake_open_list)
    monkeypatch.setattr(mon, '_login', fake_login)
    rows = mon.read()
    assert [r['khambenhid'] for r in rows] == ['a']
    assert events == ['open_list', 'login']
    assert mon.login_count == 1


def test_run_monitor_writes_state_deletes_request_and_stops(monkeypatch, tmp_path):
    req = tmp_path / 'req.json'
    state = tmp_path / 'state.json'
    control = tmp_path / 'control.json'
    req.write_text(json.dumps({'username': 'u', 'password': 'p', 'loginUrl': 'https://emr/login.aspx',
                               'listUrl': 'https://emr/list', 'intervalMinutes': 5}), encoding='utf-8')
    control.write_text(json.dumps({'stop': True}), encoding='utf-8')
    monkeypatch.setattr(cm, 'load_config', lambda: {})
    html = _table(_row('a', 1, '<a>A</a>', BHYT, 'Đang thực hiện', '', 'Cho về'))

    class FakeMonitor(cm.Monitor):
        def read(self):
            return cm.rows_from_html(html)

        def on_exam_page(self, row, action):
            return {'status': 'ready', 'message': 'Sẵn sàng hoàn tất'}

    monkeypatch.setattr(cm, 'Monitor', FakeMonitor)
    cm.run_monitor(str(req), str(state), str(control))

    assert not req.exists()
    data = json.loads(state.read_text(encoding='utf-8'))
    assert data['status'] == 'stopped'
    assert data['interval_minutes'] == 5
    assert [r['khambenhid'] for r in data['rows']] == ['a']
    assert data['summary']['ready'] == 1
    assert data['rows'][0]['eligible'] is True and data['rows'][0]['check']['status'] == 'ready'
    assert 'href' not in data['rows'][0]
    assert 'password' not in data and data['account'] == 'u'


# ── Điều kiện và thao tác hoàn tất khám ──────────────────────────────────────
from datetime import datetime as DT  # noqa: E402


def test_time_rules():
    start = DT(2026, 9, 28, 8, 0)
    assert cm.parse_emr_dt('08:05 28/09/2026') == DT(2026, 9, 28, 8, 5)
    assert cm.fmt_emr_dt(DT(2026, 9, 28, 8, 5)) == '08:05 28/09/2026'
    # Mốc sớm nhất = Ngày khám + 3 phút, hoặc giờ xong chỉ định + 1 phút nếu muộn hơn.
    assert cm.earliest_completion(start, None) == DT(2026, 9, 28, 8, 3)
    assert cm.earliest_completion(start, DT(2026, 9, 28, 8, 1)) == DT(2026, 9, 28, 8, 3)
    assert cm.earliest_completion(start, DT(2026, 9, 28, 9, 30)) == DT(2026, 9, 28, 9, 31)
    now = DT(2026, 9, 28, 10, 0)
    earliest = DT(2026, 9, 28, 9, 31)
    assert cm.exit_time_is_valid(DT(2026, 9, 28, 9, 45), earliest, now) is True
    assert cm.exit_time_is_valid(DT(2026, 9, 28, 9, 30), earliest, now) is False   # sớm hơn mốc
    assert cm.exit_time_is_valid(DT(2026, 9, 28, 10, 5), earliest, now) is False   # ở tương lai
    assert cm.exit_time_is_valid(None, earliest, now) is False
    html = '<td>08:10 28/09/2026</td><td>09:30 28/09/2026</td><td>hẹn 07:00 30/09/2026</td>'
    assert cm.latest_service_time(html, now) == DT(2026, 9, 28, 9, 30)  # bỏ mốc ở tương lai


def test_count_prescribed_drugs():
    html = ('<table id="tblThuoc"><tbody><tr><td>Nhóm</td></tr>'
            '<tr class="groupthuoc1 collapse in"><td>A</td></tr><tr class="groupthuoc1 collapse in"><td>B</td></tr>'
            '</tbody></table>')
    assert cm.count_prescribed_drugs(html) == 2
    assert cm.count_prescribed_drugs('<table id="tblThuoc"><tbody><tr><td>x</td></tr></tbody></table>') == 0


class FakePage:
    """Màn khám giả: ghi lại mọi thao tác ghi. Hoàn tất bị EMR chặn khi chưa có cân nặng."""

    def __init__(self, *, enter=False, drugs=1, start='08:00 28/09/2026', weight=60.0, exit_time=None, finish_error=None):
        self.enter, self.drugs, self.start = enter, drugs, cm.parse_emr_dt(start)
        self.weight, self.exit_time, self.finish_error = weight, exit_time, finish_error
        self.writes = []

    def needs_enter(self): return self.enter
    def drug_count(self): return self.drugs
    def exam_start(self): return self.start
    def read_exit_time(self): return self.exit_time
    def enter_exam(self): self.writes.append('vao_kham'); self.enter = False
    def save_weight(self, kg): self.writes.append(('can_nang', kg)); self.weight = kg
    def save_exit_time(self, v): self.writes.append(('thoi_gian_ra', cm.fmt_emr_dt(v))); self.exit_time = v

    def finish(self):
        if self.finish_error:
            raise cm.ExamStepError(self.finish_error)
        if not self.weight:
            raise cm.ExamStepError('Hoàn tất khám: THÔNG BÁO: Chưa nhập cân nặng')
        self.writes.append('hoan_tat')
        return ['Cập nhập trạng thái thành công!']


NOW = DT(2026, 9, 28, 10, 0)


def test_check_patient_is_read_only():
    row = {'cho_doc_kq': True}
    page = FakePage(enter=True, drugs=0)
    assert cm.check_patient(page, row, None, NOW)['status'] == 'no_drug'
    page = FakePage(start='09:58 28/09/2026')
    res = cm.check_patient(page, {}, None, NOW)
    assert res['status'] == 'waiting' and '10:01' in res['message']
    page = FakePage(enter=True, drugs=2, weight=0)
    assert cm.check_patient(page, row, DT(2026, 9, 28, 9, 0), NOW)['status'] == 'ready'  # không đọc cân nặng trước
    assert page.writes == []


def test_complete_patient_flow():
    # Chờ đọc KQ có thuốc: vào khám → sửa thời gian ra về giờ hiện tại → hoàn tất.
    page = FakePage(enter=True, drugs=3, exit_time=cm.parse_emr_dt('08:01 28/09/2026'))
    res = cm.complete_patient(page, {'cho_doc_kq': True}, DT(2026, 9, 28, 9, 0), NOW, None)
    assert res['result'] == 'done'
    assert page.writes == ['vao_kham', ('thoi_gian_ra', '10:00 28/09/2026'), 'hoan_tat']

    # Thời gian ra đã hợp lệ → giữ nguyên, không sửa.
    page = FakePage(exit_time=cm.parse_emr_dt('09:40 28/09/2026'))
    assert cm.complete_patient(page, {}, DT(2026, 9, 28, 9, 0), NOW, None)['result'] == 'done'
    assert page.writes == ['hoan_tat']


def test_weight_only_entered_after_emr_warning():
    # EMR báo thiếu cân nặng, người dùng đã nhập 52 kg → ghi cân nặng rồi hoàn tất lại.
    page = FakePage(weight=0, exit_time=cm.parse_emr_dt('09:40 28/09/2026'))
    res = cm.complete_patient(page, {}, None, NOW, 52)
    assert res['result'] == 'done' and page.writes == [('can_nang', 52), 'hoan_tat']

    # Chưa nhập cân nặng → dừng, báo nguyên văn cảnh báo của EMR, không tự điền.
    page = FakePage(weight=0, exit_time=cm.parse_emr_dt('09:40 28/09/2026'))
    res = cm.complete_patient(page, {}, None, NOW, None)
    assert res['result'] == 'need_weight' and 'Chưa nhập cân nặng' in res['message']
    assert page.writes == []

    # Lỗi khác của EMR không bị coi là thiếu cân nặng.
    page = FakePage(finish_error='Hoàn tất khám: THÔNG BÁO: Vui lòng nhập bệnh chính.', exit_time=cm.parse_emr_dt('09:40 28/09/2026'))
    try:
        cm.complete_patient(page, {}, None, NOW, 52)
        raised = False
    except cm.ExamStepError:
        raised = True
    assert raised and ('can_nang', 52) not in page.writes


def test_complete_patient_stops_before_any_click():
    page = FakePage(enter=True, drugs=0)
    assert cm.complete_patient(page, {'cho_doc_kq': True}, None, NOW, None)['result'] == 'no_drug'
    assert page.writes == []  # không bấm Vào khám khi chưa có thuốc

    page = FakePage(start='09:58 28/09/2026')
    assert cm.complete_patient(page, {}, None, NOW, None)['result'] == 'waiting'
    assert page.writes == []


def test_need_weight_status_is_kept_until_user_acts():
    assert cm._need_check({'status': 'need_weight', 'at': '2026-09-28T08:00:00'}, NOW) is False
    assert cm._need_check({'status': 'ready', 'at': '2026-09-28T09:50:00'}, NOW) is True


class DialogDriver:
    def __init__(self, dialogs):
        self.info = {'dialogs': dialogs, 'toasts': [], 'xutriError': ''}
        self.closed = False

    def execute_script(self, script, *args):
        if script == cm.READ_DIALOGS_JS:
            return self.info
        if script == cm.CLOSE_DIALOGS_JS:
            self.closed = True
        return None


def test_confirm_dialog_is_never_accepted():
    drv = DialogDriver([{'title': 'Bạn có muốn tiếp tục thực hiện không?', 'text': 'Vượt trần BHYT', 'confirm': True}])
    page = cm.ExamPage(drv, pause=lambda s: None)
    try:
        page.check_dialogs('Hoàn tất khám')
        raised = ''
    except cm.ExamStepError as e:
        raised = str(e)
    assert drv.closed is True
    assert 'chưa tự đồng ý' in raised and 'Vượt trần BHYT' in raised
    # Hộp nút đóng chỉ bấm "cancel" khi có — xem CLOSE_DIALOGS_JS.
    assert "c.click()" in cm.CLOSE_DIALOGS_JS.split('else')[0]
