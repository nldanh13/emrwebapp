# -*- coding: utf-8 -*-
"""Nhập chăm sóc bệnh phòng: phiếu của ai lập bằng tài khoản EMR của người đó.

EMR không còn cho Thu hồi để đổi Người lập, nên mỗi phiếu phải được tạo bằng
chính tài khoản EMR của điều dưỡng phụ trách giờ đó (ca làm/ca trực theo Lịch
điều dưỡng). Người phụ trách chưa có tài khoản EMR (Thiết lập tài khoản) thì
không nhập phiếu đó, để tránh phiếu đứng sai tên.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional


def shift_kind_for_hour(hour: Any) -> str:
    """'work' (07-10h, 13-16h) hoặc 'oncall' (còn lại) — khớp quy tắc ca của get_nurse_by_shift()."""
    try:
        h = int(hour)
    except Exception:
        return "work"
    return "work" if (7 <= h <= 10 or 13 <= h <= 16) else "oncall"


def group_jobs_by_owner_account(
    jobs: List[Dict[str, Any]],
    owner_for_time: Callable[[str], str],
    lookup: Callable[[str], Optional[Dict[str, str]]],
) -> Dict[str, Any]:
    """Nhóm phiếu theo tài khoản EMR của người lập (người phụ trách giờ đó).

    Trả về:
      - jobs_by_account: {username: [job, ...]}
      - passwords: {username: password}
      - owners: {username: tên điều dưỡng}
      - shift_kinds: {username: ["work"|"oncall", ...]} để xếp ca làm trước, ca trực sau
      - blocked: [thông báo tiếng Việt cho phiếu không nhập được]
    Mỗi job được gắn "owner" (tên người lập mong đợi).
    """
    out: Dict[str, Any] = {"jobs_by_account": {}, "passwords": {}, "owners": {}, "shift_kinds": {}, "blocked": []}
    for job in jobs or []:
        time_str = str(job.get("time_str") or "")
        try:
            owner = str(owner_for_time(time_str) or "").strip()
        except Exception:
            owner = ""
        if not owner:
            out["blocked"].append(f"{time_str}: chưa có điều dưỡng phụ trách giờ này trong Lịch điều dưỡng, không nhập.")
            continue
        account = lookup(owner) or {}
        username = str(account.get("username") or "").strip()
        password = str(account.get("password") or "")
        if not username or not password:
            out["blocked"].append(
                f"{time_str}: chưa có tài khoản EMR của {owner} (Cài đặt → Thiết lập tài khoản), "
                "không nhập để tránh sai người lập."
            )
            continue
        job["owner"] = owner
        out["jobs_by_account"].setdefault(username, []).append(job)
        out["passwords"][username] = password
        out["owners"][username] = owner
        kinds = out["shift_kinds"].setdefault(username, [])
        kind = shift_kind_for_hour(job.get("hour"))
        if kind not in kinds:
            kinds.append(kind)
    return out
