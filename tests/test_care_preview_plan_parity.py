# -*- coding: utf-8 -*-
"""
Nhập chăm sóc phải ra đúng những phiếu màn "Xem trước khi nhập" hiển thị.

Lỗi gốc: worker/input_care.py tự tính lại giờ và nội dung bằng Python, trong
khi màn Xem trước dựng bằng server/utils/patient_helpers/preview.js. Hai bản
lệch nhau: worker không tạo phiếu "Thực hiện cận lâm sàng" (07:00), bỏ mất
"Xét nghiệm đường máu mao mạch…" ở 16:00, không có "Mời bác sĩ khám"...

Nay máy chủ gắn preview.care vào dữ liệu gửi worker (attachCarePreviewPlans)
và worker dựng job từ đó. Test này chạy CHÍNH hàm Node của màn hình rồi đưa
kết quả qua hàm Python của worker, so từng phiếu.
"""
import json
import os
import shutil
import subprocess

import pytest

from input_care_utils import (
    regular_care_jobs_from_preview,
    build_regular_care_hours,
    them_cham_soc_mac_dinh,
)
from care_templates import extract_actions_by_hour, extract_action_care_labels_by_hour

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "care_preview_plan_day.json")

NODE = shutil.which("node")
needs_node = pytest.mark.skipif(not NODE, reason="cần Node để chạy hàm dựng Xem trước")

NODE_SCRIPT = r"""
const path = require('path');
const root = process.argv[1];
const rows = require(process.argv[2]);
const { attachCarePreviewPlans, buildPatientDayBundle } = require(path.join(root, 'server/utils/patient_helpers/bundle'));
const withPlan = attachCarePreviewPlans(rows, {});
const r = rows[0];
const bundle = buildPatientDayBundle(rows, r.ma_bn, r.ngay_lam, {}, {});
process.stdout.write(JSON.stringify({ rows: withPlan, preview: bundle.preview.care }));
"""


def _run_node():
    out = subprocess.run(
        [NODE, "-e", NODE_SCRIPT, ROOT, FIXTURE],
        capture_output=True, text=True, encoding="utf-8", check=True, timeout=60,
    )
    return json.loads(out.stdout)


@needs_node
def test_worker_jobs_equal_preview_items():
    data = _run_node()
    preview = data["preview"]
    entry = data["rows"][0]
    actions = extract_actions_by_hour(entry.get("chi_dinh_khac") or {})

    jobs = regular_care_jobs_from_preview(entry.get("care_preview_plan"), actions)

    assert jobs is not None
    assert [(j["time_str"], j["preview_dien_bien"], j["preview_care"]) for j in jobs] == [
        (p["time_full"], p["dien_bien"], p["cham_soc"]) for p in preview
    ]
    # Đúng các phiếu người dùng thấy trên màn hình.
    by_time = {j["time_str"]: j["preview_care"] for j in jobs}
    assert by_time["07:00 09/11/2026"] == "Thực hiện cận lâm sàng"
    assert by_time["16:00 09/11/2026"] == (
        "Lấy dấu hiệu sinh tồn + Xét nghiệm đường máu mao mạch tại giường (một lần)[Nội trú]"
    )
    assert by_time["08:00 09/11/2026"] == (
        "Thực hiện chỉ định thuốc + Thay băng, cắt chỉ vết mổ [chiều dài ≤ 15cm]"
    )
    # Thay băng vẫn được chuyển cho guard "vết mổ" để không bị cắt nhầm.
    job8 = next(j for j in jobs if j["hour"] == 8)
    assert "THAY_BANG" in job8["actions_set"]


def test_old_python_rule_misses_preview_rows():
    """Ghi lại vì sao phải dùng kế hoạch Xem trước: cách tính cũ thiếu phiếu."""
    with open(FIXTURE, encoding="utf-8") as f:
        entry = json.load(f)[0]
    cdk = entry["chi_dinh_khac"]
    actions = extract_actions_by_hour(cdk)
    labels = extract_action_care_labels_by_hour(cdk)
    hours, _ = build_regular_care_hours(set(entry["tong_hop_gio_dung"]), actions, labels)
    assert 7 not in hours  # không có phiếu "Thực hiện cận lâm sàng"
    care16 = them_cham_soc_mac_dinh([], 16, set(entry["tong_hop_gio_dung"]))
    assert care16 == ["Lấy dấu hiệu sinh tồn"]  # mất "Xét nghiệm đường máu mao mạch"


def test_plan_missing_or_foreign_falls_back():
    assert regular_care_jobs_from_preview(None) is None
    assert regular_care_jobs_from_preview({"source": "khac", "items": []}) is None
    assert regular_care_jobs_from_preview({"source": "preview.care"}) is None
    assert regular_care_jobs_from_preview({"source": "preview.care", "items": []}) == []


def test_special_items_left_to_special_events_and_minutes_kept():
    plan = {
        "source": "preview.care",
        "items": [
            {"time_full": "13:35 09/11/2026", "dien_bien": "x", "cham_soc": "Nhận hồ sơ", "special_type": "postop_receive"},
            {"time_full": "08:30 09/11/2026", "dien_bien": "", "cham_soc": "Thay băng"},
            {"time_full": "08:30 09/11/2026", "dien_bien": "", "cham_soc": "Thay băng"},
            {"time_full": "không rõ", "dien_bien": "", "cham_soc": "?"},
        ],
    }
    jobs = regular_care_jobs_from_preview(plan)
    assert [(j["time_str"], j["hour"], j["preview_dien_bien"]) for j in jobs] == [
        ("08:30 09/11/2026", 8, "Người bệnh tỉnh"),
    ]
