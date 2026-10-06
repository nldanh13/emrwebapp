# -*- coding: utf-8 -*-
"""Ảnh người dùng 06/10/2026: "Đăng nhập EMR chưa thành công: sau 20 giây vẫn ở trang đăng nhập" —
không biết vì sao. Báo kèm câu EMR hiện trên trang đăng nhập (sai mật khẩu, bị khóa…)."""
import pytest

from test_research_xn_cdha_tab_status import mod


class _Alert:
    def __init__(self, text):
        self.text = text
        self.accepted = False

    def accept(self):
        self.accepted = True


class _SwitchTo:
    def __init__(self, alert):
        self._alert = alert

    @property
    def alert(self):
        if self._alert is None:
            raise RuntimeError("no alert")
        return self._alert


class _Driver:
    def __init__(self, url, alert=None, notices=None):
        self.current_url = url
        self.switch_to = _SwitchTo(alert)
        self._notices = notices or []

    def execute_script(self, _js):
        return list(self._notices)


def test_login_failure_reports_emr_message(monkeypatch):
    monkeypatch.setattr(mod, "_cho_roi_trang_dang_nhap", lambda driver, timeout=20: False)
    driver = _Driver("http://emr/login.aspx", notices=["Tên đăng nhập hoặc mật khẩu không đúng"])
    with pytest.raises(RuntimeError) as exc:
        mod.vao_noi_tru(driver, None)
    msg = str(exc.value)
    assert 'EMR báo: "Tên đăng nhập hoặc mật khẩu không đúng"' in msg
    assert "secrets/secrets.json" in msg


def test_login_failure_reads_alert_dialog(monkeypatch):
    monkeypatch.setattr(mod, "_cho_roi_trang_dang_nhap", lambda driver, timeout=20: False)
    alert = _Alert("Tài khoản đang đăng nhập ở máy khác")
    with pytest.raises(RuntimeError) as exc:
        mod.vao_noi_tru(_Driver("http://emr/login.aspx", alert=alert), None)
    assert "Tài khoản đang đăng nhập ở máy khác" in str(exc.value)
    assert alert.accepted


def test_login_failure_without_message_still_clear(monkeypatch):
    monkeypatch.setattr(mod, "_cho_roi_trang_dang_nhap", lambda driver, timeout=20: False)
    with pytest.raises(RuntimeError) as exc:
        mod.vao_noi_tru(_Driver("http://emr/login.aspx"), None)
    msg = str(exc.value)
    assert "EMR báo" not in msg
    assert "vẫn ở trang đăng nhập" in msg


# Nguyên nhân gốc của ảnh 06/10/2026: sau `npm run secrets:migrate`, config/config.json để trống
# username/password (mật khẩu chuyển sang secrets/secrets.json). Script XN/CĐHA chỉ đọc
# config.json → gõ tài khoản rỗng → EMR không cho vào.
def test_load_config_reads_emr_account_from_secrets(tmp_path, monkeypatch):
    import json
    script_dir = tmp_path / "script"
    (script_dir / "config").mkdir(parents=True)
    (script_dir / "config" / "config.json").write_text(json.dumps({
        "url_login": "http://emr/login.aspx", "username": "", "password": "",
    }), encoding="utf-8")
    secrets = tmp_path / "secrets"
    secrets.mkdir()
    (secrets / "secrets.json").write_text(json.dumps({"emr": {"username": "dd_khoa", "password": "mk-that"}}), encoding="utf-8")
    monkeypatch.setenv("EMR_SECRETS_DIR", str(secrets))
    for k in ("EMR_USERNAME", "EMR_PASSWORD", "EMR_REQUIRE_SECRET_ENV"):
        monkeypatch.delenv(k, raising=False)
    cfg = mod.load_config(str(script_dir))
    assert cfg["username"] == "dd_khoa"
    assert cfg["password"] == "mk-that"
    assert cfg["url_login"] == "http://emr/login.aspx"


def test_login_without_emr_account_says_where_to_fill():
    with pytest.raises(RuntimeError) as exc:
        mod.login(None, None, {"url_login": "http://emr/login.aspx", "username": "", "password": ""})
    assert "Chưa có tài khoản EMR" in str(exc.value)
