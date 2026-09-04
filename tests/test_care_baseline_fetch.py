# -*- coding: utf-8 -*-
from worker.care_baseline_fetch import (
    collect_named_patient_candidates_by_search,
    _inpatient_search_url_variants,
    _search_attempt_count,
    resolve_status_candidates,
    collect_patient_candidates_from_html,
    effective_account_config,
    extract_logged_in_department_from_html,
    parse_care_info_rows_from_html,
)


def test_parse_care_info_table_core_columns_and_date_window():
    html = '''
    <table class="footable table table-striped table-bordered">
      <thead><tr>
        <th>Tác vụ</th><th>TT</th><th>Thời gian</th><th>Người lập</th>
        <th>N.T</th><th>T.</th><th>M</th><th>H.A</th><th>C.N</th><th>Diễn biến</th><th>Chăm sóc</th>
      </tr></thead>
      <tbody>
        <tr style="color:#337ab7;font-weight:bold"><td colspan="10">Khoa điều trị thứ 1 : Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh (Ngày vào: 12:02 15/06/2026)</td></tr>
        <tr>
          <td>Sao Sửa</td><td>Hoàn tất</td><td><a>05:00 16/06/2026</a></td><td>Nguyễn Kim Ngân</td>
          <td>22</td><td>37</td><td>86</td><td>120/70</td><td></td><td>Người bệnh tỉnh</td><td>Lấy DHST</td>
        </tr>
        <tr>
          <td>Sao Sửa</td><td>Hoàn tất</td><td><a>12:50 15/06/2026</a></td><td>Nguyễn Kim Ngân</td>
          <td>22</td><td>37</td><td>85</td><td>120/60</td><td></td><td>Ngoại CTCH nhận</td><td>Nhận HS</td>
        </tr>
      </tbody>
    </table>
    '''
    rows = parse_care_info_rows_from_html(
        html,
        care_from="2026-06-15",
        care_to="2026-06-16",
        patient={"ma_bn": "99000001", "ho_ten": "BN TEST", "khoa": "Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh"},
    )
    assert len(rows) == 2
    assert rows[0]["Thời gian"] == "05:00 16/06/2026"
    assert rows[0]["Người lập"] == "Nguyễn Kim Ngân"
    assert rows[0]["Diễn biến"] == "Người bệnh tỉnh"
    assert rows[0]["Chăm sóc"] == "Lấy DHST"
    assert rows[0]["Khoa"] == "Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh"
    assert rows[0]["Khoa điều trị"].startswith("Khoa điều trị thứ 1")
    assert rows[0]["Mã BN"] == "99000001"
    assert rows[0]["Họ tên người bệnh"] == "BN TEST"



def test_parse_care_info_only_keeps_logged_in_department_section():
    html = '''
    <table class="footable table table-striped table-bordered">
      <thead><tr>
        <th>Tác vụ</th><th>TT</th><th>Thời gian</th><th>Người lập</th>
        <th>N.T</th><th>T.</th><th>M</th><th>H.A</th><th>C.N</th><th>Diễn biến</th><th>Chăm sóc</th>
      </tr></thead>
      <tbody>
        <tr style="color:#337ab7;font-weight:bold"><td colspan="10">Khoa điều trị thứ 2 : Khoa Gây Mê Hồi Sức (Ngày vào: 23:07 13/06/2026 - Chẩn đoán: Chuyển dạ nhanh)</td></tr>
        <tr><td>Sao Sửa</td><td>Hoàn tất</td><td>07:00 14/06/2026</td><td>Huỳnh Thị Mỹ Hà</td><td></td><td></td><td>88</td><td>120/70</td><td></td><td>Hậu phẫu</td><td>CS cấp 2</td></tr>
        <tr style="color:#337ab7;font-weight:bold"><td colspan="10">Khoa điều trị thứ 1 : Khoa Phụ Sản (Ngày vào: 14:21 13/06/2026 - Chẩn đoán: Chuyển dạ nhanh)</td></tr>
        <tr><td>Sao Sửa</td><td>Hoàn tất</td><td>21:15 13/06/2026</td><td>Mai Thị Kim Quyên</td><td>20</td><td>37</td><td>81</td><td>120/80</td><td></td><td>Bệnh tỉnh</td><td>Nghe tim thai</td></tr>
        <tr><td>Sao Sửa</td><td>Hoàn tất</td><td>14:25 13/06/2026</td><td>Mai Thị Kim Quyên</td><td></td><td></td><td></td><td></td><td></td><td>Khoa sản nhận</td><td>Lấy sinh hiệu</td></tr>
      </tbody>
    </table>
    '''
    rows = parse_care_info_rows_from_html(
        html,
        care_from="2026-06-13",
        care_to="2026-06-14",
        patient={"khoa": "Khoa Phụ Sản", "ma_bn": "99000002", "ho_ten": "BN PHỤ SẢN"},
    )
    assert len(rows) == 2
    assert all("Khoa Phụ Sản" in r["Khoa điều trị"] for r in rows)
    assert [r["Diễn biến"] for r in rows] == ["Bệnh tỉnh", "Khoa sản nhận"]


def test_parse_care_info_department_match_accepts_missing_khoa_prefix():
    html = '''
    <table><thead><tr><th>Tác vụ</th><th>TT</th><th>Thời gian</th><th>Người lập</th><th>N.T</th><th>T.</th><th>M</th><th>H.A</th><th>C.N</th><th>Diễn biến</th><th>Chăm sóc</th></tr></thead>
    <tbody>
      <tr><td colspan="10">Khoa điều trị thứ 1 : Khoa Mắt - Tai mũi họng (Ngày vào: 01/06/2026)</td></tr>
      <tr><td></td><td></td><td>05:00 02/06/2026</td><td>A</td><td></td><td></td><td></td><td></td><td></td><td>B</td><td>C</td></tr>
    </tbody></table>
    '''
    rows = parse_care_info_rows_from_html(html, patient={"khoa": "Mắt - Tai mũi họng"})
    assert len(rows) == 1
    assert rows[0]["Diễn biến"] == "B"

