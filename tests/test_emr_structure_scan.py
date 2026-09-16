# -*- coding: utf-8 -*-
"""Test thuần cho các hàm phân tích cấu trúc trong emr_structure_scan.py — không cần
EMR thật (không login/network). Phần login/scan_all_inpatients/get_html dùng
EmrHttpSession giả (monkeypatch) để test run_scan() khi không có bệnh nhân mẫu."""

import emr_structure_scan
from emr_structure_scan import (
    _looks_like_write_action,
    _extract_page_structure,
    _extract_wpid_links,
    _load_manifest,
    run_scan,
)


def test_looks_like_write_action_nhan_dung_tu_hanh_dong_ghi():
    assert _looks_like_write_action('Xóa') is True
    assert _looks_like_write_action('Lưu hồ sơ') is True
    assert _looks_like_write_action('Cập nhật thông tin') is True
    assert _looks_like_write_action('Xác nhận') is True


def test_looks_like_write_action_khong_nham_chu_doc_thuong():
    assert _looks_like_write_action('Xem chi tiết') is False
    assert _looks_like_write_action('Bảng kê chi phí') is False
    assert _looks_like_write_action('') is False


def test_extract_page_structure_lay_dung_field_bang_dropdown():
    html = '''
    <html><body>
      <input id="txtBatDauPT" />
      <select id="cbbBacSiPT"><option>A</option><option>B</option></select>
      <table id="dsDichVu">
        <tr><th>Tên DV</th><th>Đơn giá</th></tr>
        <tr><td>X</td><td>1000</td></tr>
      </table>
      <input type="hidden" />
    </body></html>
    '''
    r = _extract_page_structure(html)
    assert 'txtBatDauPT' in r['field_ids']
    assert 'cbbBacSiPT' in r['field_ids']
    assert any(t['id'] == 'dsDichVu' for t in r['tables'])
    dsdv = next(t for t in r['tables'] if t['id'] == 'dsDichVu')
    assert 'Tên DV' in dsdv['headers']
    dd = next(d for d in r['dropdowns'] if d['id'] == 'cbbBacSiPT')
    assert dd['option_count'] == 2


def test_extract_wpid_links_bo_qua_link_hanh_dong_ghi():
    html = '''
    <html><body>
      <a href="/home.aspx?wpid=phauthuatdraw&tiepnhanid=1">Xem chi tiết</a>
      <a href="/home.aspx?wpid=xoahoso&tiepnhanid=1">Xóa hồ sơ</a>
      <a href="/home.aspx?nowpid=1">Không có wpid</a>
    </body></html>
    '''
    links = _extract_wpid_links(html, 'https://emr.example.com/')
    wpids = [l['wpid'] for l in links]
    assert 'phauthuatdraw' in wpids
    assert 'xoahoso' not in wpids  # bị lọc vì text "Xóa hồ sơ"


def test_load_manifest_co_du_cac_trang_da_biet():
    manifest = _load_manifest()
    pages = manifest.get('pages', {})
    assert 'bac_si' in pages
    assert 'bang_ke_chi_phi' in pages
    assert 'chi_tiet_phau_thuat' in pages
    assert pages['bac_si'].get('wpid_literal') == 'bacsidraw'


class _FakeSessionNoPatients:
    base_origin = 'https://emr.example.com'

    def login(self):
        pass

    def scan_all_inpatients(self):
        return [], {}

    def _effective_inpatient_url(self):
        return 'https://emr.example.com/home.aspx?wpid=danhsachdieutrinoitrudraw'

    def get_html(self, url):
        return '<html><body>Danh sách trống, không có bảng tblNoiTru</body></html>', url


class _FakeEmrHttpSessionNoPatients:
    @staticmethod
    def from_config_dict(config):
        return _FakeSessionNoPatients()


def test_run_scan_khong_co_benh_nhan_mau_van_bao_cao_thay_vi_bo_cuoc(monkeypatch):
    """Regression: trước đây link_map rỗng làm run_scan() bỏ cuộc ngay, không báo được
    lý do (vd bảng tblNoiTru đổi cấu trúc). Giờ vẫn kiểm trang không cần patient
    (danh sách nội trú) và trả cảnh báo + chẩn đoán, chỉ skip các trang cần patient."""
    monkeypatch.setattr(emr_structure_scan, 'EmrHttpSession', _FakeEmrHttpSessionNoPatients)
    monkeypatch.setattr(emr_structure_scan, 'load_config', lambda: {})

    report = run_scan(max_discovered=5)

    assert report['status'] == 'ok'
    assert report['sample_ma_bn'] is None
    assert report['warning']
    assert report['inpatient_scan_diag'] == {
        'source': 'html_table',
        'rows_parsed_count': 0,
        'link_map_count': 0,
        'sample_row_headers': [],
    }
    assert report['inpatient_list_source'] == 'html_table'

    by_key = {p['page_key']: p for p in report['known_pages']}
    assert by_key['bac_si']['status'] == 'skipped_no_sample_patient'
    assert by_key['danhsach_noi_tru']['status'] == 'changed'
    assert 'tblNoiTru' in by_key['danhsach_noi_tru']['missing_tables']


class _FakeSessionAjaxproFallback(_FakeSessionNoPatients):
    """Bảng HTML rỗng, nhưng đường dự phòng AjaxPro có dữ liệu thật."""

    def fetch_inpatient_list_via_ajaxpro(self, list_url):
        return (
            [{'ID': 'enc-1', 'MaBN': '26091567', 'TenBN': 'x'}],
            {'26091567': 'https://emr.example.com/home.aspx?wpid=bacsidraw&tiepnhanid=enc-1'},
        )


class _FakeEmrHttpSessionAjaxproFallback:
    @staticmethod
    def from_config_dict(config):
        return _FakeSessionAjaxproFallback()


def test_run_scan_dung_duoc_ajaxpro_khi_html_khong_thay_bang(monkeypatch):
    """Một số bản HIS vẽ bảng nội trú bằng AjaxPro/JS — khi HTML thường không thấy
    link_map, run_scan() thử đường dự phòng AjaxPro; nếu có dữ liệu thì dùng luôn,
    không còn báo 'không có bệnh nhân mẫu' nữa."""
    monkeypatch.setattr(emr_structure_scan, 'EmrHttpSession', _FakeEmrHttpSessionAjaxproFallback)
    monkeypatch.setattr(emr_structure_scan, 'load_config', lambda: {})

    report = run_scan(max_discovered=5)

    assert report['status'] == 'ok'
    assert report['sample_ma_bn'] == '26091567'
    assert report['warning'] is None
    assert report['inpatient_list_source'] == 'ajaxpro_fallback'

    by_key = {p['page_key']: p for p in report['known_pages']}
    # có bệnh nhân mẫu (qua AjaxPro) nên trang cần patient không còn bị skip nữa
    assert by_key['bac_si']['status'] != 'skipped_no_sample_patient'
