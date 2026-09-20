from __future__ import annotations

import unittest
from unittest.mock import patch

from bhyt.emrwebapp_client import (
    WebAppError,
    _grv_state_key,
    fetch_records_from_webapp,
    review_has_issue,
)
from bhyt.mapping import DOC_BHXH, DOC_GRV


class FakeResponse:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self.ok = 200 <= status_code < 300
        self._payload = payload

    def json(self):
        return self._payload


OUTPATIENT_ROW_OK = {
    "dong_nguon": "7",
    "ho_ten": "HỒ VĂN PHÚ",
    "ngay_sinh": "20/11/1988",
    "gioi_tinh": "Nam",
    "ma_so_bh": "7914085118",
    "ma_the": "DN4867914085118",
    "chan_doan": "M47.8 - Thoái hóa cột sống",
    "don_vi": "Công ty TNHH Hằng Đại",
    "dieu_tri_tu_ngay": "18/09/2026",
    "dieu_tri_den_ngay": "22/09/2026",
    "nguoi_hanh_nghe": "Phan Văn Tuấn",
    "thu_truong": "Bs Lê Thanh Vũ",
    "ngay_chung_tu": "18/09/2026",
    "so_loi_ra_soat": "0",
    "ghi_chu_bo_sung": "Đầy đủ thông tin bắt buộc",
}

OUTPATIENT_ROW_FLAGGED = {**OUTPATIENT_ROW_OK, "ho_ten": "NGUYỄN VĂN LỖI", "ghi_chu_bo_sung": "Thiếu Thủ trưởng"}

INPATIENT_ROW_OK = {
    "dong_nguon": "6",
    "ho_ten": "Trần Minh An",
    "ngay_sinh": "14/05/1978",
    "gioi_tinh": "Nam",
    "ma_so_bh": "9116006676",
    "ma_the": "DN4919116006676",
    "khoa": "Khoa Chấn thương chỉnh hình",
    "chan_doan": "M65-Viêm màng hoạt dịch",
    "phuong_phap_dieu_tri": "phẫu thuật",
    "ngay_vao_vien": "14/09/2026 07:30",
    "ngay_ra_vien": "17/09/2026 13:00",
    "truong_khoa": "Nguyễn Lê Hoan",
    "thu_truong_don_vi": "BS.CKII. Nguyễn Thanh Vũ",
    "ngay_chung_tu": "17/09/2026",
    "ghi_chu": "Ổn định",
}

INPATIENT_ROW_SUBMITTED = {**INPATIENT_ROW_OK, "ho_ten": "Lê Đã Nộp"}


def make_get(import_payload, state_entries=None):
    def fake_get(url, headers=None, timeout=None):
        if url.endswith("/api/sick-leave-import"):
            return FakeResponse(200, {"status": "ok", "import": import_payload})
        if url.endswith("/api/sick-leave-state"):
            return FakeResponse(200, {"status": "ok", "entries": state_entries or {}})
        raise AssertionError(f"unexpected url: {url}")
    return fake_get


class EmrwebappClientTests(unittest.TestCase):
    def test_maps_fields_and_skips_flagged_row(self):
        payload = {"outpatient": [OUTPATIENT_ROW_OK, OUTPATIENT_ROW_FLAGGED], "inpatient": []}
        with patch("bhyt.emrwebapp_client.requests.get", side_effect=make_get(payload)):
            records, stats = fetch_records_from_webapp("http://host:3001", "sess-1")
        self.assertEqual(len(records), 1)
        self.assertEqual(stats["skipped_issue"], 1)
        record = records[0]
        self.assertEqual(record.doc_type, DOC_BHXH)
        self.assertEqual(record.fields["ho_ten"], "HỒ VĂN PHÚ")
        self.assertEqual(record.fields["ma_bhxh"], "7914085118")
        self.assertEqual(record.fields["tu_ngay"], "18/09/2026")
        self.assertEqual(record.fields["den_ngay"], "22/09/2026")
        self.assertEqual(record.fields["doctor_text"], "Phan Văn Tuấn")
        self.assertEqual(record.fields["nguoi_dai_dien"], "Bs Lê Thanh Vũ")
        self.assertEqual(record.fields["so_kcb"], "")  # luôn thiếu, cần bổ sung tay qua nút "Bổ sung"
        self.assertTrue(any("Số KCB" in issue for issue in record.issues))

    def test_skips_row_already_marked_submitted(self):
        payload = {"outpatient": [], "inpatient": [INPATIENT_ROW_OK, INPATIENT_ROW_SUBMITTED]}
        state = {_grv_state_key(INPATIENT_ROW_SUBMITTED): {"submitted": True}}
        with patch("bhyt.emrwebapp_client.requests.get", side_effect=make_get(payload, state)):
            records, stats = fetch_records_from_webapp("http://host:3001", "sess-1")
        self.assertEqual(len(records), 1)
        self.assertEqual(stats["skipped_submitted"], 1)
        self.assertEqual(records[0].fields["ho_ten"], "Trần Minh An")
        self.assertEqual(records[0].doc_type, DOC_GRV)
        self.assertEqual(records[0].fields["ma_khoa"], "Khoa Chấn thương chỉnh hình")
        self.assertEqual(records[0].fields["ghi_chu"], "Ổn định")

    def test_filters_by_allowed_doctor(self):
        payload = {"outpatient": [OUTPATIENT_ROW_OK], "inpatient": []}
        with patch("bhyt.emrwebapp_client.requests.get", side_effect=make_get(payload)):
            records, stats = fetch_records_from_webapp(
                "http://host:3001", "sess-1", allowed_doctors=["Someone Else"]
            )
        self.assertEqual(len(records), 0)
        self.assertEqual(stats["skipped_doctor"], 1)

    def test_raises_when_missing_session_id(self):
        with self.assertRaises(WebAppError):
            fetch_records_from_webapp("http://host:3001", "")

    def test_raises_when_no_data_at_all(self):
        payload = {"outpatient": [], "inpatient": []}
        with patch("bhyt.emrwebapp_client.requests.get", side_effect=make_get(payload)):
            with self.assertRaises(WebAppError):
                fetch_records_from_webapp("http://host:3001", "sess-1")

    def test_raises_on_401(self):
        def fake_get(url, headers=None, timeout=None):
            return FakeResponse(401, {})
        with patch("bhyt.emrwebapp_client.requests.get", side_effect=fake_get):
            with self.assertRaises(WebAppError):
                fetch_records_from_webapp("http://host:3001", "sess-1")

    def test_review_has_issue_matches_missing_note_and_error_count(self):
        self.assertTrue(review_has_issue({"ra_soat_ghi_chu_bo_sung": "Thiếu GHI CHÚ"}))
        self.assertTrue(review_has_issue({"so_loi_ra_soat": "2"}))
        self.assertFalse(review_has_issue({"ghi_chu_bo_sung": "Đầy đủ thông tin bắt buộc"}))


if __name__ == "__main__":
    unittest.main()