def test_parse_care_info_table_filters_outside_date_window():
    html = '''
    <table><thead><tr><th>Tác vụ</th><th>TT</th><th>Thời gian</th><th>Người lập</th><th>N.T</th><th>T.</th><th>M</th><th>H.A</th><th>C.N</th><th>Diễn biến</th><th>Chăm sóc</th></tr></thead>
    <tbody><tr><td></td><td></td><td>05:00 17/06/2026</td><td>A</td><td></td><td></td><td></td><td></td><td></td><td>B</td><td>C</td></tr></tbody></table>
    '''
    rows = parse_care_info_rows_from_html(html, care_from="2026-06-08", care_to="2026-06-12")
    assert rows == []


def test_collect_patient_candidates_prioritizes_admission_window():
    html = '''
    <table id="tblNoiTru"><tbody>
      <tr><td>99011111</td><td><a id="btna1" href="home.aspx?wpid=bacsidraw">Nguyễn Văn Ngoài</a></td><td>Ngày vào: 01/06/2026</td><td><a href="home.aspx?wpid=dieuduongdraw"><i class="fa fa-eye"></i></a></td></tr>
      <tr><td>99022222</td><td><a id="btna2" href="home.aspx?wpid=bacsidraw">Người Bệnh A</a></td><td>Ngày vào: 10/06/2026</td><td><a href="home.aspx?wpid=dieuduongdraw"><i class="fa fa-eye"></i></a></td></tr>
    </tbody></table>
    '''
    rows = collect_patient_candidates_from_html(html, admission_from="2026-06-08", admission_to="2026-06-19", limit=2)
    assert [r["ma_bn"] for r in rows] == ["99022222", "99011111"]
    assert rows[0]["ho_ten"] == "Người Bệnh A"
    assert rows[0]["href_nursing"]


def test_extract_logged_in_department_from_header_span():
    html = '''
    <div class="profile-element">
      <span class="text-muted text-xs block">Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh <b class="caret"></b></span>
    </div>
    '''
    assert extract_logged_in_department_from_html(html) == "Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh"


def test_effective_account_config_uses_department_hint_until_login_detects_real_department():
    cfg = effective_account_config(
        {"url_login": "http://x/login.aspx"},
        {"url_inpatient_list": "http://x/home.aspx"},
        {"id": "account_orthopedics", "username": "account_orthopedics", "password": "p", "department_hint": "Ngoại Chấn thương chỉnh hình"},
    )
    assert cfg["account_id"] == "account_orthopedics"
    assert cfg["department_hint"] == "Ngoại Chấn thương chỉnh hình"
    assert cfg["department"] == "Ngoại Chấn thương chỉnh hình"


def test_collect_patient_candidates_filters_tim_mach_room_tmct_and_keeps_priority():
    html = '''
    <table id="tblNoiTru"><tbody>
      <tr><td>1</td><td>07:00 10/06/2026</td><td><a href="home.aspx?wpid=dieuduongdraw"><i class="fa fa-eye"></i></a></td><td>Phòng bệnh khoa CTCH - 01</td><td>99011111</td><td>BN NGOAI</td></tr>
      <tr><td>2</td><td>22:49 09/06/2026</td><td><a href="home.aspx?wpid=dieuduongdraw"><i class="fa fa-eye"></i></a></td><td>Phòng bệnh khoa TMCT - 05 / K04.05.02.H023</td><td>99063117</td><td>NGƯỜI BỆNH B</td></tr>
      <tr><td>3</td><td>10:58 08/06/2026</td><td><a href="home.aspx?wpid=dieuduongdraw"><i class="fa fa-eye"></i></a></td><td>Phòng bệnh khoa TMCT - 08 / K04.08.02.H033</td><td>99062731</td><td>NGƯỜI BỆNH C</td></tr>
      <tr><td>4</td><td>10:00 01/06/2026</td><td><a href="home.aspx?wpid=dieuduongdraw"><i class="fa fa-eye"></i></a></td><td>Phòng bệnh khoa TMCT - 01</td><td>99050000</td><td>BN NGOÀI NGÀY</td></tr>
    </tbody></table>
    '''
    rows = collect_patient_candidates_from_html(
        html,
        admission_from="2026-06-08",
        admission_to="2026-06-19",
        limit=5,
        patient_room_keywords=["TMCT"],
    )
    assert [r["ma_bn"] for r in rows] == ["99063117", "99062731", "99050000"]
    assert all("TMCT" in r["khoa"] for r in rows)
    assert "99011111" not in [r["ma_bn"] for r in rows]


def test_effective_account_config_keeps_patient_room_keywords_for_tim_mach():
    cfg = effective_account_config(
        {"url_login": "http://x/login.aspx"},
        {"patient_room_keywords": []},
        {"id": "account_cardiology", "username": "account_cardiology", "password": "p", "department_hint": "Tim mạch can thiệp", "patient_room_keywords": ["TMCT"]},
    )
    assert cfg["patient_room_keywords"] == ["TMCT"]


def test_collect_patient_candidates_uses_target_names_and_ignores_admission_date():
    html = '''
    <table id="tblNoiTru"><tbody>
      <tr><td>1</td><td>09:00 10/06/2026</td><td><a href="home.aspx?wpid=dieuduongdraw"><i class="fa fa-eye"></i></a></td><td>Phòng bệnh khoa Ngoại TH</td><td>99010001</td><td>BN KHÔNG CHỌN</td></tr>
      <tr><td>2</td><td>08:00 01/06/2026</td><td><a href="home.aspx?wpid=dieuduongdraw"><i class="fa fa-eye"></i></a></td><td>Phòng bệnh khoa Ngoại TH</td><td>99010002</td><td>Người Bệnh D</td></tr>
      <tr><td>3</td><td>08:00 02/06/2026</td><td><a href="home.aspx?wpid=dieuduongdraw"><i class="fa fa-eye"></i></a></td><td>Phòng bệnh khoa Ngoại TH</td><td>99010003</td><td>Người Bệnh E</td></tr>
      <tr><td>4</td><td>08:00 03/06/2026</td><td><a href="home.aspx?wpid=dieuduongdraw"><i class="fa fa-eye"></i></a></td><td>Phòng bệnh khoa Ngoại TH</td><td>99010004</td><td>Người Bệnh F</td></tr>
    </tbody></table>
    '''
    rows = collect_patient_candidates_from_html(
        html,
        admission_from="2026-06-08",
        admission_to="2026-06-19",
        limit=5,
        target_patient_names=["Người Bệnh E", "Người Bệnh F", "Người Bệnh D"],
    )
    assert [r["ho_ten"] for r in rows] == ["Người Bệnh E", "Người Bệnh F", "Người Bệnh D"]
    assert "BN KHÔNG CHỌN" not in [r["ho_ten"] for r in rows]


