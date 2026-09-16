# -*- coding: utf-8 -*-
"""Test thuần cho đường dự phòng AjaxPro trong emr_http_reader.py — không cần EMR thật
(không login/network thật, _request_html bị monkeypatch). Đường HTML bình thường
(scan_all_inpatients qua parse_noitru_page) không đổi và không test lại ở đây."""

import json

from emr_http_reader import EmrHttpSession, EmrHttpConfig


def _make_session(**overrides):
    cfg = EmrHttpConfig(
        url_login="http://emr.example/login.aspx",
        username="lndieu",
        password="x",
        url_inpatient_list="http://emr.example/home.aspx?wpid=danhsachdieutrinoitrudraw",
        **overrides,
    )
    return EmrHttpSession(cfg)


def test_build_inpatient_ajaxpro_payload_lay_ip_va_session_tu_usid():
    sess = _make_session()
    list_url = "http://emr.example/home.aspx?wpid=danhsachdieutrinoitrudraw&usid=172.31.255.1_abc123&st=1"
    payload = sess._build_inpatient_ajaxpro_payload(list_url)

    assert payload["ORenderInfo"]["Ip"] == "172.31.255.1"
    assert payload["ORenderInfo"]["Machine"] == "172.31.255.1"
    assert payload["ORenderInfo"]["UserSessionId"] == "172.31.255.1_abc123"
    assert payload["ORenderInfo"]["LoginName"] == "lndieu"
    # Chưa cấu hình thì bỏ qua field, không gửi Guid rỗng đoán mò.
    assert "DepartmentId" not in payload["ORenderInfo"]
    assert "OwnerUserId" not in payload["ORenderInfo"]
    assert "KhoaPhongId" not in payload


def test_build_inpatient_ajaxpro_payload_them_department_khi_da_cau_hinh():
    sess = _make_session(ajaxpro_department_id="dept-123", ajaxpro_owner_user_id="user-456")
    payload = sess._build_inpatient_ajaxpro_payload("http://emr.example/home.aspx?usid=1.2.3.4_xyz")

    assert payload["ORenderInfo"]["DepartmentId"] == "dept-123"
    assert payload["ORenderInfo"]["OwnerUserId"] == "user-456"
    assert payload["KhoaPhongId"] == "dept-123"


def test_fetch_inpatient_list_via_ajaxpro_khong_cau_hinh_endpoint_tra_rong():
    sess = _make_session()  # ajaxpro_inpatient_endpoint mặc định rỗng
    rows, link_map, error = sess.fetch_inpatient_list_via_ajaxpro(
        "http://emr.example/home.aspx?usid=1.2.3.4_xyz"
    )
    assert rows == []
    assert link_map == {}
    assert "ajaxpro_inpatient_endpoint" in error


def test_fetch_inpatient_list_via_ajaxpro_get_lai_truoc_khi_post_lay_usid_moi(monkeypatch):
    """Regression: EMR dường như cần phiên đã thật sự 'vào' đúng trang (state phía
    server, tham số 'st'/'usid' đổi mỗi lần tải) trước khi chấp nhận lệnh gọi AjaxPro —
    dùng URL cũ đã lưu (vd từ npm run auth:http) khiến server báo
    System.MissingMethodException dù tên method đúng. Phải GET lại đúng trang ngay
    trước khi POST và dùng URL mới cho payload/Referer/link kết quả."""
    sess = _make_session(ajaxpro_inpatient_endpoint="Some.WebPart.ashx")
    stale_url = "http://emr.example/home.aspx?wpid=danhsachdieutrinoitrudraw&usid=1.2.3.4_stale&st=1"
    fresh_url = "http://emr.example/home.aspx?wpid=danhsachdieutrinoitrudraw&usid=1.2.3.4_fresh&st=2"
    fake_response = json.dumps({
        "value": {"Error": False, "RetObject": [{"ID": "enc-1", "MaBN": "26091567", "TenBN": "x"}]},
    })

    calls = []
    posted_body = {}

    def fake_request_html(method, url, **kwargs):
        calls.append(method)
        if method == "GET":
            return "<html></html>", fresh_url
        # Chỉ ghi lại lệnh chính (lệnh lấy bảng), bỏ qua 3 lệnh khởi tạo chạy trước đó.
        if kwargs["headers"]["X-AjaxPro-Method"] == sess.cfg.ajaxpro_inpatient_method:
            posted_body["data"] = json.loads(kwargs["data"])
            posted_body["referer"] = kwargs["headers"]["Referer"]
        return fake_response, url

    monkeypatch.setattr(sess, "_request_html", fake_request_html)

    rows, link_map, error = sess.fetch_inpatient_list_via_ajaxpro(stale_url)

    # 1 GET làm mới phiên + 3 lệnh khởi tạo (cùng WebPart) + 1 lệnh chính, đúng thứ tự
    # trình duyệt thật gọi (xác nhận qua DevTools).
    assert calls == ["GET", "POST", "POST", "POST", "POST"]
    assert error is None
    assert posted_body["data"]["ORenderInfo"]["UserSessionId"] == "1.2.3.4_fresh"
    assert posted_body["referer"] == fresh_url
    assert "usid=1.2.3.4_fresh" in link_map["26091567"]
    assert "usid=1.2.3.4_stale" not in link_map["26091567"]


