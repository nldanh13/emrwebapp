import hchanh_fetch_safe as safe


class FakeOrderHistoryDriver:
    def __init__(self, *, has_select=True, has_all=True, settle=True):
        self.has_select = has_select
        self.has_all = has_all
        self.settle = settle
        self.value = "25"
        self.status = "0"
        self.load_calls = 0
        self.polls = 0

    def execute_script(self, script):
        if "const size = document.querySelector('#soLuongHienThi')" in script and "loadListYLenh" in script:
            if not self.has_select:
                return {"ok": False, "reason": "missing_soLuongHienThi"}
            if not self.has_all:
                return {"ok": False, "reason": "missing_all_option_1000"}
            self.value = "1000"
            self.status = "99"
            self.load_calls += 1
            return {"ok": True, "method": "loadListYLenh"}

        # _order_history_dom_state()
        self.polls += 1
        if not self.has_select:
            return {
                "has_select": False,
                "value": "",
                "has_all_option": False,
                "status_value": "",
                "has_status_select": True,
                "row_count": 0,
                "html_len": 0,
                "text_len": 0,
                "ajax_busy": 0,
            }
        changing = self.value == "1000" and not self.settle
        return {
            "has_select": True,
            "value": self.value,
            "has_all_option": self.has_all,
            "status_value": self.status,
            "has_status_select": True,
            "row_count": 25 + (self.polls if changing else (75 if self.value == "1000" else 0)),
            "html_len": 1000 + (self.polls if changing else (5000 if self.value == "1000" else 0)),
            "text_len": 500 + (self.polls if changing else (2500 if self.value == "1000" else 0)),
            "ajax_busy": 0,
        }


def test_force_show_all_selects_1000_and_all_statuses_before_accepting():
    driver = FakeOrderHistoryDriver()
    ok, state = safe._force_order_history_show_all(
        driver,
        timeout=1.0,
        poll_interval=0.01,
        stable_required=2,
    )

    assert ok is True
    assert driver.load_calls == 1
    assert state["value"] == "1000"
    assert state["status_value"] == "99"
    assert state["reason"] == "verified"


def test_force_show_all_rejects_page_without_all_option():
    driver = FakeOrderHistoryDriver(has_all=False)
    ok, state = safe._force_order_history_show_all(
        driver,
        timeout=0.2,
        poll_interval=0.01,
        stable_required=2,
    )

    assert ok is False
    assert state["reason"] == "missing_all_option_1000"
    assert driver.load_calls == 0


def test_force_show_all_rejects_dom_that_never_stabilizes():
    driver = FakeOrderHistoryDriver(settle=False)
    ok, state = safe._force_order_history_show_all(
        driver,
        timeout=0.35,
        poll_interval=0.01,
        stable_required=2,
    )

    assert ok is False
    assert state["reason"] == "show_all_not_stable_before_timeout"