def test_collect_patient_candidates_combines_room_filter_and_target_names_for_tmct():
    html = '''
    <table id="tblNoiTru"><tbody>
      <tr><td>1</td><td>10/06/2026</td><td><a href="home.aspx?wpid=dieuduongdraw"><i class="fa fa-eye"></i></a></td><td>Phòng bệnh khoa Nội TH</td><td>99063300</td><td>NGƯỜI BỆNH G</td></tr>
      <tr><td>2</td><td>09/06/2026</td><td><a href="home.aspx?wpid=dieuduongdraw"><i class="fa fa-eye"></i></a></td><td>Phòng bệnh khoa TMCT - 05</td><td>99063117</td><td>NGƯỜI BỆNH B</td></tr>
      <tr><td>3</td><td>09/06/2026</td><td><a href="home.aspx?wpid=dieuduongdraw"><i class="fa fa-eye"></i></a></td><td>Phòng bệnh khoa TMCT - 03</td><td>99059640</td><td>NGƯỜI BỆNH H</td></tr>
    </tbody></table>
    '''
    rows = collect_patient_candidates_from_html(
        html,
        limit=5,
        patient_room_keywords=["TMCT"],
        target_patient_names=["Người Bệnh G", "Người Bệnh B", "Người Bệnh H"],
    )
    assert [r["ho_ten"] for r in rows] == ["NGƯỜI BỆNH B", "NGƯỜI BỆNH H"]
    assert all("TMCT" in r["khoa"] for r in rows)


def test_effective_account_config_keeps_target_patient_names():
    cfg = effective_account_config(
        {"url_login": "http://x/login.aspx"},
        {},
        {"id": "account_general_surgery", "username": "account_general_surgery", "password": "p", "target_patient_names": ["Người Bệnh E", "Người Bệnh F"]},
    )
    assert cfg["target_patient_names"] == ["Người Bệnh E", "Người Bệnh F"]


def test_default_admission_window_is_about_three_months():
    from datetime import date
    from worker.care_baseline_fetch import _default_admission_window, _parse_date_any

    start, end = _default_admission_window(90)
    ds = _parse_date_any(start)
    de = _parse_date_any(end)
    assert ds is not None and de is not None
    assert 89 <= (de - ds).days <= 90
    assert de == date.today()


def test_effective_account_config_defaults_completed_status_and_three_month_window_hint():
    cfg = effective_account_config(
        {"url_login": "http://x/login.aspx"},
        {"status": "Hoàn tất", "admission_months_back": 3},
        {"id": "account_internal_medicine", "username": "account_internal_medicine", "password": "p"},
    )
    assert cfg["status"] == "Hoàn tất"
    assert cfg["admission_months_back"] == 3


def test_effective_account_config_uses_patient_names_in_same_account_by_department():
    cfg = effective_account_config(
        {"url_login": "http://x/login.aspx"},
        {"status": "Hoàn tất"},
        {
            "id": "account_general_surgery",
            "username": "account_general_surgery",
            "password": "p",
            "department_hint": "Ngoại tổng hợp",
            "patient_names": [
                "Người Bệnh E",
                "Người Bệnh F",
                "Người Bệnh I",
                "Người Bệnh D",
                "Người Bệnh J",
            ],
        },
    )
    assert cfg["account_id"] == "account_general_surgery"
    assert cfg["department_hint"] == "Ngoại tổng hợp"
    assert cfg["target_patient_names"] == [
        "Người Bệnh E",
        "Người Bệnh F",
        "Người Bệnh I",
        "Người Bệnh D",
        "Người Bệnh J",
    ]


def test_effective_account_config_accepts_patients_objects_alias():
    cfg = effective_account_config(
        {"url_login": "http://x/login.aspx"},
        {},
        {
            "id": "account_internal_medicine",
            "username": "account_internal_medicine",
            "password": "p",
            "department_hint": "Nội Tổng hợp",
            "patients": [
                {"name": "Người Bệnh K"},
                {"ho_ten": "Người Bệnh L"},
            ],
        },
    )
    assert cfg["target_patient_names"] == ["Người Bệnh K", "Người Bệnh L"]


def test_effective_account_config_auto_select_when_no_patient_names():
    cfg = effective_account_config(
        {"url_login": "http://x/login.aspx"},
        {"status": "Hoàn tất", "patient_limit_per_account": 5},
        {"id": "account_oncology", "username": "account_oncology", "password": "p", "department_hint": "Ung bướu"},
    )
    assert cfg["target_patient_names"] == []
    assert cfg["patient_selection_mode"] == "auto"


def test_effective_account_config_empty_patient_names_auto_select():
    cfg = effective_account_config(
        {"url_login": "http://x/login.aspx"},
        {},
        {"id": "account_urology", "username": "account_urology", "password": "p", "department_hint": "Trung tâm tiết niệu", "patient_names": []},
    )
    assert cfg["target_patient_names"] == []
    assert cfg["patient_selection_mode"] == "auto"