def test_fetch_inpatient_list_via_ajaxpro_goi_du_3_lenh_khoi_tao_dung_thu_tu_truoc_lenh_chinh(monkeypatch):
    """Trình duyệt thật gọi 3 lệnh AjaxPro khác (cùng WebPart, chỉ gửi ORenderInfo, không
    có bộ lọc tìm kiếm) trước khi gọi lệnh lấy bảng — xác nhận qua DevTools. Mô phỏng lại
    đúng tuần tự này, phòng trường hợp server cần các lệnh đó thiết lập trạng thái trước."""
    sess = _make_session(ajaxpro_inpatient_endpoint="Some.WebPart.ashx")
    fake_response = json.dumps({
        "value": {"Error": False, "RetObject": [{"ID": "enc-1", "MaBN": "26091567", "TenBN": "x"}]},
    })

    posted_methods = []
    posted_bodies = []

    def fake_request_html(method, url, **kwargs):
        if method == "GET":
            return "<html></html>", "http://emr.example/home.aspx?usid=1.2.3.4_xyz"
        posted_methods.append(kwargs["headers"]["X-AjaxPro-Method"])
        posted_bodies.append(json.loads(kwargs["data"]))
        return fake_response, url

    monkeypatch.setattr(sess, "_request_html", fake_request_html)

    sess.fetch_inpatient_list_via_ajaxpro("http://emr.example/home.aspx?usid=1.2.3.4_xyz")

    assert posted_methods == [
        "ServerSideCheckQuickConfigToday",
        "ServerSideGetQuickConfig",
        "ServerSideCheckAdmin",
        "ServerSideDrawSearchResult_VDUH",
    ]
    # 3 lệnh khởi tạo chỉ gửi mỗi ORenderInfo, không kèm bộ lọc tìm kiếm.
    for body in posted_bodies[:3]:
        assert set(body.keys()) == {"ORenderInfo"}
    # lệnh chính mới có đủ bộ lọc tìm kiếm.
    assert "CurrentPageIndex" in posted_bodies[3]


def test_fetch_inpatient_list_via_ajaxpro_parse_retobject_thanh_link_map(monkeypatch):
    sess = _make_session(ajaxpro_inpatient_endpoint="Some.WebPart.ashx")
    fake_response = json.dumps({
        "value": {
            "Error": False,
            "RetObject": [
                {"ID": "enc-1", "MaBN": "26091567", "TenBN": "x"},
                {"ID": "enc-2", "MaBN": "26092226", "TenBN": "x"},
                {"ID": "", "MaBN": "no-id-row"},  # thiếu ID -> không vào link_map
            ],
        }
    })

    captured = {}

    def fake_request_html(method, url, **kwargs):
        captured["method"] = method
        captured["url"] = url
        captured["headers"] = kwargs.get("headers")
        return fake_response, url

    monkeypatch.setattr(sess, "_request_html", fake_request_html)

    list_url = "http://emr.example/home.aspx?wpid=danhsachdieutrinoitrudraw&usid=1.2.3.4_xyz"
    rows, link_map, error = sess.fetch_inpatient_list_via_ajaxpro(list_url)

    assert captured["method"] == "POST"
    assert captured["url"].endswith("/ajaxpro/Some.WebPart.ashx")
    assert captured["headers"]["X-AjaxPro-Method"] == "ServerSideDrawSearchResult_VDUH"
    assert len(rows) == 3
    assert set(link_map.keys()) == {"26091567", "26092226"}
    assert "tiepnhanid=enc-1" in link_map["26091567"]
    assert error is None


