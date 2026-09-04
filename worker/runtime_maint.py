# -*- coding: utf-8 -*-
"""runtime_maint.py — Bảo trì runtime EMR.

Lệnh chính:
  generate     Sinh/cập nhật data v2 từ legacy files.
  migrate-keys Chuẩn hóa các key dạng ma_bn::dd/mm/yyyy sang ma_bn::yyyy-mm-dd.
  health       Kiểm tra trùng/lệch dữ liệu runtime.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Tuple

try:
    from date_utils import dmy_to_iso, normalize_dmy
    from runtime_data_v2 import generate_runtime_v2_files, patient_id, patient_day_key, work_date_dmy, stable_hash
except Exception as exc:  # pragma: no cover
    print(f"[runtime_maint] Không import được helper worker: {exc}", file=sys.stderr)
    raise

KEY_RE = re.compile(r"^([^:]+)::(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2})(.*)$")


def read_json(path: Path, fallback: Any = None) -> Any:
    try:
        if not path.exists():
            return fallback
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def canonical_patient_day_key(key: Any) -> str:
    text = str(key or "").strip()
    m = KEY_RE.match(text)
    if not m:
        return text
    pid, raw_date, suffix = m.group(1).strip(), m.group(2).strip(), m.group(3) or ""
    iso = dmy_to_iso(raw_date)
    if not iso:
        return text
    return f"{pid}::{iso}{suffix}"


def migrate_keys_in_value(value: Any) -> Tuple[Any, int]:
    changed = 0
    if isinstance(value, list):
        out = []
        for item in value:
            new_item, n = migrate_keys_in_value(item)
            out.append(new_item)
            changed += n
        return out, changed
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for key, child in value.items():
            new_key = canonical_patient_day_key(key)
            new_child, n = migrate_keys_in_value(child)
            if new_key != key:
                changed += 1
            changed += n
            if new_key in out and isinstance(out[new_key], dict) and isinstance(new_child, dict):
                out[new_key] = {**out[new_key], **new_child}
            else:
                out[new_key] = new_child
        # normalize common embedded key fields
        for field in ("patient_day_key", "sync_key", "key"):
            if isinstance(out.get(field), str):
                new = canonical_patient_day_key(out[field])
                if new != out[field]:
                    out[field] = new
                    changed += 1
        return out, changed
    if isinstance(value, str):
        new = canonical_patient_day_key(value)
        return new, 1 if new != value else 0
    return value, 0


def migrate_file(path: Path) -> Dict[str, Any]:
    data = read_json(path, None)
    if data is None:
        return {"path": str(path), "exists": False, "changed": 0}
    new_data, changed = migrate_keys_in_value(data)
    if changed:
        write_json(path, new_data)
    return {"path": str(path), "exists": True, "changed": changed}


def known_json_files(runtime_dir: Path) -> List[Path]:
    candidates = [
        runtime_dir / "data" / "03_order_text_by_patient_day.json",
        runtime_dir / "data" / "04_classified_patient_day_records.json",
        runtime_dir / "data" / "order_days.json",
        runtime_dir / "data" / "classified_days.json",
        runtime_dir / "data" / "warnings.json",
        runtime_dir / "state" / "care_done.json",
        runtime_dir / "state" / "infusions_done.json",
        runtime_dir / "state" / "procedures_done.json",
        runtime_dir / "state" / "vtyt_done.json",
        runtime_dir / "state" / "task_progress.json",
        runtime_dir / "hchanh" / "tickets" / "ticket_store.json",
        runtime_dir / "admin_workflow" / "ticket_store.json",
    ]
    return [p for p in candidates if p.exists()]


def iter_rows(data: Any) -> Iterable[Mapping[str, Any]]:
    if isinstance(data, list):
        for row in data:
            if isinstance(row, dict):
                yield row
    elif isinstance(data, dict):
        if isinstance(data.get("patient_days"), dict):
            for row in data["patient_days"].values():
                if isinstance(row, dict):
                    yield row
        elif isinstance(data.get("patients"), dict):
            for row in data["patients"].values():
                if isinstance(row, dict):
                    yield row


def duplicate_rows(rows: List[Mapping[str, Any]], key_name: str) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for row in rows:
        if key_name == "patient_id":
            key = patient_id(row)
        else:
            key = patient_day_key(row)
        if not key:
            continue
        counts[key] = counts.get(key, 0) + 1
    return {k: v for k, v in counts.items() if v > 1}


def scan_old_keys(value: Any, path: str = "") -> List[str]:
    hits: List[str] = []
    if isinstance(value, dict):
        for k, v in value.items():
            ck = canonical_patient_day_key(k)
            if ck != k:
                hits.append(f"{path}/{k}".strip("/"))
            if isinstance(v, str) and canonical_patient_day_key(v) != v:
                hits.append(f"{path}/{k}".strip("/"))
            hits.extend(scan_old_keys(v, f"{path}/{k}"))
    elif isinstance(value, list):
        for i, v in enumerate(value):
            hits.extend(scan_old_keys(v, f"{path}[{i}]"))
    return hits[:200]


def run_health(runtime_dir: Path) -> Dict[str, Any]:
    data_dir = runtime_dir / "data"
    raw = read_json(data_dir / "01_raw_patient_rows.json", [])
    selected = read_json(data_dir / "02_selected_patient_rows.json", [])
    orders = read_json(data_dir / "03_order_text_by_patient_day.json", [])
    classified = read_json(data_dir / "04_classified_patient_day_records.json", [])
    board = read_json(data_dir / "board_state.json", {})
    order_days = read_json(data_dir / "order_days.json", {})
    classified_days = read_json(data_dir / "classified_days.json", {})
    hchanh_index = read_json(runtime_dir / "hchanh" / "index.json", {})

    warnings: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []

    raw_rows = list(iter_rows(raw))
    selected_rows = list(iter_rows(selected))
    order_rows = list(iter_rows(orders))
    classified_rows = list(iter_rows(classified))

    for name, rows, key_name in [
        ("raw", raw_rows, "patient_id"),
        ("selected", selected_rows, "patient_id"),
        ("orders", order_rows, "patient_day"),
        ("classified", classified_rows, "patient_day"),
    ]:
        dup = duplicate_rows(rows, key_name)
        if dup:
            warnings.append({"code": "duplicate_keys", "file": name, "count": len(dup), "samples": list(dup.items())[:10]})

    raw_ids = {patient_id(r) for r in raw_rows if patient_id(r)}
    selected_ids = {patient_id(r) for r in selected_rows if patient_id(r)}
    selected_missing = sorted(selected_ids - raw_ids) if raw_ids else []
    if selected_missing:
        warnings.append({"code": "selected_not_in_raw", "count": len(selected_missing), "samples": selected_missing[:20]})

    board_ids = set(board.get("selected_patient_ids") or []) if isinstance(board, dict) else set()
    if selected_ids and board_ids and board_ids != selected_ids:
        warnings.append({
            "code": "board_state_mismatch",
            "selected_only": sorted(selected_ids - board_ids)[:20],
            "board_only": sorted(board_ids - selected_ids)[:20],
        })

    if isinstance(hchanh_index, dict) and isinstance(hchanh_index.get("patients"), dict):
        active_ids = {k for k, v in hchanh_index["patients"].items() if isinstance(v, dict) and v.get("active") is True}
        if raw_ids and active_ids - raw_ids:
            warnings.append({"code": "hchanh_active_not_in_raw", "count": len(active_ids - raw_ids), "samples": sorted(active_ids - raw_ids)[:20]})

    for label, payload in [
        ("order_days", order_days),
        ("classified_days", classified_days),
    ]:
        if isinstance(payload, dict) and isinstance(payload.get("patient_days"), dict):
            old = [k for k in payload["patient_days"].keys() if canonical_patient_day_key(k) != k]
            if old:
                warnings.append({"code": "old_patient_day_keys", "file": label, "count": len(old), "samples": old[:20]})

    for p in known_json_files(runtime_dir):
        old_hits = scan_old_keys(read_json(p, None))
        if old_hits:
            warnings.append({"code": "legacy_dmy_keys", "file": str(p.relative_to(runtime_dir)), "count": len(old_hits), "samples": old_hits[:10]})

    return {
        "ok": not errors,
        "runtime_dir": str(runtime_dir),
        "errors": errors,
        "warnings": warnings,
        "counts": {
            "raw": len(raw_rows),
            "selected": len(selected_rows),
            "orders": len(order_rows),
            "classified": len(classified_rows),
            "order_days": len((order_days or {}).get("patient_days") or {}) if isinstance(order_days, dict) else 0,
            "classified_days": len((classified_days or {}).get("patient_days") or {}) if isinstance(classified_days, dict) else 0,
            "hchanh_patients": len((hchanh_index or {}).get("patients") or {}) if isinstance(hchanh_index, dict) else 0,
        },
    }


def main(argv: List[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["generate", "migrate-keys", "health"])
    ap.add_argument("--runtime-dir", default=os.environ.get("WORKER_RUNTIME_DIR") or os.getcwd())
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    runtime_dir = Path(args.runtime_dir).resolve()
    if args.command == "generate":
        result = generate_runtime_v2_files(runtime_dir)
    elif args.command == "migrate-keys":
        files = known_json_files(runtime_dir)
        result = {"runtime_dir": str(runtime_dir), "files": [migrate_file(p) for p in files]}
        # regenerate v2 after migration so indexes match canonical keys
        result["v2"] = generate_runtime_v2_files(runtime_dir)
    else:
        result = run_health(runtime_dir)

    print(json.dumps(result, ensure_ascii=False, indent=2 if args.json else None))
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