def test_collect_patient_candidates_auto_selects_limit_when_no_names():
    html = '''
    <table id="tblNoiTru"><tbody>
      <tr><td>1</td><td>10/06/2026</td><td><a href="home.aspx?wpid=dieuduongdraw"><i class="fa fa-eye"></i></a></td><td>Phòng bệnh khoa Ung Bướu</td><td>99000001</td><td>BN Một</td></tr>
      <tr><td>2</td><td>09/06/2026</td><td><a href="home.aspx?wpid=dieuduongdraw"><i class="fa fa-eye"></i></a></td><td>Phòng bệnh khoa Ung Bướu</td><td>99000002</td><td>BN Hai</td></tr>
      <tr><td>3</td><td>08/06/2026</td><td><a href="home.aspx?wpid=dieuduongdraw"><i class="fa fa-eye"></i></a></td><td>Phòng bệnh khoa Ung Bướu</td><td>99000003</td><td>BN Ba</td></tr>
    </tbody></table>
    '''
    rows = collect_patient_candidates_from_html(html, admission_from="2026-06-08", admission_to="2026-06-19", limit=2)
    assert [r["ma_bn"] for r in rows] == ["99000001", "99000002"]


def test_absolute_url_resolves_relative_nursing_href():
    from worker.care_baseline_fetch import _absolute_url
    assert _absolute_url(
        "http://emr.internal.example/home.aspx?scope=sys",
        "home.aspx?wpid=dieuduongdraw&noitruid=abc",
    ) == "http://emr.internal.example/home.aspx?wpid=dieuduongdraw&noitruid=abc"


def test_named_selection_can_parse_search_result_outside_current_page():
    html = '''
    <table id="tblNoiTru"><tbody>
      <tr><td>1</td><td>01/04/2026</td><td><a href="home.aspx?wpid=dieuduongdraw&noitruid=1"><i class="fa fa-eye"></i></a></td><td>Phòng bệnh khoa Nội TH</td><td>99090001</td><td>Người Bệnh K</td></tr>
      <tr><td>2</td><td>01/04/2026</td><td><a href="home.aspx?wpid=dieuduongdraw&noitruid=2"><i class="fa fa-eye"></i></a></td><td>Phòng bệnh khoa Nội TH</td><td>99090002</td><td>BN KHÁC</td></tr>
    </tbody></table>
    '''
    rows = collect_patient_candidates_from_html(
        html,
        admission_from="2026-06-01",
        admission_to="2026-06-12",
        limit=5,
        target_patient_names=["Người Bệnh K"],
    )
    assert len(rows) == 1
    assert rows[0]["ho_ten"] == "Người Bệnh K"


def test_resolve_headless_cli_false_overrides_account_default_true():
    from argparse import Namespace
    from worker.care_baseline_fetch import resolve_headless
    assert resolve_headless(Namespace(headless=False), {"headless": True}) is False


def test_resolve_headless_cli_true_overrides_account_false():
    from argparse import Namespace
    from worker.care_baseline_fetch import resolve_headless
    assert resolve_headless(Namespace(headless=True), {"headless": False}) is True


def test_resolve_headless_uses_account_when_cli_not_set():
    from argparse import Namespace
    from worker.care_baseline_fetch import resolve_headless
    assert resolve_headless(Namespace(headless=None), {"headless": "false"}) is False
    assert resolve_headless(Namespace(headless=None), {}) is True


def test_inpatient_search_url_variants_include_keyword_aliases():
    urls = _inpatient_search_url_variants(
        "http://x/home.aspx?wpid=danhsachdieutrinoitrudraw&tt=4",
        "Nhân Viên A",
    )
    assert any("keyword=" in u for u in urls)
    assert any("txtTimKiem=" in u for u in urls)
    assert all("wpid=danhsachdieutrinoitrudraw" in u for u in urls)


def test_resolve_status_candidates_both_statuses():
    assert resolve_status_candidates("Đang thực hiện hoặc Hoàn tất") == ["Đang thực hiện", "Hoàn tất"]
    assert resolve_status_candidates("Hoàn tất") == ["Hoàn tất"]
    assert resolve_status_candidates("Đang thực hiện") == ["Đang thực hiện"]


def test_search_attempt_count_defaults_to_three_and_caps():
    assert _search_attempt_count({}) == 3
    assert _search_attempt_count({"search_attempts": 1}) == 1
    assert _search_attempt_count({"search_attempts": 99}) == 10
    assert _search_attempt_count({"patient_search_attempts": "3"}) == 3


def test_named_search_does_not_spam_url_aliases(monkeypatch):
    import worker.care_baseline_fetch as mod

    class FakeDriver:
        current_url = "http://x/home.aspx?wpid=danhsachdieutrinoitrudraw"
        page_source = "<table><tbody></tbody></table>"
        def get(self, url):
            self.current_url = url

    driver = FakeDriver()
    submits = []
    statuses = []
    monkeypatch.setattr(mod, "wait_after_action", lambda *a, **k: None)
    monkeypatch.setattr(mod, "set_inpatient_status_filter", lambda d, w, status, log_func=None: statuses.append(status))
    monkeypatch.setattr(mod, "_submit_inpatient_search", lambda d, w, term, log_func=None: submits.append(term) or True)
    monkeypatch.setattr(mod, "_inpatient_search_url_variants", lambda *a, **k: (_ for _ in ()).throw(AssertionError("không được thử nhiều alias URL")))

    rows = collect_named_patient_candidates_by_search(
        driver,
        None,
        "http://x/home.aspx?wpid=danhsachdieutrinoitrudraw",
        {
            "target_patient_names": ["Lê Xuân Soang"],
            "patient_limit_per_account": 5,
            "patient_search_attempts": 3,
        },
        "Đang thực hiện hoặc Hoàn tất",
        log_func=lambda msg: None,
    )
    assert rows == []
    assert statuses[:2] == ["Đang thực hiện", "Hoàn tất"]
    assert submits == ["Lê Xuân Soang", "Lê Xuân Soang"]  # mỗi trạng thái tìm đúng 1 lần


