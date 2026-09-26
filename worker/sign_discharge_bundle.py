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
import unicodedata
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


def _prepared_signature_png(img_path: str) -> Tuple[bytes, float]:
    """Ảnh chữ ký đã chuẩn hoá (PNG nền trong suốt, nét đậm/dày) và tỉ lệ rộng/cao."""
    pix = fitz.Pixmap(img_path)
    if pix.colorspace is None or pix.colorspace.n != 3:
        pix = fitz.Pixmap(fitz.csRGB, pix)
    while pix.width > _SIG_MAX_WIDTH_PX:
        pix.shrink(1)
    w, h, n = pix.width, pix.height, pix.n
    src = pix.samples
    has_alpha = n == 4

    dark = bytearray(w * h)
    sum_r = sum_g = sum_b = cnt = 0
    for i in range(w * h):
        o = i * n
        r, g, b = src[o], src[o + 1], src[o + 2]
        a = src[o + 3] if has_alpha else 255
        lum = (r * 299 + g * 587 + b * 114) // 1000
        d = ((255 - lum) * a) // 255  # độ tối sau khi đặt lên nền trắng
        dark[i] = d
        if d > 100:
            sum_r += r; sum_g += g; sum_b += b; cnt += 1
    if cnt:
        ink = (int(sum_r / cnt * _INK_DARKEN), int(sum_g / cnt * _INK_DARKEN), int(sum_b / cnt * _INK_DARKEN))
    else:
        ink = (0, 0, 0)

    # Làm dày nét (ảnh sẽ bị thu rất nhỏ trên phiếu): lấy độ tối lớn nhất trong
    # cửa sổ bán kính r quanh mỗi điểm, lọc theo hàng rồi theo cột cho nhanh.
    r = max(1, h // _STROKE_RATIO)
    rows = bytearray(w * h)
    for y in range(h):
        base = y * w
        for x in range(w):
            rows[base + x] = max(dark[base + max(0, x - r):base + min(w, x + r + 1)])
    thick = bytearray(w * h)
    for x in range(w):
        col = rows[x::w]
        for y in range(h):
            thick[y * w + x] = max(col[max(0, y - r):min(h, y + r + 1)])

    # Độ đặc tính theo nét tối nhất của chính ảnh: chữ ký viết mực nhạt cũng thành nét đặc.
    peak = max(thick) if thick else 0
    span = max(peak - _BG_CUTOFF, 1)
    out = bytearray(w * h * 4)
    for i, d in enumerate(thick):
        o = i * 4
        out[o], out[o + 1], out[o + 2] = ink
        out[o + 3] = 0 if d < _BG_CUTOFF else min(255, int((d - _BG_CUTOFF) * 255 * _ALPHA_GAIN / span))
    prepared = fitz.Pixmap(fitz.csRGB, w, h, bytes(out), 1)
    return prepared.tobytes("png"), (w / h if h else 2.2)


def _match_groups(page: "fitz.Page", name: str) -> List[List["fitz.Rect"]]:
    """Các lần xuất hiện của `name` trên trang, mỗi lần là danh sách vùng chữ.
    Tên bị xuống dòng ("Trần Quỳnh Minh" / "Thư") được search_for() trả thành
    nhiều vùng liên tiếp — gộp lại thành 1 lần xuất hiện để chỉ ký 1 lần."""
    try:
        quads = page.search_for(name, quads=True)
    except Exception:
        return []
    target = _norm_text(name)
    groups: List[List["fitz.Rect"]] = []
    buf: List["fitz.Rect"] = []
    buf_text = ""
    for q in quads:
        rect = q.rect
        part = _core_text(page, rect)
        if not buf and target in part:
            groups.append([rect])
            continue
        buf.append(rect)
        buf_text = f"{buf_text} {part}".strip()
        if target in _norm_text(buf_text) or len(buf) >= 4:
            groups.append(buf)
            buf, buf_text = [], ""
    if buf:
        groups.append(buf)
    return groups


def _core_text(page: "fitz.Page", rect: "fitz.Rect") -> str:
    """Chữ nằm trong dải giữa của vùng — vùng tìm được thường chạm sát dòng
    trên/dưới, đọc cả vùng sẽ dính chữ của dòng bên cạnh."""
    if _is_vertical_quad(rect):
        pad = rect.width * 0.3
        core = fitz.Rect(rect.x0 + pad, rect.y0, rect.x1 - pad, rect.y1)
    else:
        pad = rect.height * 0.3
        core = fitz.Rect(rect.x0, rect.y0 + pad, rect.x1, rect.y1 - pad)
    return _norm_text(page.get_textbox(core))


def _norm_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", str(value or "")).split())


# Khoảng cách (pt) giữa mép trên của chữ và mép dưới của ảnh chữ ký.
_STAMP_GAP = 2.0
# Hệ số phóng bề dày chữ ký so với bề dày dòng chữ, và biên trên/dưới (pt).
_HORIZ_THICKNESS_FACTOR = 1.55
_HORIZ_THICKNESS_MIN, _HORIZ_THICKNESS_MAX = 10.0, 32.0
_VERT_THICKNESS_FACTOR = 1.75
_VERT_THICKNESS_MIN, _VERT_THICKNESS_MAX = 10.0, 26.0

# Ảnh chữ ký được chuẩn hoá trước khi chèn: thu nhỏ (ảnh chụp điện thoại rất
# lớn làm PDF nặng), bỏ nền trắng, làm nét đậm và dày hơn.
_SIG_MAX_WIDTH_PX = 480
_INK_DARKEN = 0.3        # màu mực = màu trung bình của nét × hệ số này (gần đen hơn)
_STROKE_RATIO = 45       # nét được làm dày thêm ~chiều cao ảnh / hệ số này mỗi bên
_BG_CUTOFF = 30          # độ tối dưới mức này coi là nền giấy → trong suốt
_ALPHA_GAIN = 1.8        # nét đạt ~55% độ tối đậm nhất của ảnh là đã đặc hoàn toàn


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
    prepared: Dict[str, Tuple[bytes, float]] = {}
    for row in sig_rows:
        try:
            prepared[row["name"]] = _prepared_signature_png(row["path"])
        except Exception as e:
            print(f"WARN [sign-discharge] Không xử lý được ảnh chữ ký của {row['name']}: {e}", file=sys.stderr)

    doc = fitz.open(in_pdf)
    stamped: List[Dict[str, Any]] = []
    # Vùng chữ đã chèn theo từng trang — tránh chèn trùng/chồng khi 1 tên là
    # chuỗi con của 1 tên khác đã cấu hình (xử lý tên dài trước nên vùng của
    # tên dài đã "chiếm chỗ" trước khi tên ngắn hơn được xét tới).
    claimed_rects: Dict[int, List["fitz.Rect"]] = {}
    # Mỗi ảnh chữ ký chỉ nhúng 1 lần vào PDF; các chỗ ký sau dùng lại (xref).
    image_xrefs: Dict[str, int] = {}

    for page in doc:
        page_claims = claimed_rects.setdefault(page.number, [])
        for row in sig_rows:
            name = row["name"]
            if name not in prepared:
                continue
            png, aspect = prepared[name]
            for group in _match_groups(page, name):
                if any(_rects_overlap(r, c) for r in group for c in page_claims):
                    continue
                page_claims.extend(group)
                anchor = fitz.Rect(group[0])
                for r in group[1:]:
                    anchor |= r
                if len(group) > 1 and not _is_vertical_quad(group[0]):
                    # Tên xuống dòng: ký phía trên dòng đầu, căn giữa theo cả khối tên.
                    anchor = fitz.Rect(anchor.x0, group[0].y0, anchor.x1, group[0].y1)
                stamp_rect, rotated = _stamp_rect_for(anchor, aspect)
                try:
                    if name in image_xrefs:
                        page.insert_image(stamp_rect, xref=image_xrefs[name], rotate=90 if rotated else 0,
                                          keep_proportion=False, overlay=True)
                    else:
                        image_xrefs[name] = page.insert_image(stamp_rect, stream=png, rotate=90 if rotated else 0,
                                                              keep_proportion=False, overlay=True)
                except Exception as e:
                    stamped.append({"page": page.number + 1, "name": name, "error": str(e)})
                    continue
                stamped.append({"page": page.number + 1, "name": name})

    Path(out_pdf).parent.mkdir(parents=True, exist_ok=True)
    doc.save(out_pdf, garbage=3, deflate=True)
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
