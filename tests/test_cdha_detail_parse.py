# -*- coding: utf-8 -*-
"""
Test thuần cho _parse_cdha_detail_html — phần dò nhãn "Kết luận"/"Mô tả" trong
HTML chi tiết 1 kết quả CĐHA (server/services BHYT tiền giám định dùng để hỏi
"kết quả bất thường không"). Đây là logic BEST-EFFORT, CHƯA xác nhận bằng HTML
EMR thật (xem ghi chú trong worker/hchanh_fetch.py ngay trước hàm) — test này chỉ
đảm bảo hàm dò nhãn hoạt động đúng với các cấu trúc HTML giả định hợp lý, không
đảm bảo khớp với trang thật của EMR.
"""

from hchanh_fetch import _parse_cdha_detail_html


def test_extracts_ket_luan_from_label_td_pair():
    html = '''
    <table>
      <tr><td>Kết luận</td><td>Gãy kín 1/3 giữa xương chày phải</td></tr>
    </table>
    '''
    out = _parse_cdha_detail_html(html)
    assert out["ket_luan"] == "Gãy kín 1/3 giữa xương chày phải"
    assert out["_detail_unverified"] is True


def test_extracts_multiple_labels():
    html = '''
    <div>
      <label>Mô tả:</label>
      <div>Hình ảnh mờ vùng đáy phổi phải.</div>
      <label>Kết luận:</label>
      <div>Viêm phổi thùy dưới phải.</div>
    </div>
    '''
    out = _parse_cdha_detail_html(html)
    assert out["mo_ta"] == "Hình ảnh mờ vùng đáy phổi phải."
    assert out["ket_luan"] == "Viêm phổi thùy dưới phải."


def test_no_matching_label_still_keeps_raw_text():
    html = '<div>Nội dung tự do không có nhãn rõ ràng.</div>'
    out = _parse_cdha_detail_html(html)
    assert "ket_luan" not in out
    assert "Nội dung tự do" in out["_raw_text"]
    assert out["_detail_unverified"] is True


def test_empty_html_does_not_raise():
    out = _parse_cdha_detail_html("")
    assert out["_raw_text"] == ""
    assert out["_detail_unverified"] is True


def test_label_matching_ignores_diacritics_and_case():
    html = '<span>KET LUAN</span><span>Không phát hiện bất thường.</span>'
    out = _parse_cdha_detail_html(html)
    assert out["ket_luan"] == "Không phát hiện bất thường."
