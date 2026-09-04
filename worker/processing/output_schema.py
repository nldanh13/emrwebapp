# -*- coding: utf-8 -*-
"""Schema output cho từng người bệnh/ngày.

Mục tiêu: mọi module tạo record dùng cùng một cấu trúc.
Sau này thêm/bớt trường output chỉ sửa ở file này, tránh rải dict mẫu nhiều nơi.
"""

try:
    from data_contract import attach_record_contract
except Exception:  # pragma: no cover
    def attach_record_contract(record):
        return record


def empty_medication_bucket():
    return {
        "dich_truyen": [],
        "thuoc_tiem": [],
        "thuoc_uong": [],
        "thuoc_tra": [],
        "khac": [],
    }


def make_patient_day_record(
    patient,
    *,
    ngay_lam,
    raw_dien_bien,
    raw_y_lenh,
    doc_name,
    doc_content,
    order_header_time,
    clean_text_for_entry,
    extract_care_special_events=None,
    extract_admission_transfer_events=None,
):
    """Tạo record chuẩn trước khi parser thuốc/chỉ định đổ dữ liệu vào.

    Không parse nghiệp vụ ở đây; chỉ gom metadata và khởi tạo cấu trúc output.
    """
    patient = patient or {}
    doc_name = str(doc_name or patient.get('Bác sĩ') or patient.get('bac_si') or '').strip()
    raw_dien_bien = raw_dien_bien or ''
    raw_y_lenh = raw_y_lenh or ''
    order_header_time = (order_header_time or '').strip()

    care_events = []
    if extract_care_special_events:
        care_events.extend(extract_care_special_events(raw_dien_bien, raw_y_lenh, ngay_lam) or [])
    if extract_admission_transfer_events:
        care_events.extend(extract_admission_transfer_events(patient, raw_dien_bien, raw_y_lenh, ngay_lam) or [])

    admission_time = (
        patient.get('thoi_gian_vao_khoa')
        or patient.get('tg_vao')
        or patient.get('T/G vào')
        or patient.get('thoi_gian_vao')
        or patient.get('admission_time')
        or ''
    )
    department_name = (
        patient.get('ten_khoa_dieu_tri')
        or patient.get('khoa_dieu_tri')
        or patient.get('khoa_chuyen_den')
        or patient.get('Tên khoa điều trị')
        or patient.get('Khoa điều trị')
        or patient.get('Khoa chuyển đến')
        or patient.get('department_name')
        or patient.get('department')
        or ''
    )

    ward_history = (
        patient.get('lich_su_khoa_dieu_tri')
        or patient.get('khoa_dieu_tri_history')
        or patient.get('ward_admissions')
        or []
    )

    record = {
        "ngay_lam": ngay_lam,
        "ma_bn": patient.get('Mã BN', '') or patient.get('ma_bn', ''),
        "ho_ten": patient.get('Họ tên', '') or patient.get('ho_ten', ''),
        "so_phong": patient.get('Vi_Tri') or patient.get('phong_giuong') or patient.get('so_phong') or '',
        "tg_vao": admission_time,
        "thoi_gian_vao_khoa": admission_time,
        "khoa_chuyen_den": department_name,
        "khoa_dieu_tri": department_name,
        "ten_khoa_dieu_tri": department_name,
        "lich_su_khoa_dieu_tri": ward_history if isinstance(ward_history, list) else [],
        "chan_doan": patient.get('chan_doan') or patient.get('Chẩn đoán') or '',
        "xu_tri": patient.get('xu_tri') or patient.get('Xử trí') or patient.get('XuTri') or '',
        "ngay_ra_vien": patient.get('ngay_ra_vien') or patient.get('Ngày ra viện') or '',
        "gio_ra_vien": patient.get('gio_ra_vien') or '',
        "ngay_ra_vien_date": patient.get('ngay_ra_vien_date') or '',
        "ra_vien_hom_nay": bool(patient.get('ra_vien_hom_nay')),
        "bac_si": doc_name,
        "bac_si_theo_gio": patient.get('bac_si_theo_gio') or {},
        "nhap_cham_soc": {
            "dien_bien": clean_text_for_entry(raw_dien_bien),
            "y_lenh": clean_text_for_entry(doc_content or ''),
        },
        "thuoc": empty_medication_bucket(),
        "gio_y_lenh": order_header_time,
        "care_special_events": care_events,
        # Không để parser làm mất y lệnh: luôn giữ bản gốc và các cảnh báo.
        "raw_order_events": [],
        "unparsed_orders": [],
        "processing_warnings": [],
        "vtyt": {
            "items": [],
            "warnings": [],
            "source": "pending_after_merge",
        },
    }
    return attach_record_contract(record)
