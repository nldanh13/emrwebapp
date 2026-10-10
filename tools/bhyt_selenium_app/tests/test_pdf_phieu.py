from __future__ import annotations

import unittest

from bhyt.mapping import DOC_BHXH
from bhyt.pdf_phieu import PhieuPdfError, parse_phieu_text


# Mô phỏng đúng text trích từ PDF phiếu phòng khám (in 2 liên, đơn vị bị xuống dòng).
SAMPLE = """TRƯỜNG ĐẠI HỌC Y DƯỢC CẦN THƠ
BỆNH VIỆN TRƯỜNG
ĐẠI HỌC Y DƯỢC CẦN THƠ

Liên số 1

Số: 260004779/KCB
Số seri: 0004779

GIẤY CHỨNG NHẬN
NGHỈ VIỆC HƯỞNG BẢO HIỂM XÃ HỘI
(chỉ áp dụng cho điều trị ngoại trú)

Ngày sinh: 18/11/2000

I. Thông tin người bệnh
Họ và tên: NGUYỄN THỊ NHƯ QUỲNH
Mã số BHXH/ Số thẻ BHXH: 8622295591 / DN4868622295591
Số CCCD/CMND/Định danh công dân/Hộ chiếu : 086300000786
Ngày cấp: 03/12/2025
Giới tính: Nữ
Đơn vị làm việc: CHI NHÁNH CÔNG TY TRÁCH NHIỆM HỮU
HẠN QUỐC TẾ TRI - VIET
Ngày khám bệnh, chữa bệnh: 24/09/2026
II. Chẩn đoán và phương pháp điều trị
S80.0 - Đụng giập tại đầu gối, M25.4 - Tràn dịch khớp, ,
Số ngày nghỉ: 2 ngày
(Từ ngày 24/09/2026 đến hết ngày 25/09/2026)
III. Thông tin cha, mẹ (chỉ áp dụng đối với trường hợp người bệnh là
trẻ em dưới 7 tuổi)
- Họ và tên cha:
- Họ và tên mẹ:

ĐẠI DIỆN ĐƠN VỊ
(Ký ghi rõ họ tên, đóng dấu)

Ngày 10 tháng 10 năm 2026
Người hành nghề KB, CB
(Ký, ghi rõ họ tên)

Liên số 2

Số: 260004779/KCB
Số seri: 0004779
"""


class ParsePhieuTests(unittest.TestCase):
    def test_extracts_all_fields(self):
        out = parse_phieu_text(SAMPLE)
        self.assertEqual(out["doc_type"], DOC_BHXH)
        f = out["fields"]
        self.assertEqual(f["so_kcb"], "260004779")       # bỏ phần "/KCB"
        self.assertEqual(f["so_seri"], "0004779")
        self.assertEqual(f["ho_ten"], "NGUYỄN THỊ NHƯ QUỲNH")
        self.assertEqual(f["ngay_sinh"], "18/11/2000")
        self.assertEqual(f["ma_bhxh"], "8622295591")
        self.assertEqual(f["ma_the"], "DN4868622295591")
        self.assertEqual(f["so_cccd"], "086300000786")
        self.assertEqual(f["ngaycap_cccd"], "03/12/2025")
        self.assertEqual(f["gioi_tinh"], "Nữ")
        self.assertEqual(f["ten_dv"], "CHI NHÁNH CÔNG TY TRÁCH NHIỆM HỮU HẠN QUỐC TẾ TRI - VIET")
        self.assertEqual(f["ngay_kcb"], "24/09/2026")
        self.assertEqual(f["chan_doan"], "S80.0 - Đụng giập tại đầu gối, M25.4 - Tràn dịch khớp")
        self.assertEqual(f["so_ngay_nghi"], "2")
        self.assertEqual(f["tu_ngay"], "24/09/2026")
        self.assertEqual(f["den_ngay"], "25/09/2026")
        self.assertEqual(f["ngay_ct"], "10/10/2026")
        self.assertEqual(f["mau_so"], "07")

    def test_empty_parent_names_are_dropped(self):
        f = parse_phieu_text(SAMPLE)["fields"]
        # Cha/mẹ bỏ trống trên phiếu -> không có khóa (không ghi đè bằng rỗng).
        self.assertNotIn("ho_ten_cha", f)
        self.assertNotIn("ho_ten_me", f)

    def test_rejects_non_certificate(self):
        with self.assertRaises(PhieuPdfError):
            parse_phieu_text("Một file PDF bất kỳ không phải giấy nghỉ.")

    def test_rejects_noi_tru(self):
        text = SAMPLE.replace("(chỉ áp dụng cho điều trị ngoại trú)", "(áp dụng cho điều trị nội trú)")
        with self.assertRaises(PhieuPdfError):
            parse_phieu_text(text)

    def test_empty_text_raises(self):
        with self.assertRaises(PhieuPdfError):
            parse_phieu_text("")


if __name__ == "__main__":
    unittest.main()
