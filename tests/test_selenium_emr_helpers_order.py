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
