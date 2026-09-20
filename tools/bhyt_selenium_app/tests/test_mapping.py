from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from openpyxl import Workbook

from bhyt.mapping import DOC_BHXH, DOC_GRV, Record, load_records, normalize_text, validate_fields


class MappingTests(unittest.TestCase):
    def test_normalize_doctor_title(self):
        self.assertEqual(normalize_text("ThS.Bs. CKI Phan Văn Tuấn"), "phan van tuan")
        self.assertEqual(normalize_text("TS.Bs. Hoàng Minh Tú"), "hoang minh tu")

    def test_missing_so_kcb_is_blocking_for_bhxh(self):
        fields = {
            "ma_bhxh": "123", "ho_ten": "Nguyễn Văn A", "ngay_sinh": "01/01/1990",
            "chan_doan": "Cảm", "tu_ngay": "01/09/2026", "den_ngay": "02/09/2026",
            "doctor_text": "Phan Văn Tuấn", "ngay_ct": "02/09/2026", "so_kcb": "",
        }
        self.assertTrue(any("Số KCB" in issue for issue in validate_fields(DOC_BHXH, fields)))
        fields["so_kcb"] = "KCB-001"
        self.assertEqual(validate_fields(DOC_BHXH, fields), [])

    def test_record_key_is_stable(self):
        base = dict(doc_type=DOC_GRV, source_file="a.xlsx", source_sheet="S", source_row=2,
                    fields={"ho_ten": "Trần Minh An", "ma_bhxh": "001", "tu_ngay": "01/01/2026", "den_ngay": "02/01/2026"}, raw={})
        one = Record(**base)
        two = Record(**{**base, "source_file": "b.xlsx", "source_row": 99})
        self.assertEqual(one.record_key, two.record_key)

    def test_load_filters_doctor_and_preserves_leading_zero(self):
        wb = Workbook()
        ws = wb.active
        ws.append(["Họ tên", "Người hành nghề", "Điều trị từ ngày", "Số seri", "Mã số BH", "Ngày sinh", "Chẩn đoán", "Điều trị đến ngày", "Ngày chứng từ", "Số KCB"])
        ws.append(["Nguyễn A", "ThS.Bs. Phan Văn Tuấn", "01/09/2026", "S1", 123, "01/01/1990", "Cảm", "02/09/2026", "02/09/2026", "K1"])
        ws[2][4].number_format = "000000"
        ws.append(["Nguyễn B", "Bác sĩ ngoài danh sách", "01/09/2026", "S2", "999", "01/01/1990", "Cảm", "02/09/2026", "02/09/2026", "K2"])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "test.xlsx"
            wb.save(path)
            records = load_records([path], ["Phan Văn Tuấn"])
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].fields["ma_bhxh"], "000123")


if __name__ == "__main__":
    unittest.main()
