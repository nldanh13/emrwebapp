# -*- coding: utf-8 -*-

from hchanh_fetch import _cdha_content_state, _wait_cdha_table


class _FakeDiv:
    def __init__(self, html):
        self.html = html

    def get_attribute(self, name):
        assert name == "innerHTML"
        return self.html


class _FakeDriver:
    def __init__(self, html_sequence):
        self.html_sequence = list(html_sequence)
        self.calls = 0

    def find_elements(self, by, selector):
        assert selector == "#divLichSuCDHAContent"
        idx = min(self.calls, len(self.html_sequence) - 1)
        self.calls += 1
        return [_FakeDiv(self.html_sequence[idx])]


def test_cdha_state_ready_when_table_loaded():
    driver = _FakeDriver(['<table id="tbDichVu"><tr><th>Dịch vụ</th></tr></table>'])
    assert _cdha_content_state(driver) == "ready"


def test_cdha_state_empty_only_with_explicit_empty_message():
    driver = _FakeDriver(['<div class="dataTables_empty">Không có dữ liệu</div>'])
    assert _cdha_content_state(driver) == "empty"


def test_cdha_state_does_not_treat_loading_text_as_empty():
    driver = _FakeDriver(['<div>Đang tải dữ liệu...</div>'])
    assert _cdha_content_state(driver) == "pending"


def test_wait_cdha_table_returns_timeout_instead_of_empty():
    driver = _FakeDriver(['<div>Đang tải dữ liệu...</div>'])
    assert _wait_cdha_table(driver, timeout=0.01) == "timeout"
