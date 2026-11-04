"""Đọc "Thời gian ra" ở Tổng kết → Ra Khoa (hồ sơ mở bằng tên người bệnh).

Dùng khi danh sách nội trú báo Xử trí ra viện nhưng trang điều dưỡng chưa có
giờ ra viện (lblNgayRaVien trống hoặc chỉ có ngày). Chỉ mở form để ĐỌC, không
bấm Lưu. Bộ chọn menu lấy theo hchanh_fetch._click_hchanh_action("discharge"),
đã chạy ổn trên EMR thật.
"""

import re
import time
from typing import Any, Optional

RA_KHOA_FIELD_IDS = ("txtThoiGianRa", "txtNgayRaVien", "lblNgayRaVien")

_OPEN_RA_KHOA_JS = r"""
const a = Array.from(document.querySelectorAll('a')).find(x =>
  ((x.getAttribute('onclick') || '').includes('onShowXuTri'))
  || (x.textContent || '').trim() === 'Ra Khoa');
if (!a) return false;
if (typeof onShowXuTri === 'function') { onShowXuTri(a); return true; }
a.click();
return true;
"""

_READ_FIELDS_JS = r"""
const ids = arguments[0];
for (const id of ids) {
  const el = document.getElementById(id);
  if (!el) continue;
  const v = ((el.value !== undefined && el.value !== null && el.value !== '') ? el.value : el.textContent) || '';
  if (v.trim()) return v.trim();
}
return '';
"""


def parse_ra_khoa_time(raw: Any, default_year: Optional[str] = None) -> str:
    """'09:15 04/11/2026', '04/11/2026 09:15', '09:15 04-11-26' → '09:15 04/11/2026'.

    Thiếu giờ hoặc thiếu ngày → '' (không đoán).
    """
    text = re.sub(r"\s+", " ", str(raw or "")).strip()
    if not text:
        return ""
    m = re.search(r"(\d{1,2}):(\d{2})(?::\d{2})?\s+(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2,4}))?", text)
    if m:
        hh, mi, dd, mo, yy = m.groups()
    else:
        m = re.search(r"(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2,4}))?\s+(\d{1,2}):(\d{2})", text)
        if not m:
            return ""
        dd, mo, yy, hh, mi = m.groups()
    if not yy:
        yy = str(default_year or "")
    if not yy:
        return ""
    year = int(yy)
    if year < 100:
        year += 2000
    h, mnt, d, mth = int(hh), int(mi), int(dd), int(mo)
    if not (0 <= h <= 23 and 0 <= mnt <= 59 and 1 <= d <= 31 and 1 <= mth <= 12):
        return ""
    return f"{h:02d}:{mnt:02d} {d:02d}/{mth:02d}/{year}"


def read_ra_khoa_time(driver: Any, default_year: Optional[str] = None, timeout: float = 8.0) -> str:
    """Mở Tổng kết → Ra Khoa trên hồ sơ đang mở và đọc Thời gian ra. Lỗi → ''."""
    try:
        if not driver.execute_script(_OPEN_RA_KHOA_JS):
            print("LOG: Không thấy menu Tổng kết → Ra Khoa trên hồ sơ")
            return ""
    except Exception as exc:
        print(f"LOG: Không mở được Tổng kết → Ra Khoa: {exc}")
        return ""
    deadline = time.time() + max(float(timeout or 0), 0.5)
    raw = ""
    while time.time() < deadline:
        try:
            raw = driver.execute_script(_READ_FIELDS_JS, list(RA_KHOA_FIELD_IDS)) or ""
        except Exception:
            raw = ""
        if parse_ra_khoa_time(raw, default_year):
            break
        time.sleep(0.4)
    return parse_ra_khoa_time(raw, default_year)
