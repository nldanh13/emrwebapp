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


# Đúng bố cục giấy ra viện thật của bệnh viện (MS: 01/BV-01) như pdfminer trích theo dòng
# (extract_grv_text), dữ liệu người bệnh đã thay bằng dữ liệu giả.
REAL_LAYOUT = """TRƯỜNG ĐẠI HỌC Y DƯỢC CẦN THƠ CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM MS: 01/BV-01

BỆNH VIỆN Độc lập - Tự do - Hạnh phúc Số hồ sơ/Số BA:

Số:

100001/2026/GRV

      GIẤY RA VIỆN

- Họ tên người bệnh: TRẦN THỊ MẪU

- Ngày/tháng/năm sinh: 02/03/1985 (Tuổi: 41 tuổi) Nam/nữ: Nữ
- Dân tộc: Kinh Nghề nghiệp: Không xác định

- Số CCCD/CMND/Định Danh công dân/Hộ chiếu: 092000000001. Ngày cấp: 07/02/2025

- Mã số BHXH/Thẻ BHYT: DN 4 92 92 01234567 Giá trị từ:  01/10/2026  đến:  31/12/2026

- Địa chỉ:  Kv 1 ,Phường Ô Môn, Thành phố Cần Thơ

- Vào viện lúc:  01 giờ 56 phút, ngày 01 tháng 10 năm 2026

- Ra viện lúc :  13 giờ 00 phút, ngày 08 tháng 10 năm 2026

- Chẩn đoán: S42.20-Gãy phần trên xương cánh tay, gãy kín; S40.0-Chấn động vai và cánh tay,
I25.5-Bệnh cơ tim do thiếu máu cục bộ

- Phương pháp điều trị: Kết hợp xương đầu trên xương cánh tay trái

- Ghi chú: Uống thuốc theo toa, tái khám thứ  3 ngày 
20/10/2026. Nghỉ ốm từ ngày 09/10/2026 đến hết ngày 19/10/2026. 

Ngày 08 tháng 10 năm 2026

Đại diện đơn vị

 Người hành nghề khám bệnh, chữa bệnh

(Ký, ghi rõ họ tên, đóng dấu)

(Ký, ghi rõ họ tên)
"""


class RealLayoutTests(unittest.TestCase):
    def test_hospital_discharge_paper(self):
        f = parse_grv_text(REAL_LAYOUT)["fields"]
        self.assertEqual(f["ma_ct"], "100001/2026/GRV")
        self.assertEqual(f["ho_ten"], "TRẦN THỊ MẪU")
        self.assertEqual(f["ngay_sinh"], "02/03/1985")
        self.assertEqual(f["gioi_tinh"], "Nữ")
        self.assertEqual(f["dan_toc"], "Kinh")
        self.assertEqual(f["nghe_nghiep"], "Không xác định")
        self.assertEqual(f["so_cccd"], "092000000001")
        self.assertEqual(f["ngaycap_cccd"], "07/02/2025")
        # Thẻ in tách ô, sau đó là hạn thẻ: ghép lại 15 ký tự, mã BHXH = 10 số cuối.
        self.assertEqual(f["ma_the"], "DN4929201234567")
        self.assertEqual(f["ma_bhxh"], "9201234567")
        self.assertEqual(f["dia_chi"], "Kv 1 ,Phường Ô Môn, Thành phố Cần Thơ")
        self.assertEqual(f["tu_ngay"], "01/10/2026 01:56")
        self.assertEqual(f["den_ngay"], "08/10/2026 13:00")
        self.assertTrue(f["chan_doan"].startswith("S42.20-Gãy phần trên"))
        self.assertTrue(f["chan_doan"].endswith("thiếu máu cục bộ"))
        self.assertEqual(f["pp_dieutri"], "Kết hợp xương đầu trên xương cánh tay trái")
        self.assertIn("Nghỉ ốm từ ngày 09/10/2026", f["ghi_chu"])
        self.assertEqual(f["nghi_tu_ngay"], "09/10/2026")
        self.assertEqual(f["nghi_den_ngay"], "19/10/2026")
        self.assertEqual(f["ngay_ct"], "08/10/2026")
        # Có CCCD thì không đặt "Không có giấy tờ" (lấy loại giấy tờ từ EMR).
        self.assertNotIn("loai_giay_to", f)
        # Giấy không in khoa và tên bác sĩ: phải lấy từ nơi khác.
        self.assertNotIn("ma_khoa", f)
        self.assertNotIn("doctor_text", f)


if __name__ == "__main__":
    unittest.main()
