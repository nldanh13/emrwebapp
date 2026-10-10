# -*- coding: utf-8 -*-
"""worker/sign_discharge_bundle.py — Chèn ảnh chữ ký lên bộ phiếu "IN RA VIỆN".

Chữ ký được tìm theo tên người ký trên lớp text PDF. Ảnh chữ ký được làm nền
trong suốt, tự cắt viền trắng theo bounding-box nét mực rồi mới scale/chèn.
Việc crop trước khi tính aspect giúp những ảnh có nhiều khoảng trắng không bị
thu nhỏ giả tạo và giữ hình dáng chữ ký đồng đều hơn giữa các biểu mẫu.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nurse_emr_accounts import load_nurse_signature_rows  # noqa: E402

try:
    import pymupdf as fitz
except Exception:
    try:
        import fitz
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


# Kích thước/vị trí trên phiếu.
_STAMP_GAP = 0.8
_HORIZ_THICKNESS_FACTOR = 2.20
_HORIZ_THICKNESS_MIN, _HORIZ_THICKNESS_MAX = 12.0, 38.0
_VERT_THICKNESS_FACTOR = 3.00
_VERT_THICKNESS_MIN, _VERT_THICKNESS_MAX = 16.0, 46.0

# Xử lý ảnh: ưu tiên giữ hình dáng nét ký thật, không làm đặc cứng.
_SIG_MAX_WIDTH_PX = 900
_INK_DARKEN = 0.68
_STROKE_RATIO = 180
_BG_CUTOFF = 16
_ALPHA_GAIN = 1.05
_CROP_ALPHA_MIN = 18
_CROP_PAD_RATIO = 0.055
_CROP_PAD_MIN = 3


def _crop_rgba_to_ink(rgba: bytearray, w: int, h: int) -> Tuple[bytes, int, int]:
    """Cắt viền trắng/trong suốt theo phần nét ký thật và giữ một ít padding."""
    xs: List[int] = []
    ys: List[int] = []
    for y in range(h):
        row = y * w * 4
        for x in range(w):
            if rgba[row + x * 4 + 3] >= _CROP_ALPHA_MIN:
                xs.append(x)
                ys.append(y)
    if not xs:
        return bytes(rgba), w, h

    x0, x1 = min(xs), max(xs) + 1
    y0, y1 = min(ys), max(ys) + 1
    ink_w, ink_h = x1 - x0, y1 - y0
    pad = max(_CROP_PAD_MIN, int(max(ink_w, ink_h) * _CROP_PAD_RATIO))
    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(w, x1 + pad)
    y1 = min(h, y1 + pad)

    cw, ch = x1 - x0, y1 - y0
    cropped = bytearray(cw * ch * 4)
    for y in range(ch):
        src0 = ((y0 + y) * w + x0) * 4
        src1 = src0 + cw * 4
        dst0 = y * cw * 4
        cropped[dst0:dst0 + cw * 4] = rgba[src0:src1]
    return bytes(cropped), cw, ch


def _prepared_signature_png(img_path: str) -> Tuple[bytes, float]:
    """Chuẩn hoá chữ ký, crop theo nét mực và trả PNG + aspect thực sau crop."""
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
        d = ((255 - lum) * a) // 255
        dark[i] = d
        if d > 100:
            sum_r += r
            sum_g += g
            sum_b += b
            cnt += 1

    if cnt:
        ink = (
            min(255, int(sum_r / cnt * _INK_DARKEN)),
            min(255, int(sum_g / cnt * _INK_DARKEN)),
            min(255, int(sum_b / cnt * _INK_DARKEN)),
        )
    else:
        ink = (0, 0, 0)

    # Chỉ làm dày khi ảnh rất lớn; ảnh vừa/nhỏ giữ nguyên nét để không bị "cục đen".
    radius = h // _STROKE_RATIO
    if radius > 0:
        rows = bytearray(w * h)
        for y in range(h):
            base = y * w
            for x in range(w):
                rows[base + x] = max(dark[base + max(0, x - radius):base + min(w, x + radius + 1)])
        thick = bytearray(w * h)
        for x in range(w):
            col = rows[x::w]
            for y in range(h):
                thick[y * w + x] = max(col[max(0, y - radius):min(h, y + radius + 1)])
    else:
        thick = dark

    peak = max(thick) if thick else 0
    span = max(peak - _BG_CUTOFF, 1)
    out = bytearray(w * h * 4)
    for i, d in enumerate(thick):
        o = i * 4
        out[o], out[o + 1], out[o + 2] = ink
        out[o + 3] = 0 if d < _BG_CUTOFF else min(
            255, int((d - _BG_CUTOFF) * 255 * _ALPHA_GAIN / span)
        )

    cropped, cw, ch = _crop_rgba_to_ink(out, w, h)
    prepared = fitz.Pixmap(fitz.csRGB, cw, ch, cropped, 1)
    return prepared.tobytes("png"), (cw / ch if ch else 2.2)


def _norm_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", str(value or "")).split())


def _is_vertical_quad(rect: "fitz.Rect") -> bool:
    return rect.height > rect.width * 1.3


def _core_text(page: "fitz.Page", rect: "fitz.Rect") -> str:
    if _is_vertical_quad(rect):
        pad = rect.width * 0.3
        core = fitz.Rect(rect.x0 + pad, rect.y0, rect.x1 - pad, rect.y1)
    else:
        pad = rect.height * 0.3
        core = fitz.Rect(rect.x0, rect.y0 + pad, rect.x1, rect.y1 - pad)
    return _norm_text(page.get_textbox(core))


def _match_groups(page: "fitz.Page", name: str) -> List[List["fitz.Rect"]]:
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


def _rects_overlap(a: "fitz.Rect", b: "fitz.Rect", threshold: float = 0.5) -> bool:
    inter = a & b
    if inter.is_empty:
        return False
    min_area = min(a.get_area(), b.get_area())
    return min_area > 0 and (inter.get_area() / min_area) >= threshold


def _stamp_rect_for(rect: "fitz.Rect", aspect: float) -> Tuple["fitz.Rect", bool]:
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
        return {"status": "error", "message": "Chưa cấu hình ảnh chữ ký cho điều dưỡng/bác sĩ nào (tab Lịch làm việc)."}
    sig_rows = sorted(sig_rows, key=lambda r: -len(r["name"]))

    prepared: Dict[str, Tuple[bytes, float]] = {}
    for row in sig_rows:
        try:
            prepared[row["name"]] = _prepared_signature_png(row["path"])
        except Exception as e:
            print(f"WARN [sign-discharge] Không xử lý được ảnh chữ ký của {row['name']}: {e}", file=sys.stderr)

    doc = fitz.open(in_pdf)
    stamped: List[Dict[str, Any]] = []
    claimed_rects: Dict[int, List["fitz.Rect"]] = {}
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
