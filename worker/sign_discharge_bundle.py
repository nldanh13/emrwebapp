# -*- coding: utf-8 -*-
"""worker/sign_discharge_bundle.py — Chèn ảnh chữ ký lên bộ phiếu "IN RA VIỆN"
(xem ward_print_discharge_bundle.py) tại mọi chỗ tên điều dưỡng/bác sĩ xuất
hiện trong các cột kiểu "Ký và ghi tên" / "Điều dưỡng thực hiện" / "Tên ĐD",
CHỈ với những người đã cấu hình sẵn ảnh chữ ký (tab Lịch điều dưỡng — xem
worker/nurse_emr_accounts.py: trường signature_file). Người chưa cấu hình
chữ ký thì giữ nguyên, không đụng tới.

Cách khớp vị trí: dùng PyMuPDF (fitz) search_for() để tìm đúng cụm tên trên
từng trang (PDF có lớp chữ thật, không phải ảnh scan), rồi chèn ảnh ngay
phía trên vùng chữ đó — bù hình chữ nhật của chữ (quad) sẽ cho biết cả
trường hợp chữ bị xoay dọc 90° (như cột "Ký và ghi tên" ở phiếu chức năng
sống) lẫn chữ nằm ngang bình thường (phiếu chăm sóc/truyền dịch), công thức
kích thước/khoảng cách đã đối chiếu khớp với 1 bản mẫu do người dùng cung
cấp.

Giới hạn đã biết: tìm theo khớp chuỗi con trên toàn trang, không giới hạn
theo đúng cột "ký tên" — nếu tên một người trùng lặp/là chuỗi con của một
đoạn văn bản khác trên phiếu (hiếm với họ tên đầy đủ 3-4 từ) có thể bị chèn
nhầm chỗ. Xử lý tên dài trước để tên ngắn không "ăn theo" vị trí đã khớp bởi
tên dài hơn chứa nó.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nurse_emr_accounts import load_nurse_signature_rows  # noqa: E402

try:
    import fitz  # PyMuPDF
except Exception:
    fitz = None


def _json_out(path: str, payload: Dict[str, Any]) -> None:
    if not path:
        return
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + f".tmp-{os.getpid()}")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)


def _image_aspect_ratio(img_path: str) -> float:
    """Tỉ lệ rộng/cao của ảnh chữ ký gốc, dùng để giữ đúng tỉ lệ khi chèn."""
    try:
        with fitz.open(img_path) as img_doc:
            page = img_doc[0]
            w, h = page.rect.width, page.rect.height
            if w and h:
                return w / h
    except Exception:
        pass
    return 2.2  # fallback hợp lý cho chữ ký dạng nét ngang


# Khoảng cách (pt) giữa mép trên của chữ và mép dưới của ảnh chữ ký.
_STAMP_GAP = 2.0
# Hệ số phóng bề dày chữ ký so với bề dày dòng chữ, và biên trên/dưới (pt).
_HORIZ_THICKNESS_FACTOR = 1.2
_HORIZ_THICKNESS_MIN, _HORIZ_THICKNESS_MAX = 8.0, 26.0
_VERT_THICKNESS_FACTOR = 1.35
_VERT_THICKNESS_MIN, _VERT_THICKNESS_MAX = 8.0, 20.0


def _is_vertical_quad(rect: "fitz.Rect") -> bool:
    """Chữ bị xoay dọc 90° (cột 'Ký và ghi tên') có bbox cao hơn nhiều so với rộng."""
    return rect.height > rect.width * 1.3


def _rects_overlap(a: "fitz.Rect", b: "fitz.Rect", threshold: float = 0.5) -> bool:
    """True nếu 2 vùng chữ chồng lấn đáng kể (vùng giao >= threshold lần vùng
    nhỏ hơn) — dùng để nhận ra tên A là chuỗi con của tên B đã khớp trước đó."""
    inter = a & b
    if inter.is_empty:
        return False
    min_area = min(a.get_area(), b.get_area())
    if min_area <= 0:
        return False
    return (inter.get_area() / min_area) >= threshold


def _stamp_rect_for(rect: "fitz.Rect", aspect: float) -> Tuple["fitz.Rect", bool]:
    """Tính hình chữ nhật để chèn ảnh chữ ký ngay phía trên `rect` (bbox chữ),
    và có cần xoay ảnh 90° hay không. Căn giữa theo trục ngang của `rect`."""
    cx = (rect.x0 + rect.x1) / 2
    vertical = _is_vertical_quad(rect)
    if vertical:
        thickness = min(max(rect.width * _VERT_THICKNESS_FACTOR, _VERT_THICKNESS_MIN), _VERT_THICKNESS_MAX)
        length = thickness * aspect
        y1 = rect.y0 - _STAMP_GAP
        y0 = y1 - length
        return fitz.Rect(cx - thickness / 2, y0, cx + thickness / 2, y1), True
    thickness = min(max(rect.height * _HORIZ_THICKNESS_FACTOR, _HORIZ_THICKNESS_MIN), _HORIZ_THICKNESS_MAX)
    length = thickness * aspect
    y1 = rect.y0 - _STAMP_GAP
    y0 = y1 - thickness
    return fitz.Rect(cx - length / 2, y0, cx + length / 2, y1), False


def sign_bundle(in_pdf: str, out_pdf: str) -> Dict[str, Any]:
    if fitz is None:
        return {"status": "error", "message": "Thiếu thư viện PyMuPDF trên máy chủ (pip install pymupdf)."}
    if not in_pdf or not os.path.isfile(in_pdf):
        return {"status": "error", "message": f"Không tìm thấy file PDF: {in_pdf}"}

    sig_rows = load_nurse_signature_rows()
    if not sig_rows:
        return {
            "status": "error",
            "message": "Chưa cấu hình ảnh chữ ký cho điều dưỡng/bác sĩ nào (tab Lịch điều dưỡng).",
        }
    # Tên dài xử lý trước để không bị tên ngắn hơn "ăn theo" cùng vị trí
    # (trường hợp tên A là chuỗi con của tên B).
    sig_rows = sorted(sig_rows, key=lambda r: -len(r["name"]))
    aspects = {row["name"]: _image_aspect_ratio(row["path"]) for row in sig_rows}

    doc = fitz.open(in_pdf)
    stamped: List[Dict[str, Any]] = []
    # Vùng chữ đã chèn theo từng trang — tránh chèn trùng/chồng khi 1 tên là
    # chuỗi con của 1 tên khác đã cấu hình (xử lý tên dài trước nên vùng của
    # tên dài đã "chiếm chỗ" trước khi tên ngắn hơn được xét tới).
    claimed_rects: Dict[int, List["fitz.Rect"]] = {}

    for page in doc:
        page_claims = claimed_rects.setdefault(page.number, [])
        for row in sig_rows:
            name = row["name"]
            img_path = row["path"]
            try:
                quads = page.search_for(name, quads=True)
            except Exception:
                continue
            for q in quads:
                rect = q.rect
                if any(_rects_overlap(rect, c) for c in page_claims):
                    continue
                page_claims.append(rect)
                stamp_rect, rotated = _stamp_rect_for(rect, aspects[name])
                try:
                    page.insert_image(
                        stamp_rect,
                        filename=img_path,
                        rotate=90 if rotated else 0,
                        keep_proportion=False,
                        overlay=True,
                    )
                except Exception as e:
                    stamped.append({"page": page.number + 1, "name": name, "error": str(e)})
                    continue
                stamped.append({"page": page.number + 1, "name": name})

    Path(out_pdf).parent.mkdir(parents=True, exist_ok=True)
    doc.save(out_pdf)
    doc.close()

    ok_stamps = [s for s in stamped if not s.get("error")]
    return {
        "status": "ok",
        "out_pdf": out_pdf,
        "size_bytes": os.path.getsize(out_pdf) if os.path.isfile(out_pdf) else 0,
        "stamped_count": len(ok_stamps),
        "stamped": stamped,
        "signed_names": sorted({r["name"] for r in sig_rows}),
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--in-pdf", dest="in_pdf", required=True)
    p.add_argument("--out-pdf", dest="out_pdf", required=True)
    p.add_argument("--out", dest="out_json", default="")
    args = p.parse_args()

    result = sign_bundle(args.in_pdf, args.out_pdf)
    _json_out(args.out_json, result)
    if result.get("status") != "ok":
        print(f"ERROR [sign-discharge] {result.get('message')}", file=sys.stderr)
        return 2
    print(f"LOG [sign-discharge] Đã chèn {result['stamped_count']} chữ ký vào {args.out_pdf}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
