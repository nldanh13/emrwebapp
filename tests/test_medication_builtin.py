# -*- coding: utf-8 -*-
"""Kiến thức thuốc sẵn có gom về config/medication_builtin.json; Danh mục thuốc ghi đè được."""
import json
import os
import sys

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'worker'))


def test_builtin_values_equal_old_hardcoded_values():
    # Giá trị trước khi gom (xu_ly_config.py + d_v2.json mục 3, 5) — không được lệch.
    import xu_ly_config as x
    assert x.DEFAULT_VOLUMES == {"THERMODOL": 100, "PARACETAMOL": 100, "GLUCOSE": 500, "RINGER": 500,
                                 "CIPRO": 200, "LEVO": 100, "METRO": 100, "AMINOLEBAN": 500}
    assert x.THE_TICH_AO["LINEZOLID"] == 300 and x.THE_TICH_AO["NATRI CLORID 0,9%"] == 100
    assert x.DEFAULT_NACL_VOLUME_BY_KEYWORD == {"MEROVIA": 100, "PIPERACILLIN/TAZOBACTAM": 100, "TAZOBACTAM": 100,
                                                "VANCOMYCIN": 100, "COLISTIMED": 50, "COLISTIN": 50}
    assert {r['hoat_chat'] for r in x.LUAT_AN_TOAN.values()} == {
        'NEFOPAM', 'TRAMADOL', 'VANCOMYCIN', 'MEROVIA', 'PIPERACILLIN', 'COLISTIMED'}
    assert x.get_safety_nacl_volume('COLISTIMED 2MUI') == 50.0
    assert x.BRAND_ACTIVE_INGREDIENT['VECMID'] == 'VANCOMYCIN'
    assert x.NO_WATER_TAG_KEYWORDS == ["METHYLPREDNISOLON", "SOLU-MEDROL", "SOLU MEDROL"]


def test_d_v2_only_keeps_default_hours():
    with open(os.path.join(ROOT, 'config', 'd_v2.json'), encoding='utf-8') as f:
        data = json.load(f)
    assert set(data) == {'__meta__', 'gio_mac_dinh'}


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


def test_catalog_active_ingredient_lets_brand_use_dilution_rule(catalog):
    # Trước: chỉ VECMID viết cứng trong code. Nay khai báo hoạt chất trong Danh mục là đủ.
    from processing.diluent_resolver import infer_and_reclassify_diluents
    catalog([{'canonical': 'VANCOTEX', 'active_ingredients': ['Vancomycin']}])
    drug = {'ten_thuoc': 'VANCOTEX 1G', 'dang': 'Lọ', 'so_luong': '1', 'gio_dung': '8 giờ',
            'duong_dung_goc': 'Tiêm tĩnh mạch chậm (8 giờ)'}
    infusions, injections = infer_and_reclassify_diluents([], [drug])
    assert injections == [] and infusions[0]['dung_moi'] == 'NACL_0.9'


def test_catalog_own_solvent_flag_skips_water_tag(catalog):
    from processing.infusion_scheduler import _catalog_has_own_solvent
    catalog([{'canonical': 'ABC THUOC', 'co_dung_moi_di_kem': True}])
    assert _catalog_has_own_solvent({'ten_thuoc': 'ABC THUOC 40MG'}) is True
    assert _catalog_has_own_solvent({'ten_thuoc': 'XYZ'}) is False
