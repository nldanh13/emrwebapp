# -*- coding: utf-8 -*-
import json

from input_procedures import _prepare_tasks, _merge_target_config


def test_prepare_direct_clinic_procedure_tasks(tmp_path):
    processed = tmp_path / "processed.json"
    targets = tmp_path / "targets.json"
    processed.write_text("[]", encoding="utf-8")
    targets.write_text(json.dumps({
        "clinicMode": True,
        "procedureTasks": [{
            "ma_bn": "99057116",
            "ho_ten": "NGƯỜI BỆNH THỬ",
            "ngay_lam": "10:10 20/05/2026",
            "service_name": "Thủ thuật phòng khám",
            "procedure_staff_name": "Nhân Viên A",
            "procedure_staff_role": "nurse",
        }]
    }, ensure_ascii=False), encoding="utf-8")

    tasks = _prepare_tasks(str(processed), str(targets))
    assert len(tasks) == 1
    assert tasks[0]["ma_bn"] == "99057116"
    assert tasks[0]["ngay_lam"] == "20/05/2026"
    assert tasks[0]["procedure_staff_name"] == "Nhân Viên A"
    assert tasks[0]["clinic_mode"] == "1"


def test_merge_clinic_procedure_config(tmp_path):
    targets = tmp_path / "targets.json"
    targets.write_text(json.dumps({
        "clinicProcedureConfig": {
            "url_login": "http://example/login.aspx",
            "username": "clinic_operator",
            "password": "secret",
            "headless": True,
            "procedure_template_name": "CTCH-thay băng",
        }
    }, ensure_ascii=False), encoding="utf-8")
    cfg = _merge_target_config({"username": "old"}, str(targets))
    assert cfg["username"] == "clinic_operator"
    assert cfg["password"] == "secret"
    assert cfg["url_login"].endswith("login.aspx")
    assert cfg["procedure_template_name"] == "CTCH-thay băng"
