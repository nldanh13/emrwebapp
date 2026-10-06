# -*- coding: utf-8 -*-
"""Bộ y lệnh mẫu phủ mọi thuốc nằm trong các danh sách kiến thức thuốc (thể tích mặc định, dịch
truyền, tên khác, tên hiển thị, luật pha, từ dung môi…). Dùng để chứng minh việc gom các danh sách
về một nguồn KHÔNG đổi kết quả xử lý: tests/test_medication_golden.py so với file mốc.

Tạo lại file mốc (chỉ khi CỐ Ý đổi kết quả):  python tests/medication_golden_corpus.py --write
"""
import json
import os
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WORKER = os.path.join(ROOT, 'worker')
if WORKER not in sys.path:
    sys.path.insert(0, WORKER)

GOLDEN_FILE = os.path.join(os.path.dirname(__file__), 'fixtures', 'medication_golden.json')

T = '+ Thuốc:\n'
CORPUS = {
    # Dịch truyền theo tên / thể tích mặc định
    'thermodol': T + '(1) THERMODOL (Paracetamol) 1g x 3 (Chai)\nTiêm truyền tĩnh mạch 100 giọt/phút (8 giờ, 16 giờ, 23 giờ)',
    'thermodon_typo': '(TT) Thermodon 1g 01 chai x3 (TTM) 100g/p/8h',
    'paracetamol_chai': T + '(1) PARACETAMOL 1G/100ML (Paracetamol) 1g x 1 (Chai)\nTTM 100g/p 8h',
    'paracetamol_kabi': T + '(1) PARACETAMOL KABI 1000 (Paracetamol) 10mg/ml x 2 (Chai)\nTruyền tĩnh mạch 80 giọt/phút (8 giờ, 20 giờ)',
    'pharbacol': T + '(1) PHARBACOL (Paracetamol) 650mg x 2 (Viên)\nUống, chiều 1 viên, tối 1 viên.',
    'hapacol': T + '(1) HAPACOL 500 (Paracetamol) 500mg x 3 (Viên)\nUống 8h-16h-20h',
    'efferalgan': T + '(1) EFFERALGAN (Paracetamol) 500mg x 2 (Viên sủi)\nUống sáng tối',
    'koric': T + '(1) KORIC (Paracetamol) 1g x 1 (Chai)\nTTM 100 giọt/phút 8h',
    'degevic': T + '(1) DEGEVIC (Paracetamol + Tramadol) 325mg + 37,5mg x 2 (Viên)\nUống 8h 20h',
    'glucose5': T + '(1) GLUCOSE 5% (Glucose) 5% 500ml x 1 (Chai)\nTruyền tĩnh mạch 30 giọt/phút (8 giờ)',
    'glucose10_no_vol': T + '(1) GLUCOSE 10% (Glucose) 10% x 1 (Chai)\nTTM 40 giọt/phút 14h',
    'ringer': T + "(1) LACTATED RINGER'S (Ringer lactat) x 1 (Chai)\nTruyền tĩnh mạch 30 giọt/phút (8 giờ)",
    'cipro': T + '(1) CIPROFLOXACIN KABI (Ciprofloxacin) 200mg/100ml x 2 (Chai)\nTiêm truyền TM 30 giọt/phút (8 giờ, 20 giờ)',
    'ciprobid': T + '(1) CIPROBID (Ciprofloxacin) 400mg x 2 (Chai)\nTTM 40 giọt/phút 8h-20h',
    'levo': T + '(1) LEVOFLOXACIN (Levofloxacin) 750mg/150ml x 1 (Túi)\nTTM 40 giọt/phút 8h',
    'levo_no_vol': T + '(1) LEVOGOLDS (Levofloxacin) 500mg x 1 (Chai)\nTruyền TM 8h',
    'metro': T + '(1) METRONIDAZOL (Metronidazol) 500mg/100ml x 3 (Chai)\nTTM 60 giọt/phút 8h-16h-23h',
    'aminoleban': T + '(1) AMINOLEBAN (Acid amin) x 1 (Chai)\nTruyền tĩnh mạch 40g/p',
    'aminoplasmal': T + '(1) AMINOPLASMAL B.BRAUN 10% E (Acid amin) x 1 (Chai)\nTTM 30 giọt/phút 8h',
    'nephrosteril': T + '(1) NEPHROSTERIL (Acid amin) x 1 (Chai)\nTTM 20 giọt/phút 14h',
    'albunorm': T + '(1) ALBUNORM 20% (Albumin) 20% x 1 (Chai)\nTTM 20 giọt/phút 10h',
    'albumin': T + '(1) HUMAN ALBUMIN BAXTER (Albumin) 20% 50ml x 1 (Chai)\nTruyền TM 10h',
    'smof': T + '(1) SMOFLIPID 20% (Nhũ dịch lipid) 250ml x 1 (Chai)\nTTM 10 giọt/phút 20h',
    'kabiven': T + '(1) KABIVEN PERIPHERAL (Dinh dưỡng) 1440ml x 1 (Túi)\nTruyền TM 40 giọt/phút 8h',
    'linezolid': T + '(1) LINEZOLID KABI (Linezolid) 600mg/300ml x 2 (Túi)\nTTM 60 giọt/phút 8h-20h',
    'nacl500_standalone': T + '(1) NATRI CLORID 0,9% (Natri clorid) 0,9% 500ml x 1 (Chai)\nTruyền tĩnh mạch 30 giọt/phút (8 giờ)',
    'sodium500': T + '(1) SODIUM CHLORIDE INJECTION (Natri clorid) 0.9% 500ml x 1 (Chai)\nTTM 40 giọt/phút 8h',
    # Pha NaCl / luật pha
    'vanco_pha': '(TT) Vancomycin 1g\n01 lọ x2 pha Natri clorid 0,9% 100ml (TTM) XXX g/p 8h - 20h\n+ Thuốc:\n+ Thuốc:\n(4) NATRI CLORID 0,9% (Natri clorid 0,9%) 0,9% 100ml x 2 (Túi)\nPha vancomycin.',
    'vanco_200': T + '(1) VANCOMYCIN 1G (Vancomycin) 1g x 2 (Lọ)\nPha 200ml natriclorid X2 TTM 30 giọt/phút 8h-20h',
    'vanco_bare': '(TT) Vancomycin 1 g 01 lọ\nTTM 8h',
    'vecmid': T + '(1) VECMID 1GM (Vancomycin) 1g x 2 (Lọ)\nTiêm truyền tĩnh mạch (8 giờ, 20 giờ)',
    'merovia': T + '(1) MEROVIA 1G (Meropenem) 1g x 3 (Lọ)\nTiêm truyền tĩnh mạch (8 giờ, 16 giờ, 23 giờ)',
    'merovia_tmc': T + '(1) MEROVIA 1G (Meropenem) 1g x 3 (Lọ)\nTiêm tĩnh mạch chậm (8 giờ, 16 giờ, 23 giờ)',
    'tazocin': T + '(1) PIPERACILLIN/TAZOBACTAM 4,5G (Piperacillin + Tazobactam) 4,5g x 3 (Lọ)\nTTM 8h-16h-23h',
    'tazobactam_only': T + '(1) TAZOPELIN (Piperacillin + Tazobactam) 4g + 0,5g x 2 (Lọ)\nTiêm truyền 8h 20h',
    'colistimed': T + '(1) COLISTIMED (Colistin) 2MUI x 3 (Lọ)\nTTM 8h-16h-23h',
    'colistin': T + '(1) COLISTIN TZF (Colistin) 1MUI x 2 (Lọ)\nTiêm truyền 8h 20h',
    'nefopam': T + '(1) NEFOPAM MEDISOL 20MG/2ML (Nefopam) 20mg x 2 (Ống)\nTiêm 8h 20h',
    'nefopam_tb': T + '(1) NEFOPAM MEDISOL 20MG/2ML (Nefopam) 20mg x 1 (Ống)\nTiêm bắp 8h',
    'acupan': T + '(1) ACUPAN (Nefopam) 20mg x 2 (Ống)\nTiêm 8h 20h',
    'tramadol_tb': 'TRAMADOL x Hai (Ống)\nTiêm bắp 8-16 giờ',
    'tramadol_tiem': T + '(1) TRAMADOL 100MG/2ML (Tramadol) 100mg x 1 (Ống)\nTiêm 8h',
    'tramadol_ttm': T + '(1) TRASOLU (Tramadol) 100mg/2ml x 1 (Ống)\nPha natri clorid 0,9% TTM 30 giọt/phút 8h',
    'tramadol_free_nacl': T + '(1) TRAMADOL 100MG/2ML (Tramadol) 100mg x 1 (Ống)\nTiêm 8h\n(2) NATRI CLORID 0,9% (Natri clorid) 0,9% 100ml x 1 (Chai)\nTTM 8h',
    'bironem': T + '(1) BIRONEM 500 (Meropenem) 500mg x 3 (Lọ)\nPha natri clorid 0,9% 100ml TTM 20 giọt/phút 8h-16h-23h',
    'methylpred_inj': T + '(1) METHYLPREDNISOLON 40MG (Methylprednisolon) 40mg x 2 (Lọ)\nTiêm tĩnh mạch chậm 8h 20h',
    'solumedrol': T + '(1) SOLU-MEDROL 40MG (Methylprednisolon) 40mg x 1 (Lọ)\nTiêm TMC 8h',
    'methylpred_oral': T + '(1) METHYLPREDNISOLON 16MG (Methylprednisolon) 16mg x 1 (Viên)\nUống 8h',
    'cefoxitin_water': 'CEFOXITIN 1G x 4 (Lọ)\nTiêm tĩnh mạch chậm 8-16-20 giờ\n(2) NƯỚC CẤT PHA TIÊM 5ML (Nước cất) x 4 (Ống)\nPha thuốc',
    'ceftriaxone': T + '(1) CEFTRIAXONE 1G (Ceftriaxon natri) 1g x 2 (Lọ)\nTiêm tĩnh mạch chậm 8h 20h',
    'diclofenac_natri': 'Diclofenac Natri x 1 (Ống)\nTiêm bắp 8 giờ',
    'nacl_pha_two': T + '(1) CEFOPERAZONE 1G (Cefoperazon) 1g x 2 (Lọ)\nTTM 8h 20h\n(2) NATRI CLORID 0,9% (Natri clorid) 0,9% 100ml x 2 (Chai)\nDùng để pha thuốc 8h 20h',
    'nacl_flush': T + '(1) NATRI CLORID 0,9% 10ML (Natri clorid) 0,9% 10ml x 2 (Ống)\nTráng đường truyền 8h',
    'clastizol': T + '(1) CLASTIZOL (Acid Zoledronic) 5mg/100ml x 1 (Chai)\nTTM 30 giọt/phút 10h',
    'gemapaxane': 'Gemapaxane 40mg/0.4ml 01 ống (TDD) 8h',
    'cipazy': T + '(1) CIPAZY (Ciprofloxacin) 400mg x 2 (Chai)\nTTM 8h 20h',
    # Uống / khác
    'eperison': '(TT) Eperison 50mg 01 vx3 (u) 8h-16h-23h',
    'bisoprolol': T + '(1) BISOPROLOL 2.5MG TABLETS (Bisoprolol) 2,5mg x 1 (Viên)\n8h',
    'seretide': '(TT) Seretide 25/250 ug\n02 nhát x2 (hít) sáng tối',
    'triamcinolone': T + '(1) TRIAMCINOLONE (Triamcinolon) 0,1% x 1 (Tuýp)\nThoa ngoài da sáng tối',
    'methylcobalamin': 'methylcobalamin 500mg 01X2 viên uống 8h 16h',
    'vincynon': '((TT) Vincynon 02 ống\nTiêm mạch chậm 8h',
}


