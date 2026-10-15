# -*- coding: utf-8 -*-
"""Nhập chăm sóc bệnh phòng: phiếu của ai lập bằng tài khoản EMR của người đó.

EMR không còn cho Thu hồi để đổi Người lập. Trước đây cả lượt đăng nhập một
tài khoản ca làm rồi Thu hồi → đổi Người lập sang người trực → Hoàn tất; nay mỗi
phiếu được tạo bằng tài khoản của người phụ trách giờ đó, người chưa có tài
khoản EMR thì không nhập phiếu đó."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

from care_owner_accounts import group_jobs_by_owner_account, shift_kind_for_hour

ACCOUNTS = {
    "Thạch Thị Thúy Đa": {"username": "tttda", "password": "pw-da"},
    "Võ Thị Yến Nhi": {"username": "vtynhi", "password": "pw-nhi"},
}
SCHEDULE = {"08": "Thạch Thị Thúy Đa", "16": "Thạch Thị Thúy Đa", "05": "Võ Thị Yến Nhi", "20": "Lê Văn Chưa Có", "12": ""}


def _owner(time_str):
    return SCHEDULE[time_str[:2]]


def _job(hhmm, hour):
    return {"time_str": f"{hhmm} 05/10/2026", "hour": hour}


def test_each_job_goes_to_its_own_nurse_account():
    jobs = [_job("08:00", 8), _job("16:00", 16), _job("05:00", 5)]
    g = group_jobs_by_owner_account(jobs, _owner, ACCOUNTS.get)
    assert {u: [j["time_str"][:5] for j in js] for u, js in g["jobs_by_account"].items()} == {
        "tttda": ["08:00", "16:00"],
        "vtynhi": ["05:00"],
    }
    assert g["owners"] == {"tttda": "Thạch Thị Thúy Đa", "vtynhi": "Võ Thị Yến Nhi"}
    assert g["passwords"] == {"tttda": "pw-da", "vtynhi": "pw-nhi"}
    assert g["shift_kinds"] == {"tttda": ["work"], "vtynhi": ["oncall"]}
    assert g["blocked"] == []
    assert jobs[2]["owner"] == "Võ Thị Yến Nhi"


def test_nurse_without_emr_account_or_schedule_is_blocked_not_entered_under_other_name():
    jobs = [_job("08:00", 8), _job("20:00", 20), _job("12:00", 12)]
    g = group_jobs_by_owner_account(jobs, _owner, ACCOUNTS.get)
    assert list(g["jobs_by_account"]) == ["tttda"]
    assert len(g["blocked"]) == 2
    assert "chưa có tài khoản EMR của Lê Văn Chưa Có" in g["blocked"][0]
    assert "Thiết lập tài khoản" in g["blocked"][0]
    assert "chưa có điều dưỡng phụ trách" in g["blocked"][1]
    assert all("pw-" not in m for m in g["blocked"])


def test_shift_kind_matches_schedule_rule():
    assert [shift_kind_for_hour(h) for h in (5, 7, 10, 11, 13, 16, 17, 23)] == [
        "oncall", "work", "work", "oncall", "work", "work", "oncall", "oncall",
    ]


def _src():
    return (WORKER / "input_care.py").read_text(encoding="utf-8")


def test_input_care_no_longer_renames_after_hoan_tat_or_keeps_single_login():
    src = _src()
    assert "doi_nguoi_lap_sau_hoan_tat" not in src
    assert "dat_nguoi_lap_ve_chu_tai_khoan" not in src
    assert "DeferredCreatorJobs" not in src
    # Lượt nhập chăm sóc phải đổi được sang tài khoản từng người lập.
    assert 'login_config.pop("single_login", None)' in src
    assert "ws.switch_account(username, password)" in src


def test_input_care_recreates_sheet_owned_by_someone_else_instead_of_editing():
    src = _src()
    to_edit = src.index('stt = "EDIT"')
    update = src.index('if stt == "UPDATE":', to_edit)
    assert "not cung_nguoi_lap(existing_creator, current_owner_name)" in src[to_edit - 400:to_edit]
    assert to_edit < update


def test_input_care_does_not_create_duplicate_when_old_sheet_cannot_be_deleted():
    src = _src()
    edit = src.index('elif stt == "EDIT":')
    fallback = src.index("if not ws.run_with_creator_fallback(existing_creator", edit)
    recreate = src.index('print("-> TẠO LẠI."', edit)
    block = src[fallback:recreate]
    assert "job_failures.append(msg_del)" in block
    assert "return" in block.split("job_failures.append(msg_del)")[1]
