# -*- coding: utf-8 -*-
import json
import os
import tempfile

from conftest import make_record
from data_contract import DATA_CONTRACT_VERSION, patient_day_key
from xu_ly import process_all
from processing.validators.sanity_check import run_sanity_checks


def _run(records):
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', encoding='utf-8', delete=False) as f:
        json.dump(records, f, ensure_ascii=False)
        in_path = f.name
    out_path = in_path.replace('.json', '_out.json')
    try:
        process_all(in_path, output_file=out_path)
        with open(out_path, encoding='utf-8') as f:
            return json.load(f)
    finally:
        for fp in (in_path, out_path, out_path.replace('.json', '_warnings.json')):
            try:
                os.unlink(fp)
            except OSError:
                pass


def test_output_has_sync_contract_and_vtyt():
    rows = _run([
        make_record(
            ma_bn='BN001',
            ngay_lam='09/05/2026',
            y_lenh=(
                '08:00 | Bác sĩ: Test\n'
                '+ Thuốc:\n'
                'LEVOFLOXACIN 750MG/150ML (Levofloxacin) x 1 (Chai)\n'
                'Tiêm truyền 40g/p, 1 ngày, sáng 1 chai, Liều dùng 1(8 giờ).\n'
            ),
            dien_bien='08:00 | Bác sĩ: Test\nNgười bệnh tỉnh\n'
        )
    ])
    assert rows
    r = rows[0]
    assert r['schema_version'] == DATA_CONTRACT_VERSION
    assert r['patient_day_key'] == 'BN001::2026-05-09'
    assert r['sync_key'] == r['patient_day_key']
    assert r.get('order_signature')
    assert r.get('_meta', {}).get('schema_version') == DATA_CONTRACT_VERSION
    assert r.get('vtyt', {}).get('source') == 'auto_rules_v1'
    assert any(x.get('key') == 'DAY_TRUYEN_DICH' for x in r.get('vtyt', {}).get('items', []))


def test_tramadol_pha_nacl_is_not_missing_usage():
    rows = _run([
        make_record(
            ma_bn='BNTRAM',
            ngay_lam='09/05/2026',
            y_lenh=(
                '01:00 | Bác sĩ: Test\n'
                '+ Thuốc:\n'
                'TRAMADOL-HAMELN50MG/ ML (Tramadol HCl) x Hai (Ống)\n'
                'Pha NaCl 0.9% x2 TTM 30g/ph (10 giờ, 18 giờ).\n'
            ),
            dien_bien='01:00 | Bác sĩ: Test\nNgười bệnh tỉnh\n'
        )
    ])
    assert rows
    r = rows[0]
    assert not any(u.get('ten_thuoc') == 'TRAMADOL-HAMELN50MG/ ML' for u in r.get('unparsed_orders', []))
    infusions = r.get('thuoc', {}).get('dich_truyen', [])
    assert any('TRAMADOL' in (x.get('ten_thuoc') or '').upper() for x in infusions)


def test_sanity_ignores_valid_skipped_medication():
    record = {
        'ngay_lam': '08/05/2026',
        'ma_bn': 'BN_SKIP',
        'ho_ten': 'TEST',
        'so_phong': 'P01',
        'gio_y_lenh': '20:00',
        'nhap_cham_soc': {
            'dien_bien': 'CTCH nhận bệnh lúc 23:00',
            'y_lenh': 'THERMODOL (Paracetamol) 1g x 1 (Lọ)\nTiêm truyền TM 100g/p, 1 ngày, tối 1 lọ(21 giờ).',
        },
        'thuoc': {'dich_truyen': [], 'thuoc_tiem': [], 'thuoc_uong': [], 'thuoc_tra': [], 'khac': []},
        'rule_log': {
            'skipped_medications': [
                {'category': 'dich_truyen', 'ten_thuoc': 'THERMODOL', 'reason': 'exec<23:00'}
            ]
        }
    }
    warnings = run_sanity_checks([record])
    codes = {w.get('code') for w in warnings}
    assert 'INFUSION_TEXT_BUT_EMPTY' not in codes
    assert 'MEDICATION_TEXT_BUT_NO_MED' not in codes
    assert 'CATALOG_MEDICATION_TEXT_NOT_PARSED' not in codes
