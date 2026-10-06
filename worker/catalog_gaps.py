# -*- coding: utf-8 -*-
"""Thuốc xuất hiện trong dữ liệu nhưng CHƯA có trong Danh mục thuốc (để người dùng thiết lập).

Khớp bằng ĐÚNG hàm tra danh mục của bước xử lý (lookup_medication_with_meta, chỉ khớp chính xác —
không khớp gần đúng, vì thuốc khớp gần đúng vẫn nên được người dùng xem lại). Không mở EMR.

Nguồn:
  --processed  dữ liệu đã xử lý của phiên (DuLieu_PhanLoai.json): có đủ tên, hoạt chất, đường dùng, dạng, thể tích.
  --orders     medication_orders.csv của Kho nghiên cứu (y lệnh thuốc đã tách dòng).

    python catalog_gaps.py --out ra.json [--processed a.json] [--orders medication_orders.csv]
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

SKIP_NAME = re.compile(r'^(?:natri\s*cl?orid|sodium\s*chlorid|nacl|n[uư][oớ]c\s*c[aấ]t)\b', re.IGNORECASE)


def base_name(name):
    s = re.sub(r'^\(+\s*TT\s*\)\s*', '', str(name or ''), flags=re.IGNORECASE)
    s = re.sub(r'\(\s*\d+\s*(?:lọ|ống|chai|túi|viên|gói)\s*\)', '', s, flags=re.IGNORECASE)
    s = s.split(' + ')[0]
    return re.sub(r'\s+', ' ', s).strip()


def norm_key(name):
    from processing.medication_catalog import normalize_key
    return normalize_key(base_name(name))


class Gap:
    def __init__(self):
        self.count = 0
        self.names = collections.Counter()
        self.categories = collections.Counter()
        self.routes = collections.Counter()
        self.forms = collections.Counter()
        self.ingredients = collections.Counter()
        self.volumes = collections.Counter()
        self.sources = set()
        self.last_seen = ''

    def to_json(self, key):
        top = lambda c: c.most_common(1)[0][0] if c else ''
        return {
            'key': key, 'name': top(self.names), 'count': self.count,
            'variants': [n for n, _ in self.names.most_common(8)],
            'category': top(self.categories), 'categories': dict(self.categories.most_common()),
            'route': top(self.routes), 'routes': dict(self.routes.most_common()),
            'form': top(self.forms), 'ingredient': top(self.ingredients),
            'volume_ml': top(self.volumes) or None,
            'sources': sorted(self.sources), 'last_seen': self.last_seen,
        }


def _iso(day):
    m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})', str(day or ''))
    if m:
        return f'{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}'
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})', str(day or ''))
    return m.group(0) if m else ''


def collect(gaps, *, name, source, day='', category='', route='', form='', ingredient='', volume=None, hoat_chat_text=''):
    from processing.medication_catalog import lookup_medication_with_meta
    raw = base_name(name)
    if not raw or len(raw) < 3 or SKIP_NAME.match(raw):
        return
    med, _meta = lookup_medication_with_meta({'ten_thuoc': raw, 'hoat_chat': hoat_chat_text}, allow_semantic=False)
    if med:
        return
    key = norm_key(raw)
    if not key:
        return
    g = gaps.setdefault(key, Gap())
    g.count += 1
    g.names[raw] += 1
    if category:
        g.categories[category] += 1
    if route:
        g.routes[route] += 1
    if form:
        g.forms[form] += 1
    if ingredient:
        g.ingredients[ingredient] += 1
    if volume:
        g.volumes[volume] += 1
    g.sources.add(source)
    iso = _iso(day)
    if iso > g.last_seen:
        g.last_seen = iso


def from_processed(gaps, path):
    from processing.route_table import normalize_route_code
    with open(path, 'r', encoding='utf-8') as f:
        records = json.load(f)
    for rec in records if isinstance(records, list) else []:
        thuoc = (rec or {}).get('thuoc') or {}
        for cat, items in thuoc.items():
            if cat == 'thuoc_tra':
                continue
            for d in items or []:
                if not isinstance(d, dict):
                    continue
                vol = None
                try:
                    v = float(d.get('the_tich') or 0)
                    vol = v if cat == 'dich_truyen' and v >= 50 and not d.get('dung_moi') else None
                except (TypeError, ValueError):
                    pass
                collect(gaps, name=d.get('ten_thuoc'), source='du_lieu_phien', day=rec.get('ngay_lam', ''),
                        category=cat, route=normalize_route_code(d.get('duong_dung')) or '',
                        form=str(d.get('dang') or '').split('/')[0].strip(), ingredient=str(d.get('hoat_chat') or '').strip(),
                        volume=vol, hoat_chat_text=str(d.get('hoat_chat') or ''))


def from_orders(gaps, path, limit):
    from processing.route_table import normalize_route_code
    with open(path, 'r', encoding='utf-8-sig', newline='') as f:
        for i, row in enumerate(csv.DictReader(f)):
            if i >= limit:
                break
            collect(gaps, name=row.get('drug_name_raw'), source='kho_nghien_cuu', day=row.get('order_date', ''),
                    route=normalize_route_code(row.get('route_norm')) or '', ingredient=str(row.get('active_ingredient') or '').strip(),
                    hoat_chat_text=str(row.get('active_ingredient') or ''))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--processed', default='')
    ap.add_argument('--orders', default='')
    ap.add_argument('--max-orders', type=int, default=200000)
    args = ap.parse_args()
    gaps = {}
    if args.processed and os.path.exists(args.processed):
        try:
            from_processed(gaps, args.processed)
        except Exception as exc:
            print(f'[WARN] Không đọc được dữ liệu đã xử lý: {exc}', file=sys.stderr)
    if args.orders and os.path.exists(args.orders):
        from_orders(gaps, args.orders, args.max_orders)
    items = sorted((g.to_json(k) for k, g in gaps.items()), key=lambda x: (-x['count'], x['name']))
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump({'drugs': items[:500], 'total': len(items)}, f, ensure_ascii=False)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
