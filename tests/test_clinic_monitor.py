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
    assert b['blockers'] == ['XN chưa xong (2/5)', 'Chờ đọc kết quả', 'Chưa có xử trí']
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

    monkeypatch.setattr(cm, 'Monitor', FakeMonitor)
    cm.run_monitor(str(req), str(state), str(control))

    assert not req.exists()
    data = json.loads(state.read_text(encoding='utf-8'))
    assert data['status'] == 'stopped'
    assert data['interval_minutes'] == 5
    assert [r['khambenhid'] for r in data['rows']] == ['a']
    assert data['summary']['ready'] == 1
    assert 'password' not in data and data['account'] == 'u'
