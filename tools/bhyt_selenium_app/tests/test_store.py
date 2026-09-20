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


if __name__ == "__main__":
    unittest.main()
