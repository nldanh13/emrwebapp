"""Vào D/s Điều trị nội trú: menu không hiện kịp thì mở thẳng bằng URL của phiên đăng nhập.

Không dùng Selenium: WebDriverWait/EC/driver được thay bằng bản giả.
"""
import importlib.util
import sys
import types
from pathlib import Path

import pytest

_selenium_module_names = [
    "selenium", "selenium.webdriver", "selenium.webdriver.common", "selenium.webdriver.common.by",
    "selenium.webdriver.support", "selenium.webdriver.support.ui", "selenium.webdriver.support.expected_conditions",
]
_saved_selenium_modules = {name: sys.modules.get(name) for name in _selenium_module_names}
if "selenium" not in sys.modules:
    selenium = types.ModuleType("selenium")
    webdriver_mod = types.ModuleType("selenium.webdriver")
    common_mod = types.ModuleType("selenium.webdriver.common")
    by_mod = types.ModuleType("selenium.webdriver.common.by")
    support_mod = types.ModuleType("selenium.webdriver.support")
    ui_mod = types.ModuleType("selenium.webdriver.support.ui")
    ec_mod = types.ModuleType("selenium.webdriver.support.expected_conditions")
    by_mod.By = object
    ui_mod.WebDriverWait = object
    selenium.webdriver = webdriver_mod
    webdriver_mod.common = common_mod
    webdriver_mod.support = support_mod
    common_mod.by = by_mod
    support_mod.ui = ui_mod
    support_mod.expected_conditions = ec_mod
    sys.modules.update({
        "selenium": selenium,
        "selenium.webdriver": webdriver_mod,
        "selenium.webdriver.common": common_mod,
        "selenium.webdriver.common.by": by_mod,
        "selenium.webdriver.support": support_mod,
        "selenium.webdriver.support.ui": ui_mod,
        "selenium.webdriver.support.expected_conditions": ec_mod,
    })

ROOT = Path(__file__).resolve().parents[1]
MOD_PATH = ROOT / "research" / "nghien_cuu_1" / "lay_lich_su_xn_cdha.py"
spec = importlib.util.spec_from_file_location("research_xn_cdha_vao_noi_tru", MOD_PATH)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
for _name, _module in _saved_selenium_modules.items():
    if _module is None:
        sys.modules.pop(_name, None)
    else:
        sys.modules[_name] = _module


class FakeTimeout(Exception):
    pass


class FakeWait:
    """until(cond): gọi cond một lần; không thỏa thì báo hết giờ ngay (không chờ thật)."""
    def __init__(self, driver, timeout):
        self.driver = driver

    def until(self, cond):
        value = cond(self.driver)
        if not value:
            raise FakeTimeout("hết giờ")
        return value


class FakeEC:
    @staticmethod
    def element_to_be_clickable(locator):
        return lambda d: d.find(locator)

    @staticmethod
    def visibility_of_element_located(locator):
        return lambda d: d.find(locator)


class FakeBy:
    XPATH = "xpath"
    PARTIAL_LINK_TEXT = "link"
    ID = "id"


class FakeEl:
    def click(self):
        pass


class FakeDriver:
    def __init__(self, url, menu=False):
        self.current_url = url
        self.menu = menu
        self.opened = []

    def find(self, locator):
        kind, value = locator
        if kind == "id" and value == "txtTimKiem":
            return FakeEl() if "danhsachdieutrinoitrudraw" in self.current_url or self.menu_clicked else None
        if self.menu:
            if kind == "link":
                self.menu_clicked = True
            return FakeEl()
        return None

    menu_clicked = False

    def get(self, url):
        self.opened.append(url)
        self.current_url = url


@pytest.fixture(autouse=True)
def fakes(monkeypatch):
    monkeypatch.setattr(mod, "WebDriverWait", FakeWait)
    monkeypatch.setattr(mod, "EC", FakeEC)
    monkeypatch.setattr(mod, "By", FakeBy)
    monkeypatch.setattr(mod.time, "sleep", lambda *_: None)


HOME = "http://emr.local:2026/home.aspx?scope=1&lang=vi&role=2&usid=abc123&st=9"


def test_menu_binh_thuong_van_bam_menu():
    d = FakeDriver(HOME, menu=True)
    mod.vao_noi_tru(d, FakeWait(d, 20))
    assert d.opened == []


def test_menu_khong_hien_thi_mo_bang_url_giu_phien():
    d = FakeDriver(HOME, menu=False)
    mod.vao_noi_tru(d, FakeWait(d, 20))
    assert len(d.opened) == 1
    url = d.opened[0]
    assert "wpid=danhsachdieutrinoitrudraw" in url
    assert "usid=abc123" in url and "role=2" in url


def test_van_o_trang_dang_nhap_bao_loi_ro_rang(monkeypatch):
    monkeypatch.setattr(mod, "_cho_roi_trang_dang_nhap", lambda driver, timeout=20: False)
    d = FakeDriver("http://emr.local:2026/login.aspx", menu=False)
    with pytest.raises(RuntimeError, match="Đăng nhập EMR chưa thành công"):
        mod.vao_noi_tru(d, FakeWait(d, 20))