def test_parse_real_inpatient_row_uses_name_column_and_nursing_eye_href():
    html = '<div class="table-responsive" style="width:100%; height:800px;"> \n             <table class="table table-striped table-bordered sticky" id="tblNoiTru"> \n                 <thead> \n                 <tr> \n                       <th style="text-align: center; min-width:40px;">STT</th> \n                       <th style="text-align: center; min-width:80px;">T/G vào</th> \n                       <th style="text-align: center; width:40px">ĐD</th> \n                       <th style="text-align: center; width:60px">KQ</th> \n                       <th style="text-align: center;min-width:120px;">B-G</th> \n                       <th style="text-align: center; min-width:50px">Mã BN</th> \n                       <th style="text-align: center; min-width:160px;">Họ tên</th> \n                       <th style="text-align: center; min-width:45px">Tuổi</th> \n                       <th style="text-align: center; width:40px;">GT</th> \n                       <th style="text-align: center; min-width:95px;">Đối tượng</th> \n                       <th style="text-align: center; min-width:95px;">ĐT chi tiết</th> \n                       <th style="text-align: center; min-width:80px; ">Tạm ứng</th> \n                       <th style="text-align: center; min-width:85px; ">Phải trả </th> \n                       <th style="text-align: center; min-width:120px">Trạng thái</th> \n                       <th style="text-align: center; min-width:110px; ">Bác sĩ</th> \n                       <th style="text-align: center; min-width:180px; ">Chẩn đoán</th> \n                       <th style="text-align: center; min-width:140px">Khoa chuyển đến</th> \n                       <th style="text-align: center; min-width:120px">Xử trí</th> \n                   </tr> \n                 </thead> \n                 <tbody> \n<tr> \n    <td style="text-align: center"><a href="home.aspx?scope=sys&amp;lang=vi&amp;wpid=bacsidraw&amp;noitruid=4c95b5a1-1570-49ae-a376-b46600f1a003&amp;keyword=lê xuân soang&amp;kp=9ce1fb77-8e97-423a-9635-b35b014e3d1b&amp;tt=4&amp;tg=6&amp;tungay=01/03/2026&amp;denngay=16/06/2026&amp;wpre=danhsachdieutrinoitrudraw&amp;nextlink=lichsuylenh&amp;usid=172.31.255.1_j3za2h5kz231vts2rptoktgicd4b5b52&amp;st=172713" target="">1</a></td> \n    <td style="text-align: center"><a href="home.aspx?scope=sys&amp;lang=vi&amp;wpid=bacsidraw&amp;noitruid=4c95b5a1-1570-49ae-a376-b46600f1a003&amp;keyword=lê xuân soang&amp;kp=9ce1fb77-8e97-423a-9635-b35b014e3d1b&amp;tt=4&amp;tg=6&amp;tungay=01/03/2026&amp;denngay=16/06/2026&amp;wpre=danhsachdieutrinoitrudraw&amp;nextlink=lichsuylenh&amp;usid=172.31.255.1_j3za2h5kz231vts2rptoktgicd4b5b52&amp;st=172713" target="">15:03 11/06/2026</a></td> \n    <td style="text-align: center"><a href="home.aspx?scope=sys&amp;lang=vi&amp;wpid=dieuduongdraw&amp;noitruid=4c95b5a1-1570-49ae-a376-b46600f1a003&amp;keyword=lê xuân soang&amp;kp=9ce1fb77-8e97-423a-9635-b35b014e3d1b&amp;tt=4&amp;tg=6&amp;tungay=01/03/2026&amp;denngay=16/06/2026&amp;wpre=danhsachdieutrinoitrudraw&amp;usid=172.31.255.1_j3za2h5kz231vts2rptoktgicd4b5b52&amp;st=172713" target="" class="btn btn-xs btn-outline btn-primary"><i class="far fa-eye"></i></a></td> \n    <td style="text-align: center"><a onclick="onShowLichSuChung(\'1687f6a9-4f96-4c80-a258-b46600ee433e\', \'4c95b5a1-1570-49ae-a376-b46600f1a003\');" target="" class="btn btn-xs btn-primary">Xem KQ</a></td> \n    <td><a href="home.aspx?scope=sys&amp;lang=vi&amp;wpid=bacsidraw&amp;noitruid=4c95b5a1-1570-49ae-a376-b46600f1a003&amp;keyword=lê xuân soang&amp;kp=9ce1fb77-8e97-423a-9635-b35b014e3d1b&amp;tt=4&amp;tg=6&amp;tungay=01/03/2026&amp;denngay=16/06/2026&amp;wpre=danhsachdieutrinoitrudraw&amp;nextlink=lichsuylenh&amp;usid=172.31.255.1_j3za2h5kz231vts2rptoktgicd4b5b52&amp;st=172713" target="">-</a></td> \n    <td style="text-align: center"><a href="home.aspx?scope=sys&amp;lang=vi&amp;wpid=bacsidraw&amp;noitruid=4c95b5a1-1570-49ae-a376-b46600f1a003&amp;keyword=lê xuân soang&amp;kp=9ce1fb77-8e97-423a-9635-b35b014e3d1b&amp;tt=4&amp;tg=6&amp;tungay=01/03/2026&amp;denngay=16/06/2026&amp;wpre=danhsachdieutrinoitrudraw&amp;nextlink=lichsuylenh&amp;usid=172.31.255.1_j3za2h5kz231vts2rptoktgicd4b5b52&amp;st=172713" target="">99063850</a></td> \n    <td style="text-align: left">       <div class="btn-group">\n           <button type="button" style="display: none" class="btn btn-danger dropdown-toggle" id="txt4c95b5a1-1570-49ae-a376-b46600f1a003" data-toggle="dropdown"></button>\n           <ul class="dropdown-menu" role="menu">\n               <li style="text-align:center;">\n                   <span style="width:175px;padding:5px 0;font-size: 15px;" class="btn btn-xs btn-outline btn-danger" onclick="onBuidUrl(\'4c95b5a1-1570-49ae-a376-b46600f1a003\',\'Lê Xuân Soang\',\'9ce1fb77-8e97-423a-9635-b35b014e3d1b\',\'\',\'\',\'4\',\'6\',\'01/03/2026\',\'16/06/2026\',\'0\',\'BUONGGIUONG\'); return false;">Buồng giường</span>\n                   <span style="width:175px;padding:5px 0;font-size: 15px;" class="btn btn-xs btn-outline btn-danger" onclick="onBuidUrl(\'4c95b5a1-1570-49ae-a376-b46600f1a003\',\'Lê Xuân Soang\',\'9ce1fb77-8e97-423a-9635-b35b014e3d1b\',\'\',\'\',\'4\',\'6\',\'01/03/2026\',\'16/06/2026\',\'0\',\'KEODONTHUOC\'); return false;">Kéo đơn thuốc</span>\n                   <span style="width:175px;padding:5px 0;font-size: 15px;" class="btn btn-xs btn-outline btn-danger" onclick="onBuidUrl(\'4c95b5a1-1570-49ae-a376-b46600f1a003\',\'Lê Xuân Soang\',\'9ce1fb77-8e97-423a-9635-b35b014e3d1b\',\'\',\'\',\'4\',\'6\',\'01/03/2026\',\'16/06/2026\',\'0\',\'TRATHUOCCADOTDT\'); return false;">Trả thuốc</span>\n                   <span style="width:175px;padding:5px 0;font-size: 15px;" class="btn btn-xs btn-outline btn-danger" onclick="onBuidUrl(\'4c95b5a1-1570-49ae-a376-b46600f1a003\',\'Lê Xuân Soang\',\'9ce1fb77-8e97-423a-9635-b35b014e3d1b\',\'\',\'\',\'4\',\'6\',\'01/03/2026\',\'16/06/2026\',\'0\',\'CHIDINHDVKT\'); return false;">Chỉ định DVKT</span>\n                   <span style="width:175px;padding:5px 0;font-size: 15px;" class="btn btn-xs btn-outline btn-danger" onclick="onBuidUrl(\'4c95b5a1-1570-49ae-a376-b46600f1a003\',\'Lê Xuân Soang\',\'9ce1fb77-8e97-423a-9635-b35b014e3d1b\',\'\',\'\',\'4\',\'6\',\'01/03/2026\',\'16/06/2026\',\'0\',\'DICHVUKHAC\'); return false;">Dịch vụ khác</span>\n                   <span style="width:175px;padding:5px 0;font-size: 15px;" class="btn btn-xs btn-outline btn-danger" onclick="onBuidUrl(\'4c95b5a1-1570-49ae-a376-b46600f1a003\',\'Lê Xuân Soang\',\'9ce1fb77-8e97-423a-9635-b35b014e3d1b\',\'\',\'\',\'4\',\'6\',\'01/03/2026\',\'16/06/2026\',\'0\',\'CHIDINHTHUOCVTYT\'); return false;">Thêm thuốc/ VTYT ĐD</span>\n                   <span style="width:175px;padding:5px 0;font-size: 15px;" class="btn btn-xs btn-outline btn-danger" onclick="onBuidUrl(\'4c95b5a1-1570-49ae-a376-b46600f1a003\',\'Lê Xuân Soang\',\'9ce1fb77-8e97-423a-9635-b35b014e3d1b\',\'\',\'\',\'4\',\'6\',\'01/03/2026\',\'16/06/2026\',\'0\',\'TONGKETRAKHOA\'); return false;">Tổng kết ra khoa</span>\n                   <span style="width:175px;padding:5px 0;font-size: 15px;" class="btn btn-xs btn-outline btn-danger" onclick="onBuidUrl(\'4c95b5a1-1570-49ae-a376-b46600f1a003\',\'Lê Xuân Soang\',\'9ce1fb77-8e97-423a-9635-b35b014e3d1b\',\'\',\'\',\'4\',\'6\',\'01/03/2026\',\'16/06/2026\',\'0\',\'XEMCHIPHI\'); return false;">Xem chi phí</span>\n               </li>\n           </ul>\n       </div>\n       <a id="btna4c95b5a1-1570-49ae-a376-b46600f1a003" href="home.aspx?scope=sys&amp;lang=vi&amp;wpid=bacsidraw&amp;noitruid=4c95b5a1-1570-49ae-a376-b46600f1a003&amp;keyword=lê xuân soang&amp;kp=9ce1fb77-8e97-423a-9635-b35b014e3d1b&amp;tt=4&amp;tg=6&amp;tungay=01/03/2026&amp;denngay=16/06/2026&amp;wpre=danhsachdieutrinoitrudraw&amp;nextlink=lichsuylenh&amp;usid=172.31.255.1_j3za2h5kz231vts2rptoktgicd4b5b52&amp;st=172713" target="" oncontextmenu="onrightClickEven(\'4c95b5a1-1570-49ae-a376-b46600f1a003\'); return false;">LÊ XUÂN SOANG<br><i style="font-size:13px;color:red;">- PM: PHÒNG PHẪU THUẬT</i></a>\n</td> \n    <td style="text-align: center"><a href="home.aspx?scope=sys&amp;lang=vi&amp;wpid=bacsidraw&amp;noitruid=4c95b5a1-1570-49ae-a376-b46600f1a003&amp;keyword=lê xuân soang&amp;kp=9ce1fb77-8e97-423a-9635-b35b014e3d1b&amp;tt=4&amp;tg=6&amp;tungay=01/03/2026&amp;denngay=16/06/2026&amp;wpre=danhsachdieutrinoitrudraw&amp;nextlink=lichsuylenh&amp;usid=172.31.255.1_j3za2h5kz231vts2rptoktgicd4b5b52&amp;st=172713" target="">66</a></td> \n    <td style="text-align: center"><a href="home.aspx?scope=sys&amp;lang=vi&amp;wpid=bacsidraw&amp;noitruid=4c95b5a1-1570-49ae-a376-b46600f1a003&amp;keyword=lê xuân soang&amp;kp=9ce1fb77-8e97-423a-9635-b35b014e3d1b&amp;tt=4&amp;tg=6&amp;tungay=01/03/2026&amp;denngay=16/06/2026&amp;wpre=danhsachdieutrinoitrudraw&amp;nextlink=lichsuylenh&amp;usid=172.31.255.1_j3za2h5kz231vts2rptoktgicd4b5b52&amp;st=172713" target="">Nam</a></td> \n    <td style="text-align: left"><a href="home.aspx?scope=sys&amp;lang=vi&amp;wpid=bacsidraw&amp;noitruid=4c95b5a1-1570-49ae-a376-b46600f1a003&amp;keyword=lê xuân soang&amp;kp=9ce1fb77-8e97-423a-9635-b35b014e3d1b&amp;tt=4&amp;tg=6&amp;tungay=01/03/2026&amp;denngay=16/06/2026&amp;wpre=danhsachdieutrinoitrudraw&amp;nextlink=lichsuylenh&amp;usid=172.31.255.1_j3za2h5kz231vts2rptoktgicd4b5b52&amp;st=172713" target="">Bảo hiểm<br>(Đúng tuyến)</a></td> \n    <td style="text-align: left"><a href="home.aspx?scope=sys&amp;lang=vi&amp;wpid=bacsidraw&amp;noitruid=4c95b5a1-1570-49ae-a376-b46600f1a003&amp;keyword=lê xuân soang&amp;kp=9ce1fb77-8e97-423a-9635-b35b014e3d1b&amp;tt=4&amp;tg=6&amp;tungay=01/03/2026&amp;denngay=16/06/2026&amp;wpre=danhsachdieutrinoitrudraw&amp;nextlink=lichsuylenh&amp;usid=172.31.255.1_j3za2h5kz231vts2rptoktgicd4b5b52&amp;st=172713" target=""></a></td> \n    <td style="text-align: right"><a href="home.aspx?scope=sys&amp;lang=vi&amp;wpid=bacsidraw&amp;noitruid=4c95b5a1-1570-49ae-a376-b46600f1a003&amp;keyword=lê xuân soang&amp;kp=9ce1fb77-8e97-423a-9635-b35b014e3d1b&amp;tt=4&amp;tg=6&amp;tungay=01/03/2026&amp;denngay=16/06/2026&amp;wpre=danhsachdieutrinoitrudraw&amp;nextlink=lichsuylenh&amp;usid=172.31.255.1_j3za2h5kz231vts2rptoktgicd4b5b52&amp;st=172713" target="">5,000,000</a></td> \n    <td style="text-align: right "><a style="" href="home.aspx?scope=sys&amp;lang=vi&amp;wpid=bacsidraw&amp;noitruid=4c95b5a1-1570-49ae-a376-b46600f1a003&amp;keyword=lê xuân soang&amp;kp=9ce1fb77-8e97-423a-9635-b35b014e3d1b&amp;tt=4&amp;tg=6&amp;tungay=01/03/2026&amp;denngay=16/06/2026&amp;wpre=danhsachdieutrinoitrudraw&amp;nextlink=lichsuylenh&amp;usid=172.31.255.1_j3za2h5kz231vts2rptoktgicd4b5b52&amp;st=172713" target=""><b>2,503,626</b></a></td> \n    <td style="text-align: center"><a href="home.aspx?scope=sys&amp;lang=vi&amp;wpid=bacsidraw&amp;noitruid=4c95b5a1-1570-49ae-a376-b46600f1a003&amp;keyword=lê xuân soang&amp;kp=9ce1fb77-8e97-423a-9635-b35b014e3d1b&amp;tt=4&amp;tg=6&amp;tungay=01/03/2026&amp;denngay=16/06/2026&amp;wpre=danhsachdieutrinoitrudraw&amp;nextlink=lichsuylenh&amp;usid=172.31.255.1_j3za2h5kz231vts2rptoktgicd4b5b52&amp;st=172713" target=""><span style="background-color:red;color:white;" class="badge">Hoàn tất</span></a></td> \n    <td style="text-align: left"><a href="home.aspx?scope=sys&amp;lang=vi&amp;wpid=bacsidraw&amp;noitruid=4c95b5a1-1570-49ae-a376-b46600f1a003&amp;keyword=lê xuân soang&amp;kp=9ce1fb77-8e97-423a-9635-b35b014e3d1b&amp;tt=4&amp;tg=6&amp;tungay=01/03/2026&amp;denngay=16/06/2026&amp;wpre=danhsachdieutrinoitrudraw&amp;nextlink=lichsuylenh&amp;usid=172.31.255.1_j3za2h5kz231vts2rptoktgicd4b5b52&amp;st=172713" target="">Lê Quang Trung</a></td> \n    <td style="text-align: left" title="- Sỏi niệu quản P&lt;br/&gt;- (C94.1) Bệnh tăng hồng cầu mạn&lt;br/&gt;- (E87) Rối loạn cân bằng nước, điện giải và thăng bằng kiềm toan&lt;br/&gt;- (D73.2) Lách to sung huyết mãn tính&lt;br/&gt;- (N20.0) Sỏi thận&lt;br/&gt;- (E78.2) Tăng lipid máu hỗn hợp&lt;br/&gt;- (I10) Bệnh lý tăng huyết áp&lt;br/&gt;- (D64) Các thiếu máu khác&lt;br/&gt;- (C94.6) Bệnh loạn sản tủy và tăng sinh tủy, chưa phân loại nơi khác&lt;br/&gt;- (D59) Thiếu máu tan máu mắc phải&lt;br/&gt;- (B99) Các bệnh nhiễm trùng khác và không đặc hiệu&lt;br/&gt;- (M47) thoái hóa cột sống&lt'
    rows = collect_patient_candidates_from_html(html, target_patient_names=["Lê Xuân Soang"], limit=5)
    assert len(rows) == 1
    assert rows[0]["ma_bn"] == "99063850"
    assert rows[0]["ho_ten"].lower() == "lê xuân soang"
    assert "wpid=dieuduongdraw" in rows[0]["href_nursing"].lower()


