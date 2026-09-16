# -*- coding: utf-8 -*-
"""Bug: thêm phòng tự do "P2 Sản" trong Xếp phòng bị gộp nhầm vào "P02" khi lọc
theo phòng lúc lấy dữ liệu (Lấy dữ liệu -> chọn phòng). normalize_room_code() cố ý
lỏng (chấp nhận "02"/"2" để gõ tắt, và dùng chung cho bed_current_check.py đọc chuỗi
giường/phòng thô của EMR) nên không đổi; canonical_room_key() là hàm mới, chặt hơn,
dùng riêng cho bộ lọc "rooms" khi lấy dữ liệu.
"""

from main_worker import normalize_room_code, canonical_room_key


def test_normalize_room_code_giu_nguyen_hanh_vi_long_cu():
    # Hành vi cũ (chấp nhận dạng tắt) không đổi — dùng cho CLI/bed_current_check.py.
    assert normalize_room_code('P02') == 'P02'
    assert normalize_room_code('P2') == 'P02'
    assert normalize_room_code('02') == 'P02'
    assert normalize_room_code('2') == 'P02'
    assert normalize_room_code('') == ''
    assert normalize_room_code(None) == ''


def test_canonical_room_key_chuan_hoa_dung_khi_toan_bo_chuoi_la_p_so():
    assert canonical_room_key('P2') == 'P02'
    assert canonical_room_key('P 09') == 'P09'
    assert canonical_room_key('p02') == 'P02'


def test_canonical_room_key_giu_nguyen_ten_phong_tu_do_khong_gop_nham():
    assert canonical_room_key('P2 Sản') == 'P2 Sản'
    assert canonical_room_key('P2 Sản') != 'P02'
    assert canonical_room_key('Phòng VIP A') == 'Phòng VIP A'


def test_canonical_room_key_rong_cho_gia_tri_rong():
    assert canonical_room_key('') == ''
    assert canonical_room_key(None) == ''


def test_loc_theo_phong_khong_lan_p2_san_voi_p02():
    # Mô phỏng đúng khối lọc "rooms" trong task_details(): dùng canonical_room_key
    # cho cả bộ lọc yêu cầu lẫn Vi_Tri của bệnh nhân.
    patients = [
        {'Vi_Tri': 'P02'},
        {'Vi_Tri': 'P2 Sản'},
    ]
    room_set = {canonical_room_key('P2 Sản')}
    matched = [p for p in patients if canonical_room_key(p['Vi_Tri']) in room_set]
    assert len(matched) == 1
    assert matched[0]['Vi_Tri'] == 'P2 Sản'
