# -*- coding: utf-8 -*-
"""Gom phiếu chăm sóc tài khoản ca làm không sửa/Hoàn tất được để làm nốt CUỐI LƯỢT.

Người dùng chọn "Cuối lượt mới đổi": cả lượt nhập bằng MỘT tài khoản ca làm (một
phiên đăng nhập). Phiếu cũ đứng tên người khác mà EMR không cho tài khoản này sửa
hoặc Hoàn tất (vd phiếu 'Mới' tên người trực do bản cũ để lại) không đổi tài khoản
ngay mà gom theo tài khoản người lập; cuối lượt đăng nhập mỗi tài khoản đó MỘT lần.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from nurse_emr_accounts import get_emr_account_for_nurse


class DeferredCreatorJobs:
    def __init__(self, lookup: Optional[Callable[[str], Optional[Dict[str, str]]]] = None) -> None:
        self.lookup = lookup or get_emr_account_for_nurse
        self._accounts: List[str] = []

    def is_deferred_account(self, username: Any) -> bool:
        return str(username or "").strip() in self._accounts

    def defer(
        self,
        plan: Dict[str, Any],
        job: Dict[str, Any],
        creator: Any,
        current_username: Any,
        time_str: str,
        account_order: List[str],
        account_passwords: Dict[str, str],
    ) -> bool:
        """Xếp `job` vào lượt cuối của tài khoản người lập `creator`. False nếu không
        được (đã là lượt cuối, không có tài khoản người lập, hoặc trùng tài khoản đang dùng)."""
        if job.get("deferred") or not str(creator or "").strip():
            return False
        account = self.lookup(str(creator).strip()) or {}
        username = str(account.get("username") or "").strip()
        password = str(account.get("password") or "")
        if not username or not password or username == str(current_username or "").strip():
            return False
        queued = dict(job, deferred=True, actions_set=set(job.get("actions_set") or ()))
        plan["jobs_by_account"].setdefault(username, []).append(queued)
        plan.setdefault("deferred_time_keys", set()).add(time_str)
        account_passwords[username] = password
        if username not in account_order:
            account_order.append(username)
        if username not in self._accounts:
            self._accounts.append(username)
        return True