def test_care_page_indices_from_html_detects_next_page_calls():
    from worker.care_baseline_fetch import _care_page_indices_from_html
    html = '<a href="javascript:NextPageDDChamSoc(0);">1</a><a href="javascript:NextPageDDChamSoc(1);">2</a><a href="javascript:NextPageDDChamSoc(1);">›</a>'
    assert _care_page_indices_from_html(html) == [0, 1]


def test_click_care_info_menu_prefers_main_thong_tin_cham_soc():
    from worker.care_baseline_fetch import _click_care_info_menu

    class FakeDriver:
        def __init__(self):
            self.script = ""
        def execute_script(self, script, *args):
            self.script = script
            assert "onShowChamSoc" in script
            assert "cấp 1" in script or "cap 1" in script
            return {"ok": True, "method": "onShowChamSoc"}

    logs = []
    assert _click_care_info_menu(FakeDriver(), log_func=logs.append) is True
    assert any("CARE_INFO_MENU_CLICK" in m for m in logs)


def test_has_care_info_content_rejects_menu_only_and_accepts_loaded_table():
    from worker.care_baseline_fetch import _has_care_info_content

    class FakeDriver:
        def __init__(self, html):
            self.page_source = html

    menu_only = '''
    <ul><li><a id="btnTTCS" onclick="onShowChamSoc(this); return false;"> Thông tin chăm sóc</a></li></ul>
    '''
    loaded_table = '''
    <div id="divDanhSachChamSocContent">
      <table><thead><tr><th>Thời gian</th><th>Người lập</th><th>Diễn biến</th><th>Chăm sóc</th></tr></thead>
      <tbody><tr><td><a onclick="onDrawWebpartChamSoc('x')">05:00 16/06/2026</a></td><td>A</td><td>B</td><td>C</td></tr></tbody></table>
    </div>
    '''
    assert _has_care_info_content(FakeDriver(menu_only)) is False
    assert _has_care_info_content(FakeDriver(loaded_table)) is True


