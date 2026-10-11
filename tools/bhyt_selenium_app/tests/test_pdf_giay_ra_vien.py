from __future__ import annotations

import unittest

from bhyt.mapping import DOC_BHXH, DOC_GRV, validate_fields
from bhyt.pdf_giay_ra_vien import is_grv_text, parse_grv_text
from bhyt.pdf_phieu import PhieuPdfError


# Mô phỏng text trích từ PDF giấy ra viện (mẫu TT 18/2022): nhiều nhãn chung một dòng,
# địa chỉ và chẩn đoán xuống dòng giữa chừng, ngày viết "ngày .. tháng .. năm".
SAMPLE = """SỞ Y TẾ: TP CẦN THƠ                       CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM
BV: BỆNH VIỆN TRƯỜNG ĐẠI HỌC Y DƯỢC CẦN THƠ   Độc lập - Tự do - Hạnh phúc
Khoa: Nội tổng hợp                              Mã y tế: 26012345
                                                Số lưu trữ: 2026/00123
GIẤY RA VIỆN
- Họ tên người bệnh: NGUYỄN VĂN AN    Ngày/tháng/năm sinh: 15/04/1988    Nam/Nữ: Nam
- Dân tộc: Kinh    Nghề nghiệp: Công nhân
- Mã số BHXH/Thẻ BHYT số: DN4799201234567
- Địa chỉ: 12 Nguyễn Văn Cừ, phường An Khánh,
thành phố Cần Thơ
- Vào viện lúc: 8 giờ 30 phút, ngày 01 tháng 10 năm 2026
- Ra viện lúc: 9 giờ 05 phút, ngày 05 tháng 10 năm 2026
- Chẩn đoán: J18.9 - Viêm phổi, không đặc hiệu;
E11 - Bệnh đái tháo đường type 2
- Phương pháp điều trị: Kháng sinh, điều trị nội khoa
- Ghi chú: Điều trị ngoại trú từ ngày 06/10/2026 đến hết ngày 12/10/2026
                                         Cần Thơ, ngày 05 tháng 10 năm 2026
THỦ TRƯỞNG ĐƠN VỊ                        TRƯỞNG KHOA
(Ký, ghi rõ họ tên, đóng dấu)            (Ký, ghi rõ họ tên)

                                         BS.CKII Phạm Việt Tân
"""


class ParseGrvTextTests(unittest.TestCase):
    def test_extracts_fields_for_portal_form_03(self):
        out = parse_grv_text(SAMPLE)
        f = out["fields"]
        self.assertEqual(out["doc_type"], DOC_GRV)
        self.assertEqual(out["mau_so"], "03")
        self.assertEqual(f["ma_khoa"], "Nội tổng hợp")
        self.assertEqual(f["so_seri"], "26012345")
        self.assertEqual(f["ma_ct"], "2026/00123")
        self.assertEqual(f["ho_ten"], "NGUYỄN VĂN AN")
        self.assertEqual(f["ngay_sinh"], "15/04/1988")
        self.assertEqual(f["gioi_tinh"], "Nam")
        self.assertEqual(f["dan_toc"], "Kinh")
        self.assertEqual(f["nghe_nghiep"], "Công nhân")
        self.assertEqual(f["ma_the"], "DN4799201234567")
        self.assertEqual(f["ma_bhxh"], "9201234567")
        self.assertEqual(f["dia_chi"], "12 Nguyễn Văn Cừ, phường An Khánh, thành phố Cần Thơ")
        self.assertEqual(f["tu_ngay"], "01/10/2026 08:30")
        self.assertEqual(f["den_ngay"], "05/10/2026 09:05")
        self.assertEqual(
            f["chan_doan"],
            "J18.9 - Viêm phổi, không đặc hiệu; E11 - Bệnh đái tháo đường type 2",
        )
        self.assertEqual(f["pp_dieutri"], "Kháng sinh, điều trị nội khoa")
        self.assertEqual(f["ghi_chu"], "Điều trị ngoại trú từ ngày 06/10/2026 đến hết ngày 12/10/2026")
        self.assertEqual(f["ngoaitru_tungay"], "06/10/2026")
        self.assertEqual(f["ngoaitru_denngay"], "12/10/2026")
        self.assertEqual(f["ngay_ct"], "05/10/2026")
        self.assertEqual(f["doctor_text"], "Phạm Việt Tân")
        self.assertEqual(f["loai_giay_to"], "Không có giấy tờ")

    def test_enough_fields_to_submit_form_03(self):
        # Giấy ra viện đủ thì hồ sơ sẵn sàng nhập cổng, không phải bổ sung tay.
        self.assertEqual(validate_fields(DOC_GRV, parse_grv_text(SAMPLE)["fields"]), [])

    def test_card_given_as_bhxh_and_card(self):
        text = SAMPLE.replace("DN4799201234567", "7912345678 / HC4797912345678")
        f = parse_grv_text(text)["fields"]
        self.assertEqual(f["ma_bhxh"], "7912345678")
        self.assertEqual(f["ma_the"], "HC4797912345678")

    def test_plain_dates_and_female(self):
        text = (SAMPLE.replace("Nam/Nữ: Nam", "Giới tính: Nữ")
                .replace("8 giờ 30 phút, ngày 01 tháng 10 năm 2026", "01/10/2026")
                .replace("9 giờ 05 phút, ngày 05 tháng 10 năm 2026", "05/10/2026"))
        f = parse_grv_text(text)["fields"]
        self.assertEqual(f["gioi_tinh"], "Nữ")
        self.assertEqual(f["tu_ngay"], "01/10/2026")
        self.assertEqual(f["den_ngay"], "05/10/2026")

    def test_unknown_doctor_left_empty(self):
        text = SAMPLE.replace("Phạm Việt Tân", "Người Ngoài Danh Sách")
        self.assertNotIn("doctor_text", parse_grv_text(text)["fields"])

    def test_rejects_other_documents(self):
        with self.assertRaises(PhieuPdfError):
            parse_grv_text("GIẤY CHỨNG NHẬN NGHỈ VIỆC HƯỞNG BẢO HIỂM XÃ HỘI")
        with self.assertRaises(PhieuPdfError):
            parse_grv_text("   ")

    def test_detects_type(self):
        self.assertTrue(is_grv_text(SAMPLE))
        self.assertFalse(is_grv_text("GIẤY CHỨNG NHẬN NGHỈ VIỆC (điều trị ngoại trú)"))
        self.assertNotEqual(DOC_GRV, DOC_BHXH)


if __name__ == "__main__":
    unittest.main()
