from main_worker import _read_mode, _http_read_enabled, _allow_selenium_read_fallback, _read_selenium_headless
from emr_http_reader import EmrHttpSession


def test_default_read_mode_is_selenium_headless_read():
    cfg = {}
    assert _read_mode(cfg) == "selenium"
    assert _http_read_enabled(cfg) is False
    assert _allow_selenium_read_fallback(cfg) is True
    assert _read_selenium_headless(cfg) is True


def test_old_http_only_config_is_ignored_and_uses_headless_selenium():
    cfg = {
        "data_read_mode": "http_only",
        "http_read_enabled": True,
        "http_read_fallback_to_selenium": False,
    }
    assert _read_mode(cfg) == "selenium"
    assert _http_read_enabled(cfg) is False
    assert _allow_selenium_read_fallback(cfg) is True
    assert _read_selenium_headless(cfg) is True


def test_read_headless_does_not_depend_on_input_headless_flag():
    cfg = {"data_read_mode": "headless", "headless": False}
    assert _read_selenium_headless(cfg) is True


def test_can_force_visible_browser_for_debug_read_only_if_explicit():
    cfg = {"data_read_headless": False}
    assert _read_selenium_headless(cfg) is False


def test_http_reader_config_still_has_safe_defaults_for_legacy_helper():
    sess = EmrHttpSession.from_config_dict({
        "url_login": "http://emr/login.aspx",
        "username": "u",
        "password": "p",
        "url_inpatient_list": "http://emr/home.aspx?wpid=danhsachdieutrinoitrudraw",
    })
    assert sess.cfg.request_delay_ms == 80
    assert sess.cfg.max_retries == 2
    assert sess.cfg.timeout_sec == 30
