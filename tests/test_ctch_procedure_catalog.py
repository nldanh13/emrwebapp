# -*- coding: utf-8 -*-
"""Catalog imports must not activate generic surgery or the wrong EMR DVKT."""
from procedure_templates import match_template


def catalog(code, name, kind="thu_thuat", **overrides):
    return {
        "id": "ctch-" + code.replace(".", "-"),
        "catalog_code": code,
        "kind": kind,
        "name": name,
        "keywords": [name],
        "reviewed": False,
        "auto": False,
        "enabled": False,
        **overrides,
    }


def test_unreviewed_catalog_prevents_generic_surgery_fallback():
    default = {"id": "fallback", "kind": "phau_thuat", "keywords": [],
               "auto": True, "enabled": True}
    nail = catalog("5.69", "Phẫu thuật điều trị móng cuộn, móng quặp", kind="phau_thuat")
    assert match_template([default, nail], "phau_thuat", nail["name"]) is None
    assert match_template([default, nail], "phau_thuat", "Một phẫu thuật khác") is default


def test_reviewed_catalog_only_matches_complete_service_name():
    prp = catalog("2.511", "Điều trị thoái hóa khớp bằng huyết tương giàu tiểu cầu",
                  reviewed=True, auto=True, enabled=True)
    assert match_template([prp], "thu_thuat", prp["name"]) is prp
    assert match_template([prp], "thu_thuat", prp["name"] + " dưới siêu âm") is None
    assert match_template([prp], "thu_thuat", "Tiêm huyết tương giàu tiểu cầu") is None


def test_disabled_draft_does_not_override_explicit_legacy_template():
    name = "Hút dịch khớp gối"
    legacy = {"id": "legacy", "kind": "thu_thuat", "keywords": [name],
              "auto": True, "enabled": True}
    draft = catalog("2.349", name)
    assert match_template([legacy, draft], "thu_thuat", name) is legacy


def test_unreviewed_template_not_activated_even_if_flags_wrong():
    name = "Phẫu thuật điều trị ngón tay cò súng"
    unreviewed = catalog("3.3706", name, kind="phau_thuat", auto=True, enabled=True)
    assert match_template([unreviewed], "phau_thuat", name) is None
