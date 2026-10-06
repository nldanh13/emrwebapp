# -*- coding: utf-8 -*-
"""Tự học danh mục thuốc từ dữ liệu quét được — sync_catalog_from_processed_records()."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

from processing import medication_catalog


def _write_catalog(path, medications):
    path.write_text(json.dumps({'version': 1, 'medications': medications}, ensure_ascii=False), encoding='utf-8')


def _patch_catalog_path(monkeypatch, tmp_path):
    catalog_path = tmp_path / 'medication_catalog.json'
    monkeypatch.setattr(medication_catalog, 'MEDICATION_CATALOG_FILE', str(catalog_path))
    medication_catalog.load_medication_catalog.cache_clear()
    return catalog_path


def _records_with_infusion(ten_thuoc, the_tich, toc_do='40'):
    return [{
        'ma_bn': 'BN001',
        'ngay_lam': '17/09/2026',
        'thuoc': {
            'dich_truyen': [
                {'ten_thuoc': ten_thuoc, 'ten_hien_thi': ten_thuoc, 'the_tich': the_tich, 'toc_do': toc_do},
            ],
        },
    }]


def test_sync_updates_existing_drug_when_volume_differs(monkeypatch, tmp_path):
    catalog_path = _patch_catalog_path(monkeypatch, tmp_path)
    _write_catalog(catalog_path, [
        {'canonical': 'THERMODOL', 'aliases': ['PARACETAMOL 1G'], 'category': 'dich_truyen',
         'default_volume_ml': 100, 'default_rate': '100'},
    ])

    added, updated = medication_catalog.sync_catalog_from_processed_records(
        _records_with_infusion('THERMODOL', 250, '60')
    )

    assert (added, updated) == (0, 1)
    saved = json.loads(catalog_path.read_text(encoding='utf-8'))
    med = saved['medications'][0]
    assert med['default_volume_ml'] == 250
    assert med['default_rate'] == '60'


def test_sync_adds_new_drug_not_in_catalog(monkeypatch, tmp_path):
    catalog_path = _patch_catalog_path(monkeypatch, tmp_path)
    _write_catalog(catalog_path, [])

    added, updated = medication_catalog.sync_catalog_from_processed_records(
        _records_with_infusion('TEST_NEW_DRUG', 300, '50')
    )

    assert (added, updated) == (1, 0)
    saved = json.loads(catalog_path.read_text(encoding='utf-8'))
    assert saved['medications'][0]['canonical'] == 'TEST_NEW_DRUG'
    assert saved['medications'][0]['default_volume_ml'] == 300


def test_sync_matches_by_alias_not_just_canonical(monkeypatch, tmp_path):
    catalog_path = _patch_catalog_path(monkeypatch, tmp_path)
    _write_catalog(catalog_path, [
        {'canonical': 'THERMODOL', 'aliases': ['EFFERALGAN 1G'], 'category': 'dich_truyen',
         'default_volume_ml': 100, 'default_rate': '100'},
    ])

    added, updated = medication_catalog.sync_catalog_from_processed_records(
        _records_with_infusion('EFFERALGAN 1G', 500)
    )

    assert (added, updated) == (0, 1)
    saved = json.loads(catalog_path.read_text(encoding='utf-8'))
    assert len(saved['medications']) == 1
    assert saved['medications'][0]['canonical'] == 'THERMODOL'
    assert saved['medications'][0]['default_volume_ml'] == 500


def test_sync_skips_items_without_valid_volume(monkeypatch, tmp_path):
    catalog_path = _patch_catalog_path(monkeypatch, tmp_path)
    original = [
        {'canonical': 'THERMODOL', 'category': 'dich_truyen', 'default_volume_ml': 100, 'default_rate': '100'},
    ]
    _write_catalog(catalog_path, original)

    records = [{
        'ma_bn': 'BN001', 'ngay_lam': '17/09/2026',
        'thuoc': {'dich_truyen': [
            {'ten_thuoc': 'THERMODOL', 'the_tich': ''},
            {'ten_thuoc': 'UNKNOWN_NO_VOLUME', 'the_tich': 0},
        ]},
    }]
    added, updated = medication_catalog.sync_catalog_from_processed_records(records)

    assert (added, updated) == (0, 0)
    saved = json.loads(catalog_path.read_text(encoding='utf-8'))
    assert saved['medications'] == original


def test_sync_no_op_when_volume_already_matches(monkeypatch, tmp_path):
    catalog_path = _patch_catalog_path(monkeypatch, tmp_path)
    _write_catalog(catalog_path, [
        {'canonical': 'THERMODOL', 'category': 'dich_truyen', 'default_volume_ml': 100, 'default_rate': '100'},
    ])
    before_mtime = catalog_path.stat().st_mtime_ns

    added, updated = medication_catalog.sync_catalog_from_processed_records(
        _records_with_infusion('THERMODOL', 100, '100')
    )

    assert (added, updated) == (0, 0)
    assert catalog_path.stat().st_mtime_ns == before_mtime


def test_sync_does_not_overwrite_drug_edited_by_hand(monkeypatch, tmp_path):
    # Người dùng sửa thể tích trên Danh mục thuốc; lần xử lý sau không được ghi đè im lặng.
    catalog_path = _patch_catalog_path(monkeypatch, tmp_path)
    _write_catalog(catalog_path, [
        {'canonical': 'THERMODOL', 'category': 'dich_truyen', 'default_volume_ml': 100, 'default_rate': '100', 'sua_tay': True},
    ])

    added, updated = medication_catalog.sync_catalog_from_processed_records(_records_with_infusion('THERMODOL', 250, '60'))

    assert (added, updated) == (0, 0)
    med = json.loads(catalog_path.read_text(encoding='utf-8'))['medications'][0]
    assert med['default_volume_ml'] == 100 and med['default_rate'] == '100'


def test_sync_skips_diluted_and_inferred_lines(monkeypatch, tmp_path):
    # Thuốc pha truyền: tên "X + Natri clorid 0.9%" và thể tích pha không phải dữ kiện của thuốc
    # → không sinh mục rác, không tự học lại thể tích do chính hệ thống suy ra.
    catalog_path = _patch_catalog_path(monkeypatch, tmp_path)
    _write_catalog(catalog_path, [])
    records = [{'ma_bn': 'BN001', 'ngay_lam': '17/09/2026', 'thuoc': {'dich_truyen': [
        {'ten_thuoc': 'BIRONEM 500', 'ten_hien_thi': 'BIRONEM 500 + Natri clorid 0.9%', 'the_tich': 100, 'dung_moi': 'NACL_0.9'},
        {'ten_thuoc': 'THUOC Y', 'the_tich': 100, 'nguon_pha': 'mac_dinh'},
    ]}}]

    assert medication_catalog.sync_catalog_from_processed_records(records) == (0, 0)
    assert json.loads(catalog_path.read_text(encoding='utf-8'))['medications'] == []
