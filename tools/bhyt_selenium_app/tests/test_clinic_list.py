from __future__ import annotations

import unittest

from bhyt.clinic_list import parse_clinic_patients


# Bảng danh sách khám bệnh rút gọn: cột theo tiêu đề (thứ tự bất kỳ vẫn đọc đúng).
HTML = """
<table>
  <tr><th>STT</th><th>Mã BN</th><th>Họ tên</th><th>Năm sinh</th><th>Giới tính</th>
      <th>Trạng thái</th><th>Nơi thực hiện</th><th>Xử trí</th></tr>
  <tr><td>1</td><td>BN001</td><td>NGUYỄN VĂN A</td><td>1990</td><td>Nam</td>
      <td>Hoàn tất</td><td>Phòng khám CT</td><td>Cho về</td></tr>
  <tr><td>2</td><td>BN002</td><td>TRẦN THỊ B</td><td>18/11/2015</td><td>Nữ</td>
      <td>Hoàn tất</td><td>Phòng khám CT</td><td>Cho về</td></tr>
</table>
"""

# Thứ tự cột khác (Họ tên trước Mã BN) để chứng minh dò theo tên cột, không theo chỉ số.
HTML_REORDERED = """
<table>
  <tr><th>Họ tên</th><th>Mã BN</th><th>Năm sinh</th><th>Trạng thái</th><th>Nơi thực hiện</th></tr>
  <tr><td>LÊ VĂN C</td><td>BN003</td><td>1985</td><td>Hoàn tất</td><td>PK</td></tr>
</table>
"""


class ParseClinicPatientsTests(unittest.TestCase):
    def test_reads_rows_by_header_name(self):
        rows = parse_clinic_patients(HTML)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["ho_ten"], "NGUYỄN VĂN A")
        self.assertEqual(rows[0]["nam_sinh"], "1990")
        self.assertEqual(rows[0]["gioi_tinh"], "Nam")
        self.assertEqual(rows[0]["ma_bn"], "BN001")
        # Ngày sinh dd/mm/yyyy -> rút năm.
        self.assertEqual(rows[1]["nam_sinh"], "2015")

    def test_column_order_independent(self):
        rows = parse_clinic_patients(HTML_REORDERED)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["ho_ten"], "LÊ VĂN C")
        self.assertEqual(rows[0]["nam_sinh"], "1985")
        self.assertEqual(rows[0]["ma_bn"], "BN003")

    def test_no_matching_table_returns_empty(self):
        self.assertEqual(parse_clinic_patients("<table><tr><th>Thuốc</th></tr></table>"), [])
        self.assertEqual(parse_clinic_patients(""), [])


if __name__ == "__main__":
    unittest.main()
