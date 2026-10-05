# -*- coding: utf-8 -*-
"""Người dùng chọn "Cuối lượt mới đổi": nhập hết bằng MỘT tài khoản ca làm; phiếu
nào tài khoản đó không sửa/Hoàn tất được (vd phiếu 'Mới' đứng tên Võ Thị Yến Nhi)
thì gom lại, cuối lượt đăng nhập tài khoản người lập MỘT lần để làm nốt."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

from care_deferred import DeferredCreatorJobs
from shared.worker_session import WorkerSession

ACCOUNTS = {"Võ Thị Yến Nhi": {"username": "vtynhi", "password": "pw-nhi"}}


def _plan():
    return {"jobs_by_account": {"tttda": []}}


def test_defer_queues_job_under_creator_account_once():
    d = DeferredCreatorJobs(lookup=ACCOUNTS.get)
    order, passwords = ["tttda"], {"tttda": "pw-da"}
    plan = _plan()
    job = {"hour": 5, "time_str": "05:00 06/10/2026", "actions_set": {"x"}}
    assert d.defer(plan, job, "Võ Thị Yến Nhi", "tttda", "05:00 06/10/2026", order, passwords)
    assert d.defer(plan, dict(job, time_str="06:00 06/10/2026"), "Võ Thị Yến Nhi", "tttda",
                   "06:00 06/10/2026", order, passwords)
    assert order == ["tttda", "vtynhi"]
    assert passwords["vtynhi"] == "pw-nhi"
    queued = plan["jobs_by_account"]["vtynhi"]
    assert [j["time_str"] for j in queued] == ["05:00 06/10/2026", "06:00 06/10/2026"]
    assert all(j["deferred"] for j in queued)
    assert plan["deferred_time_keys"] == {"05:00 06/10/2026", "06:00 06/10/2026"}
    assert d.is_deferred_account("vtynhi") and not d.is_deferred_account("tttda")
    assert job.get("deferred") is None, "không sửa job gốc"


def test_no_defer_without_account_same_account_or_second_time():
    d = DeferredCreatorJobs(lookup=ACCOUNTS.get)
    order, passwords, plan = ["tttda"], {}, _plan()
    assert not d.defer(plan, {"time_str": "t"}, "Người Lạ", "tttda", "t", order, passwords)
    assert not d.defer(plan, {"time_str": "t"}, "", "tttda", "t", order, passwords)
    assert not d.defer(plan, {"time_str": "t"}, "Võ Thị Yến Nhi", "vtynhi", "t", order, passwords)
    assert not d.defer(plan, {"time_str": "t", "deferred": True}, "Võ Thị Yến Nhi", "tttda", "t", order, passwords)
    assert order == ["tttda"]


def test_single_login_allows_only_end_of_run_switch():
    ws = WorkerSession({"username": "tttda", "password": "pw-da", "single_login": True}, os.devnull)
    assert ws.switch_account("vtynhi", "pw-nhi") is False
    called = []
    import shared.worker_session as wsm
    orig_init, orig_login = wsm.init_driver, wsm.login_emr
    wsm.init_driver = lambda headless=False: (object(), object())
    wsm.login_emr = lambda d, w, cfg: called.append(cfg["username"])
    try:
        assert ws.switch_account("vtynhi", "pw-nhi", end_of_run=True) is True
    finally:
        wsm.init_driver, wsm.login_emr = orig_init, orig_login
    assert called == ["vtynhi"] and ws.config["username"] == "vtynhi"


def test_input_care_defers_instead_of_switching_mid_run():
    src = (WORKER / "input_care.py").read_text(encoding="utf-8")
    assert "ws.switch_to_creator_account(existing_creator" not in src
    assert "deferred_jobs.defer(" in src
    # Cả khi không mở khóa được lẫn khi Lưu/Hoàn tất thất bại đều để cuối lượt.
    assert src.count("_defer(job, time_str, existing_creator)") >= 3
    assert "end_of_run=deferred_jobs.is_deferred_account(username)" in src
    assert 'keep_moi_time_keys=plan.get("deferred_time_keys")' in src
    assert "owner_name_for_account(" in src
