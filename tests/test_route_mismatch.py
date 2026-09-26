# -*- coding: utf-8 -*-
"""Cảnh báo ROUTE_MISMATCH: y lệnh ghi đường dùng khác đường đã cài trong danh mục thuốc."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

from processing import medication_catalog  # noqa: E402
from processing.medication_catalog import allowed_routes_of, route_mismatch_warning  # noqa: E402


@pytest.fixture
def catalog(monkeypatch, tmp_path):
    path = tmp_path / 'medication_catalog.json'
    path.write_text(json.dumps({'version': 1, 'medications': [
        {'canonical': 'VANCOMYCIN', 'aliases': ['VANCOMYCIN 1G'], 'default_route': 'TTM'},
        {'canonical': 'ENOXAPARIN', 'default_route': 'TDD', 'routes': ['TDD', 'TMC']},
        {'canonical': 'SALBUTAMOL', 'routes': ['KHI_DUNG', 'U']},
        {'canonical': 'NO_ROUTE'},
    ]}, ensure_ascii=False), encoding='utf-8')
    monkeypatch.setattr(medication_catalog, 'MEDICATION_CATALOG_FILE', str(path))
    medication_catalog.load_medication_catalog.cache_clear()
    yield
    medication_catalog.load_medication_catalog.cache_clear()


def test_allowed_routes_normalize_legacy_labels():
    assert allowed_routes_of({'default_route': 'IV', 'routes': ['TMC', 'U', 'Uống']}) == ['TMC', 'UONG']


def test_warns_when_order_route_differs(catalog):
    warn = route_mismatch_warning({'ten_thuoc': 'Vancomycin 1g', 'duong_dung_goc': 'Tiêm bắp', 'gio_y_lenh': '08:00'}, 'TB')
    assert warn['code'] == 'ROUTE_MISMATCH'
    assert warn['route'] == 'TB' and warn['expected_routes'] == ['TTM']
    assert 'TB' in warn['message'] and 'TTM' in warn['message']
    assert warn['gio_y_lenh'] == '08:00'


def test_no_warning_when_route_allowed(catalog):
    assert route_mismatch_warning({'ten_thuoc': 'Enoxaparin 40mg', 'duong_dung_goc': 'TMC'}, 'TMC') is None
    assert route_mismatch_warning({'ten_thuoc': 'Salbutamol', 'duong_dung_goc': 'uống'}, 'UONG') is None
    assert route_mismatch_warning({'ten_thuoc': 'Salbutamol', 'duong_dung_goc': 'khí dung'}, 'KHI_DUNG') is None


def test_generic_injection_is_not_a_mismatch(catalog):
    # "Tiêm" chung chung không mâu thuẫn với TTM đã cài.
    assert route_mismatch_warning({'ten_thuoc': 'Vancomycin 1g', 'duong_dung_goc': 'Tiêm'}, 'TMC') is None
    # Nhưng thuốc chỉ cài khí dung/uống mà y lệnh ghi tiêm thì vẫn báo.
    assert route_mismatch_warning({'ten_thuoc': 'Salbutamol', 'duong_dung_goc': 'Tiêm'}, 'TMC') is not None


def test_no_warning_without_setup_or_route(catalog):
    assert route_mismatch_warning({'ten_thuoc': 'NO_ROUTE', 'duong_dung_goc': 'TB'}, 'TB') is None
    assert route_mismatch_warning({'ten_thuoc': 'Thuốc lạ', 'duong_dung_goc': 'TB'}, 'TB') is None
    assert route_mismatch_warning({'ten_thuoc': 'Vancomycin 1g', 'duong_dung_goc': ''}, '') is None


def test_semantic_match_does_not_warn(catalog):
    # Khớp gần đúng (lỗi chính tả) không đủ chắc để cảnh báo.
    assert route_mismatch_warning({'ten_thuoc': 'Vancomicyn', 'duong_dung_goc': 'Tiêm bắp'}, 'TB') is None
