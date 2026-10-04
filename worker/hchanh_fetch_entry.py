# -*- coding: utf-8 -*-
"""Entry point an toàn cho hchanh_fetch.py.

Trong luồng nghiên cứu (nhận diện bằng hchanh_auto_progress.json), marker PT trong
Lịch sử y lệnh chỉ dùng để tối ưu, không còn là gate quyết định. Nếu không có
marker nhưng có khoảng ngày của đợt điều trị, vẫn mở D/s Phẫu thuật và xác minh
trên toàn khoảng. Zero-row sau khi thực sự lookup được đánh dấu `empty`, không
phải `ok` do bỏ qua.

Ngoài research mode, hành vi giữ nguyên như hchanh_fetch.py.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, List, Optional, Tuple

import hchanh_fetch as core


def _arg_value(name: str) -> str:
    try:
        idx = sys.argv.index(name)
        return str(sys.argv[idx + 1] if idx + 1 < len(sys.argv) else "")
    except (ValueError, IndexError):
        return ""


def _is_research_collection() -> bool:
    progress = os.path.basename(_arg_value("--progress-file")).lower()
    return progress == "hchanh_auto_progress.json"


def _install_research_surgery_verification() -> None:
    original_gate = core._surgery_gate_from_order_history
    original_ranges = core._surgery_marker_search_ranges
    original_fetch = core.fetch_surgery

    def gate(order_history: Optional[Dict[str, Any]], date_from: str, date_to: str) -> Dict[str, Any]:
        info = original_gate(order_history, date_from, date_to)
        markers = list(info.get("markers") or [])
        if not markers:
            # Chỉ tạo marker kỹ thuật để đi tiếp tới màn hình D/s Phẫu thuật.
            # Không hề suy diễn rằng có PT; kết luận chỉ dựa trên kết quả lookup sau đó.
            fallback = core._date_to_dmy(date_from) or core._date_to_dmy(date_to)
            if fallback:
                info["markers"] = [fallback]
                info["research_verification_fallback"] = True
        return info

    def full_stay_ranges(marker_dates: List[str], history_from: str = "", history_to: str = "",
                         window_days: int = 1) -> List[Tuple[str, str]]:
        # Research mode ưu tiên đầy đủ hơn tốc độ: khi biết admission/discharge range,
        # xác minh D/s PT trên toàn đợt, không chỉ ±1 ngày quanh marker y lệnh.
        start = core._date_to_dmy(history_from)
        end = core._date_to_dmy(history_to)
        if start and end:
            return [(start, end)]
        return original_ranges(marker_dates, history_from, history_to, window_days)

    def fetch_surgery_verified(sess, ma_bn: str, date_from: str, date_to: str,
                               link_map: Dict[str, str], config: Dict[str, Any],
                               existing_order_history: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        result = original_fetch(
            sess, ma_bn, date_from, date_to, link_map, config,
            existing_order_history=existing_order_history,
        )
        if not isinstance(result, dict):
            return result

        skipped = str(result.get("_skip_surgery_lookup_reason") or "").strip()
        status = str(result.get("_fetch_status") or "").strip().lower()
        surgeries = result.get("surgeries") if isinstance(result.get("surgeries"), list) else []

        if skipped:
            # Không đủ khoảng ngày để xác minh: phải là partial/unverified, tuyệt đối
            # không để `ok + 0` bị hiểu như bằng chứng không có phẫu thuật.
            result["_fetch_status"] = "partial"
            result["_reason"] = f"surgery_lookup_unverified:{skipped}"
            result["_verified_lookup"] = False
            return result

        if status not in {"error", "no_url", "no_session", "timeout"}:
            result["_verified_lookup"] = True
            if not surgeries:
                result["_fetch_status"] = "empty"
                result["_reason"] = "verified_surgery_list_empty"
                result["_verified_empty"] = True
        return result

    core._surgery_gate_from_order_history = gate
    core._surgery_marker_search_ranges = full_stay_ranges
    core.fetch_surgery = fetch_surgery_verified


def main() -> int:
    if _is_research_collection():
        _install_research_surgery_verification()

    args = core.build_arg_parser().parse_args()
    files = [f.strip() for f in (args.files or "").split(",") if f.strip()]
    if core._input_is_batch(args.input):
        return core.run_hchanh_fetch_batch(
            input_path=args.input,
            out_path=args.out,
            scope=args.scope,
            files=files,
            date_from=args.date_from,
            date_to=args.date_to,
            inpatient_status=args.inpatient_status,
            headless=args.headless,
            batch_size=args.batch_size,
            progress_path=args.progress_path,
        )
    return core.run_hchanh_fetch(
        input_path=args.input,
        out_path=args.out,
        scope=args.scope,
        files=files,
        date_from=args.date_from,
        date_to=args.date_to,
        inpatient_status=args.inpatient_status,
        headless=args.headless,
    )


if __name__ == "__main__":
    sys.exit(main())
