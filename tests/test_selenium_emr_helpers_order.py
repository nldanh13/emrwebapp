# -*- coding: utf-8 -*-
"""
tests/test_selenium_emr_helpers_order.py — search_patient_on_ward_or_raise()
phải vào danh sách nội trú (ensure_inpatient_list) TRƯỚC khi chọn bộ lọc
trạng thái (set_inpatient_status_filter), vì dropdown #drpSelectTrangThai
chỉ tồn tại trên trang danh sách nội trú — gọi filter trước khi vào trang
sẽ luôn lỗi/timeout ngay sau khi vừa đăng nhập (còn ở home.aspx chung).

Không cần Selenium thật — mock hết các hàm con, chỉ kiểm tra thứ tự gọi.
Chạy: python -m pytest tests/test_selenium_emr_helpers_order.py -v
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

import pytest
from unittest.mock import patch

try:
    import selenium_emr_helpers as helpers
    AVAILABLE = True
except Exception as e:
    AVAILABLE = False
    ERR = str(e)

skip = pytest.mark.skipif(not AVAILABLE, reason=f"selenium_emr_helpers unavailable: {ERR if not AVAILABLE else ''}")


@skip
class TestSearchPatientOnWardOrder:
    def test_ensure_inpatient_list_called_before_status_filter(self):
        calls = []

        with patch.object(helpers, "ensure_inpatient_list", side_effect=lambda *a, **k: calls.append("ensure_list")), \
             patch.object(helpers, "set_inpatient_status_filter", side_effect=lambda *a, **k: calls.append("set_filter")), \
             patch.object(helpers, "search_patient", side_effect=lambda *a, **k: calls.append("search")), \
             patch.object(helpers, "patient_row_exists", return_value=True):
            status = helpers.search_patient_on_ward_or_raise(
                driver=object(), wait=object(), config={}, ma_bn="26090048",
            )

        assert status == "Đang thực hiện"
        assert calls[0] == "ensure_list", (
            f"ensure_inpatient_list() phải chạy đầu tiên (vào trang danh sách nội trú) "
            f"trước khi chọn bộ lọc trạng thái — thứ tự thực tế: {calls}"
        )
        assert calls.index("ensure_list") < calls.index("set_filter"), calls

    def test_still_raises_when_patient_not_found_in_any_status(self):
        with patch.object(helpers, "ensure_inpatient_list"), \
             patch.object(helpers, "set_inpatient_status_filter"), \
             patch.object(helpers, "search_patient"), \
             patch.object(helpers, "patient_row_exists", return_value=False):
            with pytest.raises(RuntimeError):
                helpers.search_patient_on_ward_or_raise(
                    driver=object(), wait=object(), config={}, ma_bn="26090048",
                )


class _FakeDriver:
    """Giả lập driver.current_url + find_element("txtTimKiem") tồn tại NGAY CẢ
    khi còn ở home.aspx — vì widget "Danh sách Bệnh nhân hiện diện" ở trang chủ
    dùng chung id #txtTimKiem với ô tìm kiếm thật của trang danh sách nội trú."""
    def __init__(self, current_url: str):
        self.current_url = current_url

    def find_element(self, by, value):
        if value == "txtTimKiem":
            return object()
        raise Exception("not found")


@skip
class TestEnsureInpatientListNotFooledByHomeSearchBox:
    def test_home_page_with_lookalike_search_box_still_navigates(self):
        """Ngay sau khi đăng nhập, driver còn ở home.aspx — trang này cũng có
        1 ô #txtTimKiem riêng (widget trang chủ). Nếu ensure_inpatient_list()
        chỉ kiểm tra sự tồn tại của #txtTimKiem mà không kiểm tra URL đã đúng
        wpid danh sách nội trú, nó sẽ lầm tưởng đã ở đúng trang và bỏ qua điều
        hướng — các bước tìm kiếm sau đó sẽ gõ nhầm vào ô của trang chủ."""
        driver = _FakeDriver("https://emr.example/home.aspx?usid=abc")
        calls = []
        with patch.object(helpers, "goto_inpatient_list", side_effect=lambda *a, **k: calls.append("goto")):
            helpers.ensure_inpatient_list(driver, wait=object(), config={})
        assert calls == ["goto"], (
            "Phải điều hướng thật sự vào danh sách nội trú dù #txtTimKiem của "
            "trang chủ 'giả' tồn tại — không được tin #txtTimKiem khi URL chưa "
            "đúng wpid danh sách nội trú."
        )

    def test_already_on_inpatient_list_url_skips_navigation(self):
        """Khi URL đã đúng wpid danh sách nội trú và #txtTimKiem tồn tại, không
        cần điều hướng lại (giữ hành vi fast-path cũ cho trường hợp thật)."""
        driver = _FakeDriver(
            "https://emr.example/home.aspx?usid=abc&wpid=danhsachdieutrinoitrudraw"
        )
        calls = []
        with patch.object(helpers, "goto_inpatient_list", side_effect=lambda *a, **k: calls.append("goto")):
            helpers.ensure_inpatient_list(driver, wait=object(), config={})
        assert calls == []
