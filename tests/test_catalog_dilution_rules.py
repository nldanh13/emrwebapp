# -*- coding: utf-8 -*-
"""Quy tắc pha thuốc cài trong Danh mục thuốc (trường 'dilution') được bước xử lý dùng."""
import json
import os
import sys

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WORKER = os.path.join(ROOT, 'worker')
if WORKER not in sys.path:
    sys.path.insert(0, WORKER)


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


def _vial(name, active, route='Tiêm tĩnh mạch chậm (8 giờ)'):
    return {
        'ten_thuoc': name, 'hoat_chat': active, 'dang': 'Lọ', 'so_luong': '1',
        'gio_dung': '8 giờ', 'duong_dung_goc': route,
    }


def test_rule_always_nacl_moves_vial_to_infusion_with_catalog_volume(catalog):
    from processing.diluent_resolver import infer_and_reclassify_diluents
    catalog([{'canonical': 'TAZOCIN', 'aliases': ['TAZOCIN 4.5G'],
              'dilution': {'solvent': 'NACL_0.9', 'volume_ml': 250, 'apply': 'always'}}])

    infusions, injections = infer_and_reclassify_diluents([], [_vial('TAZOCIN 4.5G', 'Abc')])
    assert injections == []
    assert len(infusions) == 1
    out = infusions[0]
    assert out['dung_moi'] == 'NACL_0.9'
    assert float(out['the_tich']) == 250.0
    assert 'Natri clorid 0.9% 250 ml' in out['quy_tac_pha']


def test_rule_infusion_only_keeps_slow_iv_but_sets_volume_when_order_says_infusion(catalog):
    from processing.diluent_resolver import infer_and_reclassify_diluents
    catalog([{'canonical': 'THUOCX', 'dilution': {'solvent': 'NACL_0.9', 'volume_ml': 50, 'apply': 'infusion_only'}}])

    infusions, injections = infer_and_reclassify_diluents([], [_vial('THUOCX 1G', 'Xyz')])
    assert infusions == [] and len(injections) == 1

    infusions, injections = infer_and_reclassify_diluents([], [_vial('THUOCX 1G', 'Xyz', 'Tiêm truyền TM (8 giờ)')])
    assert injections == [] and float(infusions[0]['the_tich']) == 50.0


def test_rule_khong_pha_overrides_built_in_vancomycin_rule(catalog):
    from processing.diluent_resolver import infer_and_reclassify_diluents
    from xu_ly_config import get_safety_nacl_volume
    catalog([{'canonical': 'VANCOMYCIN', 'dilution': {'solvent': 'KHONG_PHA', 'apply': 'always'}}])

    assert get_safety_nacl_volume('VANCOMYCIN 1G') is None
    vanco = _vial('VANCOMYCIN 1G', 'Vancomycin', 'Tiêm truyền TM (8 giờ)')
    infusions, injections = infer_and_reclassify_diluents([], [vanco])
    out = (infusions + injections)[0]
    assert not out.get('dung_moi')
    assert 'Không pha thêm' in out['quy_tac_pha']


def test_order_text_still_wins_over_catalog_rule(catalog):
    from processing.diluent_resolver import infer_and_reclassify_diluents
    catalog([{'canonical': 'TAZOCIN', 'dilution': {'solvent': 'NACL_0.9', 'volume_ml': 250, 'apply': 'always'}}])

    drug = _vial('TAZOCIN 4.5G', 'Abc', 'Pha Natri clorid 0.9% lấy đủ 100ml truyền TM (8 giờ)')
    drug['the_tich_lay_ml'] = 100
    infusions, _ = infer_and_reclassify_diluents([], [drug])
    assert float(infusions[0]['the_tich']) == 100.0


def test_glucose_rule_is_note_only(catalog):
    from processing.diluent_resolver import infer_and_reclassify_diluents
    catalog([{'canonical': 'AMIODARON', 'dilution': {'solvent': 'GLUCOSE_5', 'volume_ml': 250, 'note': 'Không pha NaCl'}}])

    infusions, injections = infer_and_reclassify_diluents([], [_vial('AMIODARON 150MG', 'Amiodaron')])
    out = (infusions + injections)[0]
    assert out.get('dung_moi') in (None, '')
    assert out['quy_tac_pha'].startswith('Pha Glucose 5% 250 ml — Không pha NaCl')


def test_no_rule_keeps_old_behavior(catalog):
    from xu_ly_config import get_safety_nacl_volume
    from processing.medication_catalog import catalog_dilution_rule
    catalog([{'canonical': 'TAZOCIN'}])
    assert catalog_dilution_rule('TAZOCIN 4.5G') is None
    assert get_safety_nacl_volume('PARACETAMOL') is None
