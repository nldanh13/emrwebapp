# -*- coding: utf-8 -*-
"""Thống kê cách pha thực tế: chạy lại đúng bước xử lý trên y lệnh trong Kho nghiên cứu."""
import csv
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'worker'))

VANCO_200 = '(1) VANCOMYCIN 1G (Vancomycin) 1g x 2 (Lọ)\nPha 200ml natriclorid X2 TTM 30 giọt/phút 8h-20h'
VANCO_BARE = '(1) VANCOMYCIN 1G (Vancomycin) 1g x 2 (Lọ)\nTiêm truyền tĩnh mạch (8 giờ, 20 giờ)'
ORAL = '(1) EPERISON 50MG (Eperison) 50mg x 2 (Viên)\nUống 8h-16h'


def _write_notes(path, rows):
    with open(path, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['patient_code', 'note_date', 'note_datetime', 'doctor_name', 'order_text'])
        w.writeheader()
        for i, (day, text) in enumerate(rows):
            w.writerow({'patient_code': f'BN{i}', 'note_date': day, 'note_datetime': f'{day} 08:00',
                        'doctor_name': 'BS', 'order_text': '+ Thuốc:\n' + text})


def test_counts_only_dilutions_written_in_orders(tmp_path):
    import dilution_stats
    notes = tmp_path / 'clinical_notes.csv'
    _write_notes(notes, [('2026-09-01', VANCO_200), ('2026-09-02', VANCO_200), ('2026-09-03', VANCO_200),
                         ('2026-09-04', VANCO_BARE), ('2026-09-05', ORAL)])
    out = tmp_path / 'out.json'
    sys.argv = ['dilution_stats.py', '--out', str(out), '--notes', str(notes)]
    assert dilution_stats.main() == 0
    data = json.loads(out.read_text(encoding='utf-8'))
    assert data['sources'][0] == {'kind': 'kho_nghien_cuu', 'notes': 4, 'days': 4}  # dòng uống bị lọc trước
    vanco = next(d for d in data['drugs'] if d['drug'] == 'VANCOMYCIN')
    assert vanco['in_catalog'] is True
    top = vanco['observed'][0]
    assert top['volume_ml'] == 200.0 and top['dose_mg'] == 1000.0 and top['solvent'] == 'NACL_0.9'
    assert vanco['observed_total'] == sum(o['count'] for o in vanco['observed'])
    # Ngày 04 không ghi thể tích → hệ thống tự suy, KHÔNG được tính là "thực tế".
    assert vanco['inferred'] >= 1
    assert vanco['observed_total'] < vanco['total']


def test_processed_file_source(tmp_path):
    import dilution_stats
    processed = tmp_path / 'DuLieu_PhanLoai.json'
    processed.write_text(json.dumps([{'thuoc': {'dich_truyen': [
        {'ten_thuoc': 'MEROVIA 1G', 'dung_moi': 'NACL_0.9', 'the_tich': 100, 'nguon_pha': 'y_lenh',
         'duong_dung_goc': 'Pha natri clorid 0,9% 100ml TTM', 'so_luong': '3', 'gio_dung': '8 giờ, 16 giờ, 23 giờ'},
        {'ten_thuoc': 'MEROVIA 1G', 'dung_moi': 'NACL_0.9', 'the_tich': 100, 'nguon_pha': 'luat_san_co'},
    ]}}]), encoding='utf-8')
    out = tmp_path / 'out.json'
    sys.argv = ['dilution_stats.py', '--out', str(out), '--processed', str(processed)]
    assert dilution_stats.main() == 0
    mero = json.loads(out.read_text(encoding='utf-8'))['drugs'][0]
    assert mero['total'] == 2 and mero['observed_total'] == 1 and mero['inferred'] == 1
    assert mero['observed'][0] == {'solvent': 'NACL_0.9', 'volume_ml': 100.0, 'route': 'TTM', 'dose_mg': 1000.0, 'count': 1}