def test_fetch_inpatient_list_via_ajaxpro_loi_http_khong_raise_va_bao_ro_ly_do(monkeypatch):
    sess = _make_session(ajaxpro_inpatient_endpoint="Some.WebPart.ashx")

    def fake_request_html(method, url, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(sess, "_request_html", fake_request_html)

    rows, link_map, error = sess.fetch_inpatient_list_via_ajaxpro(
        "http://emr.example/home.aspx?usid=1.2.3.4_xyz"
    )
    assert rows == []
    assert link_map == {}
    assert "boom" in error


def test_fetch_inpatient_list_via_ajaxpro_thieu_retobject_bao_ro_cac_khoa_thay_duoc(monkeypatch):
    """Đúng tình huống thực tế gặp phải: JSON hợp lệ, có 'value', nhưng không có
    RetObject dạng danh sách — báo rõ tên các khoá tìm thấy để chẩn đoán tiếp,
    không lặp lại y hệt câu chung chung cũ."""
    sess = _make_session(ajaxpro_inpatient_endpoint="Some.WebPart.ashx")
    fake_response = json.dumps({"value": {"InfoMessage": "", "SomeOtherField": 1}})
    monkeypatch.setattr(sess, "_request_html", lambda method, url, **kw: (fake_response, url))

    rows, link_map, error = sess.fetch_inpatient_list_via_ajaxpro(
        "http://emr.example/home.aspx?usid=1.2.3.4_xyz"
    )
    assert rows == []
    assert link_map == {}
    assert "RetObject" in error
    assert "SomeOtherField" in error


def test_fetch_inpatient_list_via_ajaxpro_ajaxpro_tu_choi_lenh_goi_bao_ro_noi_dung(monkeypatch):
    """Đúng dạng lỗi chuẩn của AjaxPro khi method/param bị server từ chối trước khi
    chạy (khác value.Error — ở đây không có 'value' luôn, chỉ có 'error')."""
    sess = _make_session(ajaxpro_inpatient_endpoint="Some.WebPart.ashx")
    fake_response = json.dumps({"error": "Object reference not set to an instance of an object."})
    monkeypatch.setattr(sess, "_request_html", lambda method, url, **kw: (fake_response, url))

    rows, link_map, error = sess.fetch_inpatient_list_via_ajaxpro(
        "http://emr.example/home.aspx?usid=1.2.3.4_xyz"
    )
    assert rows == []
    assert link_map == {}
    assert "Object reference not set" in error


def test_fetch_inpatient_list_via_ajaxpro_thieu_value_bao_ro_cac_khoa_ngoai_cung(monkeypatch):
    sess = _make_session(ajaxpro_inpatient_endpoint="Some.WebPart.ashx")
    fake_response = json.dumps({"otherKey": True})
    monkeypatch.setattr(sess, "_request_html", lambda method, url, **kw: (fake_response, url))

    rows, link_map, error = sess.fetch_inpatient_list_via_ajaxpro(
        "http://emr.example/home.aspx?usid=1.2.3.4_xyz"
    )
    assert rows == []
    assert link_map == {}
    assert "value" in error
    assert "otherKey" in error


def test_fetch_inpatient_list_via_ajaxpro_server_bao_loi_duoc_bao_ro(monkeypatch):
    sess = _make_session(ajaxpro_inpatient_endpoint="Some.WebPart.ashx")
    fake_response = json.dumps({
        "value": {"Error": True, "InfoMessage": "Không có quyền truy cập"},
    })
    monkeypatch.setattr(sess, "_request_html", lambda method, url, **kw: (fake_response, url))

    rows, link_map, error = sess.fetch_inpatient_list_via_ajaxpro(
        "http://emr.example/home.aspx?usid=1.2.3.4_xyz"
    )
    assert rows == []
    assert link_map == {}
    assert "Không có quyền truy cập" in error