def test_care_page_indices_also_reads_current_paging_total():
    from worker.care_baseline_fetch import _care_page_indices_from_html
    html = '<li><a class="currentPaging">Trang 1/4</a></li><a href="javascript:NextPageDDChamSoc(1);">2</a>'
    assert _care_page_indices_from_html(html) == [0, 1, 2, 3]


def test_click_btnTTCS_exact_waits_and_clicks_user_provided_anchor():
    from worker.care_baseline_fetch import _click_btnTTCS_thong_tin_cham_soc_exact

    class FakeDriver:
        def __init__(self):
            self.calls = 0
        def execute_script(self, script, *args):
            self.calls += 1
            assert 'a#btnTTCS' in script
            assert 'onShowChamSoc' in script
            assert 'thông tin chăm sóc' in script
            if self.calls == 1:
                return {"ok": False, "reason": "btnTTCS_exact_not_found", "count": 0}
            return {"ok": True, "method": "btnTTCS_click", "text": "thông tin chăm sóc", "onclick": "onShowChamSoc(this); return false;"}

    logs = []
    assert _click_btnTTCS_thong_tin_cham_soc_exact(FakeDriver(), log_func=logs.append, timeout=1.0) is True
    assert any("target=btnTTCS:onShowChamSoc" in m for m in logs)


