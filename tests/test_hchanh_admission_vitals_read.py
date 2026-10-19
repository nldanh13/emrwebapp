"""Phiếu vào viện: đọc 7 ô sinh hiệu trong một lần, phiếu thiếu ô không phải chờ từng ô."""
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

import hchanh_fetch as core  # noqa: E402

MAPPING = {
    "mach_vao_vien": "txtMach",
    "nhiet_do_vao_vien": "txtNhietDo",
    "huyet_ap_tam_thu_vao_vien": "txtHuyetApMax",
    "huyet_ap_tam_truong_vao_vien": "txtHuyetApMin",
    "nhip_tho_vao_vien": "txtNhipTho",
    "can_nang_vao_vien": "txtCanNang",
    "chieu_cao_vao_vien": "txtChieuCao",
}


class FakeFormDriver:
    def __init__(self, fields, appear_at=0.0, fill_at=0.0):
        self.fields = fields
        self.start = time.time()
        self.appear_at = appear_at
        self.fill_at = fill_at
        self.calls = 0

    def execute_script(self, script, ids):
        self.calls += 1
        elapsed = time.time() - self.start
        if elapsed < self.appear_at:
            return {"present": 0, "values": {}}
        filled = elapsed >= self.fill_at
        vals = {i: (self.fields[i] if filled else "") for i in ids if i in self.fields}
        return {"present": len(vals), "values": vals}


def test_missing_fields_do_not_cost_extra_waits():
    # Phiếu chỉ có mạch và nhiệt độ: trước đây 5 ô thiếu x 4 giây = 20 giây.
    driver = FakeFormDriver({"txtMach": "88", "txtNhietDo": "37.2"})
    started = time.time()
    out = core._read_admission_vitals_fields(driver, MAPPING, timeout=8, poll_interval=0.05)
    assert time.time() - started < 1
    assert out["mach_vao_vien"] == "88"
    assert out["nhiet_do_vao_vien"] == "37.2"
    assert out["chieu_cao_vao_vien"] == ""
    assert driver.calls == 1


def test_waits_for_form_to_appear_and_late_fill():
    fields = {i: "1" for i in MAPPING.values()}
    driver = FakeFormDriver(fields, appear_at=0.3, fill_at=0.6)
    out = core._read_admission_vitals_fields(driver, MAPPING, timeout=3, fill_grace=1.5, poll_interval=0.05)
    assert all(v == "1" for v in out.values())


def test_form_never_appears_returns_empty_after_timeout():
    driver = FakeFormDriver({}, appear_at=99)
    started = time.time()
    out = core._read_admission_vitals_fields(driver, MAPPING, timeout=0.5, poll_interval=0.05)
    assert set(out.values()) == {""}
    assert time.time() - started < 2
