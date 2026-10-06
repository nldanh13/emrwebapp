# -*- coding: utf-8 -*-
"""Một thuốc nhiều quy cách (Natri clorid túi 100 ml, chai 500 ml) — tốc độ theo đúng thể tích."""
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
    path.write_text(json.dumps({'medications': [{
        'canonical': 'NATRI CLORID 0,9%', 'aliases': ['SODIUM CHLORIDE 0,9%'], 'category': 'dich_truyen', 'default_route': 'TTM',
        'default_volume_ml': 100, 'default_rate': '30', 'quy_cach': [{'volume_ml': 500, 'rate': '40'}, {'volume_ml': 1000}],
    }]}), encoding='utf-8')
    monkeypatch.setattr(mc, 'MEDICATION_CATALOG_FILE', str(path))
    mc.load_medication_catalog.cache_clear()
    yield mc
    mc.load_medication_catalog.cache_clear()


def test_rate_follows_the_line_volume(catalog):
    complete = catalog.complete_medication_from_catalog
    out, _ = complete({'ten_thuoc': 'NATRI CLORID 0,9%', 'the_tich': 500.0}, only_if_missing_usage=False)
    assert out['toc_do'] == '40'
    out, _ = complete({'ten_thuoc': 'NATRI CLORID 0,9%', 'the_tich': 100.0}, only_if_missing_usage=False)
    assert out['toc_do'] == '30'
    out, _ = complete({'ten_thuoc': 'NATRI CLORID 0,9%', 'the_tich': 1000.0}, only_if_missing_usage=False)
    assert out['toc_do'] == '30'            # quy cách 1000 ml không có tốc độ → mặc định
    out, _ = complete({'ten_thuoc': 'NATRI CLORID 0,9%'}, only_if_missing_usage=False)
    assert out['the_tich'] == 100.0 and out['toc_do'] == '30'
    out, _ = complete({'ten_thuoc': 'NATRI CLORID 0,9%', 'the_tich': 500.0, 'toc_do': '60'}, only_if_missing_usage=False)
    assert out['toc_do'] == '60'            # y lệnh ghi tốc độ thì giữ


def test_presentations_list(catalog):
    med = catalog.load_medication_catalog()[0]
    assert [p['volume_ml'] for p in catalog.presentations_of(med)] == [100.0, 500.0, 1000.0]
