#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Ghép nhiều file PDF thành một file PDF chung.

Input JSON dạng:
{
  "files": [
    {"path": "...pdf", "ma_bn": "260...", "ho_ten": "...", "label": "..."}
  ],
  "blank_between_patients": true
}

Nếu blank_between_patients=true, khi bộ PDF của một người bệnh có tổng số trang lẻ
và phía sau còn người bệnh khác, script chèn 1 trang trắng để người bệnh tiếp theo
bắt đầu ở mặt trước khi in hai mặt.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

try:
    from pypdf import PdfReader, PdfWriter
except Exception as exc:  # pragma: no cover
    print(f"ERROR [merge-pdf] Thiếu thư viện pypdf: {exc}", file=sys.stderr)
    raise


def _read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _page_size(reader: PdfReader):
    if len(reader.pages):
        box = reader.pages[-1].mediabox
        return float(box.width), float(box.height)
    return 595.0, 842.0


def merge_files(input_json: Path, out_file: Path, out_json: Path = None) -> int:
    payload = _read_json(input_json, {}) or {}
    rows = payload.get("files") if isinstance(payload, dict) else []
    if not isinstance(rows, list):
        rows = []
    blank_between_patients = bool(payload.get("blank_between_patients", True)) if isinstance(payload, dict) else True

    writer = PdfWriter()
    merged: List[Dict[str, Any]] = []
    failures: List[Dict[str, Any]] = []
    inserted_blank_pages = 0

    valid_rows: List[Dict[str, Any]] = []
    for idx, item in enumerate(rows):
        if not isinstance(item, dict):
            continue
        path = Path(str(item.get("path") or "")).expanduser()
        if not path.exists() or not path.is_file():
            failures.append({"index": idx, "path": str(path), "message": "Không tìm thấy file PDF."})
            continue
        valid_rows.append(item)

    if not valid_rows:
        result = {"status": "error", "message": "Không có file PDF hợp lệ để ghép.", "failures": failures}
        if out_json:
            _write_json(out_json, result)
        print("ERROR [merge-pdf] Không có file PDF hợp lệ để ghép.", file=sys.stderr)
        return 2

    for idx, item in enumerate(valid_rows):
        path = Path(str(item.get("path") or "")).expanduser()
        ma_bn = str(item.get("ma_bn") or "").strip()
        ho_ten = str(item.get("ho_ten") or "").strip()
        label = str(item.get("label") or path.name).strip()
        try:
            reader = PdfReader(str(path))
            page_count = len(reader.pages)
            for page in reader.pages:
                writer.add_page(page)
            merged.append({
                "ma_bn": ma_bn,
                "ho_ten": ho_ten,
                "label": label,
                "path": str(path),
                "pages": page_count,
            })
            if blank_between_patients and idx < len(valid_rows) - 1 and page_count % 2 == 1:
                width, height = _page_size(reader)
                writer.add_blank_page(width=width, height=height)
                inserted_blank_pages += 1
                merged.append({
                    "ma_bn": ma_bn,
                    "ho_ten": ho_ten,
                    "label": "Trang trắng sau bộ BN để in 2 mặt",
                    "path": "",
                    "pages": 1,
                    "blank": True,
                })
        except Exception as exc:
            failures.append({"ma_bn": ma_bn, "ho_ten": ho_ten, "path": str(path), "message": str(exc)})

    if not merged or len(writer.pages) == 0:
        result = {"status": "error", "message": "Không ghép được trang PDF nào.", "failures": failures}
        if out_json:
            _write_json(out_json, result)
        print("ERROR [merge-pdf] Không ghép được trang PDF nào.", file=sys.stderr)
        return 3

    out_file.parent.mkdir(parents=True, exist_ok=True)
    with out_file.open("wb") as f:
        writer.write(f)

    result = {
        "status": "ok" if not failures else "partial",
        "message": "Đã ghép PDF chung.",
        "file_name": out_file.name,
        "bundle_path": str(out_file),
        "size_bytes": out_file.stat().st_size if out_file.exists() else 0,
        "total_pages": len(writer.pages),
        "inserted_blank_pages": inserted_blank_pages,
        "merged": merged,
        "failures": failures,
    }
    if out_json:
        _write_json(out_json, result)
    print(f"LOG [merge-pdf] Đã ghép file: {out_file}")
    return 0 if not failures else 8


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--out-json", default="")
    args = ap.parse_args()
    return merge_files(Path(args.input), Path(args.out), Path(args.out_json) if args.out_json else None)


if __name__ == "__main__":
    raise SystemExit(main())