def _record(order_text):
    return {
        'Mã BN': 'GOLDEN', 'Họ tên': 'BN MAU', 'Bác sĩ': 'BS MAU', 'Vi_Tri': 'P01',
        'ngay_lam': '03/05/2026', 'Diễn biến': '',
        'Y lệnh': '08:00 | Bác sĩ: BS MAU\n+ Y lệnh khác:\n' + order_text,
    }


# Trường thay đổi theo lần chạy/máy, không phải kết quả xử lý.
VOLATILE = {'generated_at', 'processed_at', 'created_at', 'updated_at', 'warnings_file', 'source_file'}


def _strip(obj):
    if isinstance(obj, dict):
        return {k: _strip(v) for k, v in sorted(obj.items()) if k not in VOLATILE}
    if isinstance(obj, list):
        return [_strip(x) for x in obj]
    return obj


def run_corpus():
    from xu_ly import process_all
    out = {}
    old_cwd = os.getcwd()
    with tempfile.TemporaryDirectory() as tmp:
        os.chdir(tmp)  # process_all ghi file data v2 vào thư mục hiện tại
        try:
            for key, text in CORPUS.items():
                in_path = os.path.join(tmp, f'{key}.json')
                out_path = os.path.join(tmp, f'{key}_out.json')
                with open(in_path, 'w', encoding='utf-8') as f:
                    json.dump([_record(text)], f, ensure_ascii=False)
                process_all(in_path, output_file=out_path)
                with open(out_path, encoding='utf-8') as f:
                    rec = json.load(f)[0]
                out[key] = _strip({'thuoc': rec.get('thuoc'), 'y_lenh_khac': rec.get('y_lenh_khac')})
        finally:
            os.chdir(old_cwd)
    return out


if __name__ == '__main__':
    if '--write' in sys.argv:
        data = run_corpus()
        with open(GOLDEN_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=1, sort_keys=True)
        print(f'Đã ghi {len(data)} mẫu → {GOLDEN_FILE}')
