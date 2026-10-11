# -*- coding: utf-8 -*-
"""No EMR access: check resident Chrome worker validation, protocol and cleanup."""
import io
import json
import sys

import pytest

import hchanh_read_daemon as daemon
import hchanh_fetch as core


def make_command(tmp_path, names=("discharge", "cls")):
    src = tmp_path / "hchanh" / "input.json"
    src.parent.mkdir(exist_ok=True)
    src.write_text(json.dumps([{"ma_bn": "fake_patient"}]), encoding="utf-8")
    return {
        "op": "records_check", "id": "test-1", "input": str(src),
        "output": str(src.parent / "output.json"),
        "files": list(names), "headless": True, "status": "Hoàn tất",
    }


def test_valid_records_batch_stays_read_only_and_has_chrome_quota(tmp_path):
    result = daemon.validate_command(make_command(tmp_path), str(tmp_path))
    assert result["scope"] == "discharge"
    assert result["files"] == ["discharge", "cls"]
    assert result["keep_alive"] is True
    assert result["batch_size"] == 30


@pytest.mark.parametrize("patch", [
    {"op": "write_emr"}, {"headless": False}, {"status": "Đang thực hiện"},
    {"files": ["surgery"]}, {"files": []},
])
def test_rejects_any_non_readonly_or_non_records_check_request(tmp_path, patch):
    cmd = {**make_command(tmp_path), **patch}
    with pytest.raises(ValueError):
        daemon.validate_command(cmd, str(tmp_path))


def test_rejects_file_paths_outside_workspace(tmp_path):
    cmd = make_command(tmp_path)
    other = tmp_path.parent / "not_this_workspace" / "results.json"
    cmd["output"] = str(other)
    with pytest.raises(ValueError, match="ngoài workspace"):
        daemon.validate_command(cmd, str(tmp_path))


def test_rejects_over_ten_rows(tmp_path):
    cmd = make_command(tmp_path)
    with open(cmd["input"], "w", encoding="utf-8") as f:
        json.dump([{"ma_bn": str(i)} for i in range(11)], f)
    with pytest.raises(ValueError, match="10 hồ sơ"):
        daemon.validate_command(cmd, str(tmp_path))


def test_protocol_runs_multiple_tasks_with_one_python_process_and_closes(monkeypatch, tmp_path):
    cmd = make_command(tmp_path)
    cmd2 = {**cmd, "id": "test-2"}
    inp = io.StringIO("\n".join([json.dumps(cmd), json.dumps(cmd2)]) + "\n")
    out = io.StringIO()
    calls, cleanup = [], []
    monkeypatch.setattr(sys, "stdin", inp)
    monkeypatch.setattr(sys, "stdout", out)
    monkeypatch.setattr(core, "run_hchanh_fetch_batch", lambda **kwargs:
                        calls.append(kwargs) or 0)
    monkeypatch.setattr(core, "_shutdown_hchanh_click_driver", lambda:
                        cleanup.append(True))
    daemon.serve(str(tmp_path))
    replies = [json.loads(x) for x in out.getvalue().splitlines()]
    assert replies == [{"id": "test-1", "code": 0}, {"id": "test-2", "code": 0}]
    assert len(calls) == 2
    assert all(c["keep_alive"] for c in calls)
    assert cleanup == [True]


def test_batch_wrapper_still_closes_browser_by_default(monkeypatch):
    # Existing per-process CLI must retain old cleanup contract.
    calls = []
    monkeypatch.setattr(core, "_run_hchanh_fetch_batch_impl", lambda *a: 0)
    monkeypatch.setattr(core, "_shutdown_hchanh_click_driver", lambda: calls.append("closed"))
    core.run_hchanh_fetch_batch("in", "out", "discharge", [], "", "")
    assert calls == ["closed"]


def test_resident_batch_wrapper_does_not_close_until_owner_exits(monkeypatch):
    calls = []
    monkeypatch.setattr(core, "_run_hchanh_fetch_batch_impl", lambda *a: 0)
    monkeypatch.setattr(core, "_shutdown_hchanh_click_driver", lambda: calls.append("closed"))
    core.run_hchanh_fetch_batch("in", "out", "discharge", [], "", "", keep_alive=True)
    assert calls == []


def test_rejects_unsafe_per_patient_file_override(tmp_path):
    cmd = make_command(tmp_path)
    with open(cmd["input"], "w", encoding="utf-8") as f:
        json.dump([{"ma_bn": "fake", "_files_override": ["discharge", "surgery"]}], f)
    with pytest.raises(ValueError, match="Ra Khoa và CLS"):
        daemon.validate_command(cmd, str(tmp_path))


def test_accepts_only_read_only_per_patient_subset(tmp_path):
    cmd = make_command(tmp_path)
    with open(cmd["input"], "w", encoding="utf-8") as f:
        json.dump([{"ma_bn": "fake", "_files_override": ["cls"]}], f)
    assert daemon.validate_command(cmd, str(tmp_path))["files"] == ["discharge", "cls"]


def test_rejects_malformed_row_and_files(tmp_path):
    cmd = make_command(tmp_path)
    with open(cmd["input"], "w", encoding="utf-8") as f:
        json.dump(["not a patient object"], f)
    with pytest.raises(ValueError):
        daemon.validate_command(cmd, str(tmp_path))
    cmd["files"] = ["discharge", {"file": "cls"}]
    with pytest.raises(ValueError):
        daemon.validate_command(cmd, str(tmp_path))


def test_reused_chrome_does_not_trust_embedded_login_page():
    from types import SimpleNamespace
    assert not core._is_driver_alive(SimpleNamespace(
        current_url="http://hospital.test/home.aspx?usid=a",
        execute_script=lambda script: True,
    ))
    assert core._is_driver_alive(SimpleNamespace(
        current_url="http://hospital.test/home.aspx?usid=a",
        execute_script=lambda script: False,
    ))
