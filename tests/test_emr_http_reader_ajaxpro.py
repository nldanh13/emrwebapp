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
    rows, link_map = sess.fetch_inpatient_list_via_ajaxpro(
        "http://emr.example/home.aspx?usid=1.2.3.4_xyz"
    )
    assert rows == []
    assert link_map == {}


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
    rows, link_map = sess.fetch_inpatient_list_via_ajaxpro(list_url)

    assert captured["method"] == "POST"
    assert captured["url"].endswith("/ajaxpro/Some.WebPart.ashx")
    assert captured["headers"]["X-AjaxPro-Method"] == "ServerSideDrawSearchResult_VDUH"
    assert len(rows) == 3
    assert set(link_map.keys()) == {"26091567", "26092226"}
    assert "tiepnhanid=enc-1" in link_map["26091567"]


def test_fetch_inpatient_list_via_ajaxpro_loi_tra_rong_khong_raise(monkeypatch):
    sess = _make_session(ajaxpro_inpatient_endpoint="Some.WebPart.ashx")

    def fake_request_html(method, url, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(sess, "_request_html", fake_request_html)

    rows, link_map = sess.fetch_inpatient_list_via_ajaxpro(
        "http://emr.example/home.aspx?usid=1.2.3.4_xyz"
    )
    assert rows == []
    assert link_map == {}
