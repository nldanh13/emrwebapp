# -*- coding: utf-8 -*-
"""Phát hiện thuốc chưa có trong Danh mục thuốc từ dữ liệu đã có."""
import csv
import json
import os
import sys

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'worker'))


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    from processing import medication_catalog as mc
    path = tmp_path / 'medication_catalog.json'
    path.write_text(json.dumps({'medications': [{'canonical': 'VANCOMYCIN', 'aliases': ['VANCOMYCIN 1G']}]}), encoding='utf-8')
    monkeypatch.setattr(mc, 'MEDICATION_CATALOG_FILE', str(path))
    mc.load_medication_catalog.cache_clear()
    yield
    mc.load_medication_catalog.cache_clear()


def test_lists_only_drugs_missing_from_catalog(tmp_path, catalog):
    import catalog_gaps
    processed = tmp_path / 'p.json'
    processed.write_text(json.dumps([{'ngay_lam': '05/10/2026', 'thuoc': {
        'dich_truyen': [
            {'ten_thuoc': 'VANCOMYCIN 1G', 'dung_moi': 'NACL_0.9', 'the_tich': 100, 'duong_dung': 'TTM'},
            {'ten_thuoc': 'AMIPAREN 10%', 'hoat_chat': 'Acid amin', 'the_tich': 200, 'duong_dung': 'TTM', 'dang': 'Chai'},
        ],
        'thuoc_tiem': [{'ten_thuoc': 'VINPHACINE 500mg/2ml (1 ống)', 'hoat_chat': 'Amikacin', 'duong_dung': 'TMC', 'dang': 'Ống'}],
        'thuoc_uong': [{'ten_thuoc': '(TT) Eperison 50mg', 'hoat_chat': 'Eperison', 'duong_dung': 'UONG', 'dang': 'Viên'}],
    }}]), encoding='utf-8')
    orders = tmp_path / 'medication_orders.csv'
    with open(orders, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['drug_name_raw', 'active_ingredient', 'route_norm', 'order_date'])
        w.writeheader()
        w.writerow({'drug_name_raw': 'Eperison 50mg', 'active_ingredient': 'Eperison', 'route_norm': 'UONG', 'order_date': '2026-10-06'})
        w.writerow({'drug_name_raw': 'Vancomycin 1g', 'active_ingredient': 'Vancomycin', 'route_norm': 'TTM', 'order_date': '2026-10-06'})
        w.writerow({'drug_name_raw': 'Natri clorid 0,9% 100ml', 'route_norm': 'TTM', 'order_date': '2026-10-06'})
    out = tmp_path / 'out.json'
    sys.argv = ['catalog_gaps.py', '--out', str(out), '--processed', str(processed), '--orders', str(orders)]
    assert catalog_gaps.main() == 0
    data = json.loads(out.read_text(encoding='utf-8'))
    by = {d['name']: d for d in data['drugs']}
    assert set(by) == {'AMIPAREN 10%', 'VINPHACINE 500mg/2ml', 'Eperison 50mg'}   # Vancomycin có rồi, NaCl bỏ qua
    assert by['Eperison 50mg']['count'] == 2 and set(by['Eperison 50mg']['sources']) == {'du_lieu_phien', 'kho_nghien_cuu'}
    assert by['Eperison 50mg']['last_seen'] == '2026-10-06'
    assert by['AMIPAREN 10%']['volume_ml'] == 200.0 and by['AMIPAREN 10%']['ingredient'] == 'Acid amin'
    assert by['VINPHACINE 500mg/2ml']['route'] == 'TMC' and by['VINPHACINE 500mg/2ml']['category'] == 'thuoc_tiem'
