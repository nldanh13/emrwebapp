# -*- coding: utf-8 -*-
"""Thống kê cách pha THỰC TẾ của từng thuốc trong dữ liệu đã có (không mở EMR).

Nguồn:
  --notes      clinical_notes.csv của Kho nghiên cứu (cột order_text = nguyên văn y lệnh từng ngày):
               chạy lại ĐÚNG bước xử lý thuốc (build_patient_day_records) để biết thuốc được pha thế nào.
  --processed  dữ liệu đã xử lý của phiên (DuLieu_PhanLoai.json).

Chỉ đếm là "thực tế" khi dung môi/thể tích lấy từ y lệnh hoặc túi Natri clorid cùng giờ; phần hệ
thống tự suy (danh mục, luật sẵn có, mặc định) đếm riêng, để không tự học lại chính điều mình đoán.

    python dilution_stats.py --out ra.json [--notes clinical_notes.csv] [--processed a.json ...]
"""
import argparse
import collections
import csv
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
csv.field_size_limit(min(sys.maxsize, 2 ** 31 - 1))

OBSERVED = {'y_lenh', 'tui_cung_gio'}
INJECTABLE_HINT = re.compile(r'truy[eề]n|ttm|pha|natri|nacl|sodium|l[oọ]\b|b[ơo]m ti[eê]m|tmc|ti[eê]m', re.IGNORECASE)
MED_LISTS = ('dich_truyen', 'thuoc_tiem')


def _dmy(value):
    s = str(value or '').strip()
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})', s)
    if m:
        return f'{m.group(3)}/{m.group(2)}/{m.group(1)}'
    m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})', s)
    return f'{int(m.group(1)):02d}/{int(m.group(2)):02d}/{m.group(3)}' if m else ''


def _hhmm(value):
    m = re.search(r'(\d{1,2}):(\d{2})', str(value or ''))
    return f'{int(m.group(1)):02d}:{m.group(2)}' if m else '08:00'


def read_notes(path, limit):
    """Ghi chú có nhắc tới thuốc tiêm/truyền, gom theo ngày (bước xử lý lấy ngày làm việc của đợt)."""
    by_date = collections.defaultdict(list)
    count = 0
    with open(path, 'r', encoding='utf-8-sig', newline='') as f:
        for row in csv.DictReader(f):
            text = str(row.get('order_text') or '').strip()
            day = _dmy(row.get('note_date') or row.get('note_datetime'))
            if not text or not day or not INJECTABLE_HINT.search(text):
                continue
            by_date[day].append({
                'Mã BN': str(row.get('patient_code') or row.get('research_code') or 'X'),
                'Họ tên': '', 'Bác sĩ': str(row.get('doctor_name') or ''), 'Vi_Tri': '', 'ngay_lam': day,
                'Diễn biến': '',
                'Y lệnh': f"{_hhmm(row.get('note_datetime'))} | Bác sĩ: {row.get('doctor_name') or ''}\n+ Y lệnh khác:\n{text}",
            })
            count += 1
            if count >= limit:
                break
    return by_date, count


def process_notes(by_date):
    from processing.patient_day_builder import build_patient_day_records
    out = []
    for _day, records in sorted(by_date.items()):
        try:
            out.extend(build_patient_day_records(records) or [])
        except Exception as exc:  # một ngày lỗi không làm hỏng cả thống kê
            print(f'[WARN] Bỏ qua một ngày không xử lý được: {exc}', file=sys.stderr)
    return out


def drug_key(drug):
    """Gom theo tên chuẩn Danh mục thuốc nếu khớp chính xác, không thì theo tên gốc (bỏ phần pha)."""
    from processing.medication_catalog import lookup_medication_with_meta
    base = re.sub(r'\(\s*\d+\s*(?:lọ|ống|chai|túi|viên)\s*\)', '', str(drug.get('ten_thuoc') or ''), flags=re.IGNORECASE)
    base = base.split('+')[0].strip()
    med, _meta = lookup_medication_with_meta({'ten_thuoc': base}, allow_semantic=False)
    if med and med.get('canonical'):
        return med['canonical'], True
    return re.sub(r'\s+', ' ', base.upper()), False


def aggregate(records):
    from processing.dose import dose_mg_per_administration
    from processing.route_table import detect_route_code
    stats = {}
    for rec in records or []:
        thuoc = (rec or {}).get('thuoc') or {}
        for cat in MED_LISTS:
            for drug in thuoc.get(cat) or []:
                if not isinstance(drug, dict) or not drug.get('ten_thuoc'):
                    continue
                key, in_catalog = drug_key(drug)
                s = stats.setdefault(key, {'drug': key, 'in_catalog': in_catalog, 'total': 0, 'routes': collections.Counter(),
                                           'observed': collections.Counter(), 'inferred': 0, 'flagged': 0, 'no_solvent': 0})
                s['total'] += 1
                route = detect_route_code(str(drug.get('duong_dung_goc') or '')) or str(drug.get('duong_dung') or '')
                s['routes'][route or '?'] += 1
                solvent = drug.get('dung_moi')
                if not solvent:
                    s['no_solvent'] += 1
                    continue
                source = drug.get('nguon_pha') or ('' if drug.get('suy_luan_dung_moi') else 'y_lenh')
                if drug.get('can_xac_nhan_pha'):
                    s['flagged'] += 1
                if source not in OBSERVED:
                    s['inferred'] += 1
                    continue
                # Bước xử lý ghi liều mỗi lần trước khi tách mỗi cữ một dòng; dữ liệu cũ không có thì tự tính.
                dose = drug.get('lieu_moi_lan_mg')
                if dose is None:
                    hours = len(re.findall(r'\d+\s*gi', str(drug.get('gio_dung') or ''))) or None
                    dose = dose_mg_per_administration(drug, hours)
                vol = drug.get('tui_dich_truyen_ml') or drug.get('the_tich')
                try:
                    vol = float(vol) if vol else None
                except (TypeError, ValueError):
                    vol = None
                s['observed'][(solvent, vol, route, dose)] += 1
    result = []
    for s in stats.values():
        result.append({
            'drug': s['drug'], 'in_catalog': s['in_catalog'], 'total': s['total'],
            'routes': dict(s['routes'].most_common()),
            'observed': [
                {'solvent': 'NACL_0.9' if sol == 'SODIUM_0.9' else sol, 'volume_ml': vol, 'route': route, 'dose_mg': dose, 'count': n}
                for (sol, vol, route, dose), n in s['observed'].most_common(12)
            ],
            'observed_total': sum(s['observed'].values()),
            'inferred': s['inferred'], 'flagged': s['flagged'], 'no_solvent': s['no_solvent'],
        })
    result.sort(key=lambda x: (-x['total'], x['drug']))
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--notes', default='')
    ap.add_argument('--processed', nargs='*', default=[])
    ap.add_argument('--max-notes', type=int, default=20000)
    args = ap.parse_args()
    records, sources = [], []
    if args.notes and os.path.exists(args.notes):
        by_date, n = read_notes(args.notes, args.max_notes)
        records.extend(process_notes(by_date))
        sources.append({'kind': 'kho_nghien_cuu', 'notes': n, 'days': len(by_date)})
    for path in args.processed:
        if path and os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                if isinstance(data, list):
                    records.extend(data)
                    sources.append({'kind': 'du_lieu_phien', 'records': len(data)})
            except Exception as exc:
                print(f'[WARN] Không đọc được dữ liệu đã xử lý: {exc}', file=sys.stderr)
    drugs = aggregate(records)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump({'sources': sources, 'drugs': drugs[:400]}, f, ensure_ascii=False)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
