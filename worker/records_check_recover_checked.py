#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Khôi phục danh sách hồ sơ đã kiểm từ PDF đã in gần nhất.

PDF do worker records_check_print_pdf.py tạo có bảng:
Họ và tên | Số lưu trữ | XQ | MRI | CT.
Script chỉ đọc PDF và xuất JSON trung gian; việc ghép với index do Node thực hiện.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

try:
    from pypdf import PdfReader
except Exception as exc:  # pragma: no cover - thông báo rõ khi môi trường thiếu dependency
    print(f"ERROR: Thiếu thư viện pypdf: {exc}", file=sys.stderr)
    raise SystemExit(2)


def _clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("\xa0", " ")).strip()


def _parse_pdf(pdf_path: Path) -> List[Dict[str, Any]]:
    reader = PdfReader(str(pdf_path))
    rows: List[Dict[str, Any]] = []
    for page_no, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text(extraction_mode="layout") or ""
        except TypeError:
            text = page.extract_text() or ""
        for raw_line in text.splitlines():
            line = _clean(raw_line)
            if not line:
                continue
            parts = [_clean(part) for part in re.split(r"\s{2,}", raw_line.strip()) if _clean(part)]
            if len(parts) < 5:
                continue
            name, storage, xq, mri, ct = parts[:5]
            if _clean(name).lower() == "họ và tên":
                continue
            if not re.search(r"\d", storage):
                continue
            if not all(re.fullmatch(r"\d+", _clean(value)) for value in (xq, mri, ct)):
                continue
            rows.append({
                "ho_ten": name,
                "so_luu_tru_in": storage,
                "xq": int(xq),
                "mri": int(mri),
                "ct": int(ct),
                "page": page_no,
            })
    return rows


def _pdf_candidates(records_dir: Path) -> List[Path]:
    print_dir = records_dir / "print"
    if not print_dir.is_dir():
        return []
    files = [p for p in print_dir.glob("kiem_ho_so_*.pdf") if p.is_file()]

    def sort_key(pdf: Path):
        match = re.search(r"kiem_ho_so_(\d{12,14})", pdf.stem, flags=re.IGNORECASE)
        stamp = match.group(1) if match else ""
        return (stamp, pdf.stat().st_mtime, pdf.name)

    # Ưu tiên mốc thời gian nằm trong tên file. Khi sao chép/giải nén, mtime có
    # thể mới hơn sai lệch và làm file cũ 07/07 đứng trước file 12/07.
    files.sort(key=sort_key, reverse=True)
    return files


def _generated_at_from_name(pdf_path: Path) -> str:
    match = re.search(r"kiem_ho_so_(\d{12,14})", pdf_path.stem, flags=re.IGNORECASE)
    if not match:
        return ""
    stamp = match.group(1)
    fmt = "%Y%m%d%H%M%S" if len(stamp) >= 14 else "%Y%m%d%H%M"
    try:
        return datetime.strptime(stamp[:14] if len(stamp) >= 14 else stamp[:12], fmt).replace(tzinfo=timezone.utc).isoformat()
    except ValueError:
        return ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--records-dir", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    records_dir = Path(args.records_dir).resolve()
    out_path = Path(args.out).resolve()
    candidates = _pdf_candidates(records_dir)
    if not candidates:
        payload = {
            "status": "no_pdf",
            "source_pdf": "",
            "source_mtime": "",
            "rows": [],
        }
    else:
        source = candidates[0]
        rows = _parse_pdf(source)
        payload = {
            "status": "ok",
            "source_pdf": source.name,
            "source_path": str(source),
            "source_mtime": datetime.fromtimestamp(source.stat().st_mtime, tz=timezone.utc).isoformat(),
            "source_generated_at": _generated_at_from_name(source),
            "rows": rows,
            "count": len(rows),
        }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"SUCCESS: {payload.get('status')} rows={len(payload.get('rows') or [])} -> {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
