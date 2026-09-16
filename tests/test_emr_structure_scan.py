# -*- coding: utf-8 -*-
"""Test thuần cho các hàm phân tích cấu trúc trong emr_structure_scan.py — không cần
EMR thật (không login/network). Phần login/scan_all_inpatients/get_html không test ở
đây vì cần EmrHttpSession thật."""

from emr_structure_scan import (
    _looks_like_write_action,
    _extract_page_structure,
    _extract_wpid_links,
    _load_manifest,
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
