# -*- coding: utf-8 -*-
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

from result_schema import build_worker_result
from runtime_maint import canonical_patient_day_key, run_health, migrate_file
from runtime_data_v2 import generate_runtime_v2_files


def test_worker_result_splits_succeeded_failed_skipped():
    result = build_worker_result({
        'BN001::2026-05-01': {'success': True},
        'BN002::2026-05-01': {'success': True, 'skipped': True, 'reason': 'Đã có phiếu'},
        'BN003::2026-05-01': {'success': False, 'error': 'Không mở được hồ sơ'},
    })
    assert result['succeeded'] == ['BN001::2026-05-01']
    assert result['failed'] == {'BN003::2026-05-01': 'Không mở được hồ sơ'}
    assert result['skipped'] == {'BN002::2026-05-01': 'Đã có phiếu'}
    assert result['summary']['skipped_count'] == 1


def test_runtime_maint_canonicalizes_patient_day_key():
    assert canonical_patient_day_key('BN001::01/05/2026') == 'BN001::2026-05-01'
    assert canonical_patient_day_key('BN001::01/05/2026::08:00') == 'BN001::2026-05-01::08:00'


def test_generate_health_and_migrate_runtime(tmp_path: Path):
    data_dir = tmp_path / 'data'
    state_dir = tmp_path / 'state'
    data_dir.mkdir()
    state_dir.mkdir()
    (data_dir / '01_raw_patient_rows.json').write_text(json.dumps([
        {'ma_bn': 'BN001', 'ho_ten': 'A', 'ngay_lam': '01/05/2026'},
    ], ensure_ascii=False), encoding='utf-8')
    (data_dir / '02_selected_patient_rows.json').write_text(json.dumps([
        {'ma_bn': 'BN001', 'ho_ten': 'A', 'ngay_lam': '01/05/2026'},
    ], ensure_ascii=False), encoding='utf-8')
    (data_dir / '03_order_text_by_patient_day.json').write_text(json.dumps([
        {'ma_bn': 'BN001', 'ngay_lam': '01/05/2026', 'Y lệnh': 'YL', 'Diễn biến': ''},
    ], ensure_ascii=False), encoding='utf-8')
    done = state_dir / 'care_done.json'
    done.write_text(json.dumps({'items': {'BN001::01/05/2026': {'status': 'done'}}}, ensure_ascii=False), encoding='utf-8')

    indexes = generate_runtime_v2_files(tmp_path)
    assert indexes['patients_count'] == 1
    health_before = run_health(tmp_path)
    assert any(w['code'] == 'legacy_dmy_keys' for w in health_before['warnings'])

    migrated = migrate_file(done)
    assert migrated['changed'] >= 1
    payload = json.loads(done.read_text(encoding='utf-8'))
    assert 'BN001::2026-05-01' in payload['items']
