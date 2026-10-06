# -*- coding: utf-8 -*-
"""Nhiều cách pha cho một thuốc (theo đường dùng / liều) và dấu "cần xác nhận cách pha"."""
import json
import os
import sys

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'worker'))

VANCO = {
    'canonical': 'VANCOMYCIN',
    'dilution': {
        'solvent': 'NACL_0.9', 'volume_ml': 100, 'apply': 'always',
        'variants': [
            {'dose_max_mg': 500, 'solvent': 'NACL_0.9', 'volume_ml': 100},
            {'dose_min_mg': 501, 'solvent': 'NACL_0.9', 'volume_ml': 200},
            {'route': 'SE', 'solvent': 'NACL_0.9', 'volume_ml': 50},
        ],
    },
}


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    from processing import medication_catalog as mc

    def use(meds):
        path = tmp_path / 'medication_catalog.json'
        path.write_text(json.dumps({'medications': meds}, ensure_ascii=False), encoding='utf-8')
        monkeypatch.setattr(mc, 'MEDICATION_CATALOG_FILE', str(path))
        mc.load_medication_catalog.cache_clear()

    yield use
    mc.load_medication_catalog.cache_clear()


def _run(drug):
    from processing.diluent_resolver import infer_and_reclassify_diluents
    infusions, injections = infer_and_reclassify_diluents([], [dict(drug)])
    return (infusions + injections)[0]


def _vanco(name, so_luong, gio='8 giờ, 20 giờ', route='Tiêm truyền tĩnh mạch (8 giờ, 20 giờ)'):
    return {'ten_thuoc': name, 'hoat_chat': 'Vancomycin', 'dang': 'Lọ', 'so_luong': so_luong,
            'gio_dung': gio, 'duong_dung_goc': route}


def test_dose_picks_variant(catalog):
    catalog([VANCO])
    out = _run(_vanco('VANCOMYCIN 1G', '2'))           # 1 g mỗi lần
    assert out['the_tich'] == 200.0 and out['nguon_pha'] == 'danh_muc'
    assert 'liều ≥ 501 mg' in out['cach_pha'] and not out.get('can_xac_nhan_pha')
    out = _run(_vanco('VANCOMYCIN 500MG', '2'))        # 500 mg mỗi lần
    assert out['the_tich'] == 100.0


def test_route_variant_is_more_specific(catalog):
    catalog([VANCO])
    out = _run(_vanco('VANCOMYCIN 1G', '2', route='Bơm tiêm điện 2ml/h (8 giờ, 20 giờ)'))
    # Cả "liều > 500" và "SE" đều khớp, nhưng mỗi cách chỉ một điều kiện → cùng mức cụ thể, khác thể tích.
    assert out.get('can_xac_nhan_pha') is True
    assert 'nhiều cách pha' in out['ly_do_xac_nhan_pha']


def test_unknown_dose_is_flagged_not_guessed(catalog):
    catalog([VANCO])
    out = _run(_vanco('VANCOMYCIN', ''))               # không có hàm lượng, không số lượng
    assert out['the_tich'] == 100.0                     # cách mặc định
    assert out['can_xac_nhan_pha'] is True
    assert 'liều mỗi lần' in out['ly_do_xac_nhan_pha']


def test_no_rule_default_volume_is_flagged(catalog):
    # Lọ bột truyền TM, không ghi dung môi/thể tích, không quy tắc → tạm 100 ml nhưng PHẢI đánh dấu.
    catalog([])
    out = _run({'ten_thuoc': 'THUOC LA 1G', 'dang': 'Lọ', 'so_luong': '1', 'gio_dung': '8 giờ',
                'duong_dung_goc': 'Tiêm truyền tĩnh mạch (8 giờ)'})
    assert out['nguon_pha'] == 'mac_dinh' and out['the_tich'] == 100.0
    assert out['can_xac_nhan_pha'] is True and '100 ml' in out['ly_do_xac_nhan_pha']


def test_dose_helper():
    from processing.dose import dose_mg_per_administration, strength_mg
    assert dose_mg_per_administration({'ten_thuoc': 'VANCOMYCIN 1G', 'so_luong': '2'}, 2) == 1000.0
    assert dose_mg_per_administration({'ten_thuoc': 'VANCOMYCIN 500MG', 'so_luong': '4'}, 2) == 1000.0
    assert strength_mg({'ten_thuoc': 'PARACETAMOL 10MG/ML'}) is None      # nồng độ, không phải liều
    assert strength_mg({'ten_thuoc': 'PARACETAMOL 1G/100ML'}) == 1000.0
    assert dose_mg_per_administration({'ten_thuoc': 'X 1G', 'so_luong': '3'}, 4) is None  # 0,75 lọ: không đoán
