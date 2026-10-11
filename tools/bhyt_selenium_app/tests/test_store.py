from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from bhyt.mapping import DOC_BHXH, Record
from bhyt.store import Store


class StoreTests(unittest.TestCase):
    def make_record(self):
        fields = {"ho_ten": "Nguyễn A", "doctor_text": "Phan Văn Tuấn", "ma_bhxh": "123",
                  "ngay_sinh": "01/01/1990", "chan_doan": "Cảm", "tu_ngay": "01/09/2026",
                  "den_ngay": "02/09/2026", "ngay_ct": "02/09/2026", "so_kcb": ""}
        record = Record(DOC_BHXH, "test.xlsx", "S", 2, fields, {})
        record.issues = ["Thiếu Số KCB (file xuất không có cột này)"]
        return record

    def test_import_deduplicates_and_update_revalidates(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "test.sqlite3")
            self.assertEqual(store.import_records([self.make_record()])["added"], 1)
            self.assertEqual(store.import_records([self.make_record()])["updated"], 1)
            rows = store.list_records()
            self.assertEqual(len(rows), 1)
            self.assertFalse(rows[0]["ready"])
            store.update_fields(rows[0]["id"], {"so_kcb": "KCB-001"})
            self.assertTrue(store.get_record(rows[0]["id"])["ready"])
            # Re-importing the same source must not erase local supplemental data.
            store.import_records([self.make_record()])
            self.assertEqual(store.get_record(rows[0]["id"])["fields"]["so_kcb"], "KCB-001")
            store.mark(rows[0]["id"], "success", "OK", increment_attempt=True)
            saved = store.get_record(rows[0]["id"])
            self.assertEqual(saved["status"], "success")
            self.assertEqual(saved["attempt_count"], 1)


class SickLeaveAnswerTests(unittest.TestCase):
    # Thẻ DN: người dùng trả lời "có/không nghỉ ốm"; quét lại không được hỏi lại.
    def grv(self, ghi_chu="Uống thuốc theo toa"):
        from bhyt.mapping import DOC_GRV, validate_fields
        fields = {"ho_ten": "Trần B", "ma_ct": "100001/2026/GRV", "ma_the": "DN4929201234567",
                  "ghi_chu": ghi_chu, "hoi_nghi_om": "can_hoi"}
        record = Record(DOC_GRV, "EMR-phieu", "danh-sach-ra-vien", 0, fields, {})
        record.issues = validate_fields(DOC_GRV, fields)
        return record

    def test_answers_survive_rescan(self):
        from bhyt.mapping import SICK_LEAVE_NO, SICK_LEAVE_QUESTION
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "t.sqlite3")
            store.import_records([self.grv()])
            rid = store.list_records()[0]["id"]
            self.assertIn(SICK_LEAVE_QUESTION, store.get_record(rid)["issues"])

            store.answer_sick_leave(rid, True, "09/10/2026", "19/10/2026")
            rec = store.get_record(rid)
            self.assertEqual(rec["fields"]["hoi_nghi_om"], "co")
            self.assertIn("Nghỉ ốm từ ngày 09/10/2026 đến hết ngày 19/10/2026", rec["fields"]["ghi_chu"])
            self.assertNotIn(SICK_LEAVE_QUESTION, rec["issues"])
            store.import_records([self.grv()])  # quét lại cùng giấy
            rec = store.get_record(rid)
            self.assertEqual(rec["fields"]["hoi_nghi_om"], "co")
            self.assertIn("Nghỉ ốm từ ngày 09/10/2026", rec["fields"]["ghi_chu"])

            store.answer_sick_leave(rid, False)
            store.import_records([self.grv()])
            rec = store.get_record(rid)
            self.assertEqual(rec["fields"]["hoi_nghi_om"], "khong")
            self.assertIn(SICK_LEAVE_NO, rec["issues"])  # không nghỉ thì không bao giờ nhập

    def test_yes_needs_dates(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "t.sqlite3")
            store.import_records([self.grv()])
            rid = store.list_records()[0]["id"]
            with self.assertRaises(ValueError):
                store.answer_sick_leave(rid, True, "", "")


if __name__ == "__main__":
    unittest.main()
