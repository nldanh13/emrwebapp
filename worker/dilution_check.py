# -*- coding: utf-8 -*-
"""Kiểm tra quy tắc pha thuốc cho màn Danh mục thuốc.

Chạy ĐÚNG hàm bước xử lý dữ liệu dùng (infer_and_reclassify_diluents, effective_dilution) để
kết quả xem trước khớp kết quả xử lý thật (CLAUDE.md: xem trước và lưu dùng chung một hàm).

    python dilution_check.py --in vao.json --out ra.json

vao.json: {"items": [{"ten_thuoc", "hoat_chat"?, "dang"?, "duong_dung_goc"?, "gio_dung"?}],
           "catalog_names": ["VANCOMYCIN", ...]}
ra.json:  {"items": [...kết quả...], "catalog": {tên: {rule, source}}, "builtin": [...]}
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from processing.diluent_resolver import infer_and_reclassify_diluents  # noqa: E402
from xu_ly_config import builtin_dilution_rules, effective_dilution  # noqa: E402

FIELDS = ("ten_thuoc", "hoat_chat", "dang", "duong_dung_goc", "gio_dung", "toc_do", "so_luong")


def _clean_rule(rule):
    if not rule:
        return None
    return {k: rule.get(k) for k in ("solvent", "volume_ml", "apply", "rate", "note", "canonical", "matched_by", "keyword", "variants") if rule.get(k) not in (None, "", [])}


def check_item(raw):
    drug = {k: str(raw.get(k) or "").strip() for k in FIELDS if str(raw.get(k) or "").strip()}
    if not drug.get("ten_thuoc"):
        return {"error": "Chưa nhập tên thuốc."}
    drug.setdefault("gio_dung", "8 giờ")
    drug.setdefault("so_luong", "1")
    infusions, injections = infer_and_reclassify_diluents([], [dict(drug)])
    out = (infusions + injections)[0] if (infusions or injections) else drug
    rule, source = effective_dilution(f"{drug.get('ten_thuoc', '')} {drug.get('hoat_chat', '')}")
    return {
        "input": drug,
        "rule": _clean_rule(rule),
        "rule_source": source,
        "moved_to_infusion": bool(infusions),
        "dung_moi": out.get("dung_moi") or "",
        "the_tich": out.get("the_tich") if out.get("dung_moi") else None,
        "toc_do": out.get("toc_do") or "",
        "toc_do_nguon": out.get("toc_do_nguon") or "",
        "nguon_pha": out.get("nguon_pha") or "",
        "ten_hien_thi": out.get("ten_hien_thi") or drug.get("ten_thuoc"),
        "quy_tac_pha": out.get("quy_tac_pha") or "",
        "duong_dung": out.get("duong_dung") or "",
        "cach_pha": out.get("cach_pha") or "",
        "can_xac_nhan_pha": bool(out.get("can_xac_nhan_pha")),
        "ly_do_xac_nhan_pha": out.get("ly_do_xac_nhan_pha") or "",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", dest="out", required=True)
    args = ap.parse_args()
    with open(args.inp, "r", encoding="utf-8") as f:
        payload = json.load(f) or {}
    items = [check_item(x) for x in (payload.get("items") or [])[:50] if isinstance(x, dict)]
    catalog = {}
    for name in (payload.get("catalog_names") or [])[:2000]:
        rule, source = effective_dilution(str(name or ""))
        catalog[str(name)] = {"rule": _clean_rule(rule), "source": source}
    result = {"items": items, "catalog": catalog, "builtin": [_clean_rule(r) | {"nguon": r.get("nguon")} for r in builtin_dilution_rules()]}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