def test_has_care_info_content_requires_real_list_not_menu_with_other_table():
    from worker.care_baseline_fetch import _has_care_info_content

    class FakeDriver:
        def __init__(self, html):
            self.page_source = html

    menu_plus_other_table = '''
    <ul style="display:block;">
      <li><a id="btnTTCS" onclick="onShowChamSoc(this); return false;" style="font-weight: normal; color: white;"> Thông tin chăm sóc</a></li>
    </ul>
    <table><thead><tr><th>Thời gian</th><th>Diễn biến</th><th>Chăm sóc</th></tr></thead></table>
    '''
    care_list = '''
    <div id="divDanhSachChamSocContent">
      <table class="footable"><thead><tr><th>Thời gian</th><th>Người lập</th><th>Diễn biến</th><th>Chăm sóc</th></tr></thead>
      <tbody><tr><td><a onclick="onDrawWebpartChamSoc('x')">05:00 16/06/2026</a></td><td>A</td><td>B</td><td>C</td></tr></tbody></table>
    </div>
    '''
    assert _has_care_info_content(FakeDriver(menu_plus_other_table)) is False
    assert _has_care_info_content(FakeDriver(care_list)) is True



def test_main_writes_to_care_baseline_store_root_not_research_store(tmp_path, monkeypatch):
    import json
    import worker.care_baseline_fetch as mod

    cfg = tmp_path / "care_baseline.json"
    cfg.write_text(json.dumps({
        "enabled": True,
        "accounts": [{"id": "acc1", "username": "u", "password": "p", "enabled": True}],
    }, ensure_ascii=False), encoding="utf-8")
    out_root = tmp_path / "care_baseline_store"

    monkeypatch.setattr(mod, "load_config", lambda: {})

    def fake_run_account(account_cfg, run_id, run_dir, args):
        return {
            "account_id": account_cfg.get("id"),
            "department": "Khoa Test",
            "status": "done",
            "patients": 1,
            "rows": 1,
            "patient_results": [],
            "rows_data": [{
                "run_id": run_id,
                "account_id": "acc1",
                "account_department": "Khoa Test",
                "Khoa": "Khoa Test",
                "Mã BN": "99000001",
                "Họ tên người bệnh": "BN TEST",
                "Thời gian": "05:00 16/06/2026",
                "Người lập": "A",
                "Diễn biến": "B",
                "Chăm sóc": "C",
            }],
        }

    monkeypatch.setattr(mod, "run_account", fake_run_account)
    assert mod.main(["--config", str(cfg), "--out-root", str(out_root), "--run-id", "care_test"]) == 0
    assert (out_root / "runs" / "care_test" / "care_baseline.csv").exists()
    assert (out_root / "runs" / "care_test" / "summary.json").exists()
    assert (out_root / "latest.json").exists()
    assert not (out_root / "care_baseline").exists()
