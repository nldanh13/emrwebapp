# -*- coding: utf-8 -*-
"""Chuẩn hóa thư mục dữ liệu runtime cũ sang cấu trúc mới.

Ví dụ:
  python scripts/normalize_runtime_data.py --source ./old_runtime --out ./runtime_standard

Output:
  data/01_raw_patient_rows.json
  data/02_selected_patient_rows.json
  data/03_order_text_by_patient_day.json
  data/04_classified_patient_day_records.json
  state/*.json nếu có
  manifest.json
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
import sys
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

from data_contract import CANONICAL_RUNTIME_FILES, LEGACY_RUNTIME_FILES, DATA_CONTRACT_VERSION, build_manifest  # noqa: E402
from runtime_data_v2 import generate_runtime_v2_files, write_json_compact, merge_order_records, canonical_legacy_rows  # noqa: E402

STATE_FILES = {
    "care_done.json": Path("state/care_done.json"),
    "infusions_done.json": Path("state/infusions_done.json"),
    "procedures_done.json": Path("state/procedures_done.json"),
    "vtyt_done.json": Path("state/vtyt_done.json"),
    "admin_nurse_state.json": Path("state/admin_nurse_state.json"),
}


def first_existing(source: Path, logical: str) -> Path | None:
    candidates = []
    canonical = CANONICAL_RUNTIME_FILES.get(logical)
    if canonical:
        candidates.append(source / canonical)
    for legacy in LEGACY_RUNTIME_FILES.get(logical, []):
        candidates.append(source / legacy)
    for p in candidates:
        if p.exists():
            return p
    return None


def copy_json(src: Path, dst: Path, *, logical: str = "") -> int | str:
    dst.parent.mkdir(parents=True, exist_ok=True)
    with src.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if logical == "orders" and isinstance(data, list):
        data = merge_order_records(data, skip_empty=False)
        data = canonical_legacy_rows(data, include_order_text=True)
    elif logical in {"raw", "selected"} and isinstance(data, list):
        data = canonical_legacy_rows(data, include_order_text=False)
    write_json_compact(dst, data)
    if isinstance(data, list):
        return len(data)
    if isinstance(data, dict):
        return len(data)
    return "?"


def normalize(source: Path, out: Path) -> dict:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    copied = []
    missing = []
    # Copy các file legacy-compatible trước; các file v2 sẽ được sinh lại ở cuối.
    for logical in ["raw", "selected", "orders", "classified"]:
        rel = CANONICAL_RUNTIME_FILES[logical]
        src = first_existing(source, logical)
        dst = out / rel
        if src:
            count = copy_json(src, dst, logical=logical)
            copied.append({"logical": logical, "from": str(src), "to": str(dst.relative_to(out)), "count": count})
        else:
            missing.append(logical)

    for old_name, rel in STATE_FILES.items():
        src = source / old_name
        if src.exists():
            dst = out / rel
            try:
                count = copy_json(src, dst)
                copied.append({"logical": old_name, "from": str(src), "to": str(dst.relative_to(out)), "count": count})
            except Exception:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                copied.append({"logical": old_name, "from": str(src), "to": str(dst.relative_to(out)), "count": "copied"})

    logs_src = source / "logs"
    if logs_src.exists():
        shutil.copytree(logs_src, out / "logs", dirs_exist_ok=True)

    try:
        v2_indexes = generate_runtime_v2_files(out)
        copied.append({"logical": "runtime_v2", "from": "generated", "to": "data/*.json", "count": v2_indexes})
    except Exception as exc:
        missing.append(f"runtime_v2:{exc}")

    manifest = build_manifest(str(out))
    manifest.update({
        "schema": DATA_CONTRACT_VERSION,
        "normalized_at": datetime.now().isoformat(timespec="seconds"),
        "source": str(source),
        "copied": copied,
        "missing": missing,
    })
    with (out / "manifest.json").open("w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))
    return manifest


def main() -> int:
    ap = argparse.ArgumentParser(description="Chuẩn hóa dữ liệu runtime EMR về tên file/cấu trúc mới.")
    ap.add_argument("--source", required=True, help="Thư mục chứa file runtime cũ hoặc mới")
    ap.add_argument("--out", required=True, help="Thư mục output chuẩn hóa")
    args = ap.parse_args()
    manifest = normalize(Path(args.source).resolve(), Path(args.out).resolve())
    print(json.dumps({"status": "ok", "schema": manifest.get("schema"), "copied": manifest.get("copied", []), "missing": manifest.get("missing", [])}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
