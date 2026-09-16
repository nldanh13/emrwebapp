# -*- coding: utf-8 -*-
"""worker/emr_structure_scan.py — Dò cấu trúc EMR (ONEMES HIS), so với danh mục đã biết.

Mục đích: EMR có thể đổi cấu trúc (đổi id field, đổi bảng, thêm/bớt trang) sau khi nhà
cung cấp HIS cập nhật, làm code hiện tại (dựa trên id/selector cố định trong
worker/hchanh_fetch.py) fetch sai mà không báo lỗi rõ ràng. Script này KHÔNG tự sửa
code — chỉ dò và báo cáo hai việc:

  1. Các trang/selector CODE ĐANG DÙNG (khai báo trong
     config/hchanh/emr_structure_manifest.json) còn đúng như kỳ vọng không.
  2. Các trang MỚI (wpid chưa có trong danh mục) tìm được qua liên kết từ các trang đã
     biết — chỉ để biết SỰ TỒN TẠI và tóm tắt cấu trúc (field id, tên bảng, số lựa chọn
     dropdown), KHÔNG tự suy đoán ý nghĩa của trang đó.

An toàn: CHỈ ĐỌC (GET qua EmrHttpSession, giống fetch dữ liệu bình thường), không bấm
hay gửi bất kỳ form nào. Bỏ qua link có chữ thuộc nhóm hành động ghi (xóa/lưu/sửa/cập
nhật/...) khi dò trang mới, để tránh vô tình click vào một action ghi nếu sau này script
được đổi sang dùng Selenium. Giới hạn số trang mới tối đa và có nghỉ giữa các lần gọi để
không dồn dập lên hệ thống EMR thật.

CLI: python worker/emr_structure_scan.py --out <path.json> [--max-discovered 15]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from typing import Any, Dict, List, Optional, Set
from urllib.parse import urljoin, urlparse, parse_qsl

from utils import load_config

try:
    from emr_http_reader import EmrHttpSession
except Exception as exc:  # pragma: no cover
    EmrHttpSession = None  # type: ignore
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None

from hchanh_fetch import _soup, _patient_page_url, _upsert_query  # type: ignore

# Từ khóa (đã bỏ dấu, thường gặp trên EMR tiếng Việt) coi là hành động GHI — bỏ qua khi
# dò link trang mới, không GET tới những trang này. Tham khảo cùng vốn từ với
# care_baseline_fetch.py::_looks_like_patient_name (chữ hành động, không phải nội dung).
_WRITE_ACTION_WORDS = (
    "xoa", "xóa", "luu", "lưu", "sua", "sửa", "cap nhat", "cập nhật",
    "ghi nhan", "ghi nhận", "xac nhan", "xác nhận", "duyet", "duyệt",
    "gui", "gửi", "huy", "hủy", "huỷ", "dong y", "đồng ý", "them", "thêm",
    "tao moi", "tạo mới", "nhap", "nhập", "ky", "ký",
)

REQUEST_DELAY_SEC = 0.5


def _load_manifest() -> Dict[str, Any]:
    import os
    script_dir = os.path.dirname(os.path.abspath(__file__))
    p = os.path.normpath(os.path.join(script_dir, "..", "config", "hchanh", "emr_structure_manifest.json"))
    if os.path.exists(p):
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"pages": {}}


def _looks_like_write_action(text: str) -> bool:
    t = (text or "").strip().lower()
    if not t:
        return False
    return any(w in t for w in _WRITE_ACTION_WORDS)


def _extract_page_structure(html: str) -> Dict[str, Any]:
    """Tóm tắt cấu trúc 1 trang: field id, tên bảng id + header cột, dropdown + số option.

    Không lưu nguyên văn HTML (quá nặng) — chỉ đủ để so sánh cấu trúc giữa các lần dò.
    """
    soup = _soup(html)
    field_ids: List[str] = []
    for tag in soup.find_all(["input", "select", "textarea"]):
        fid = tag.get("id")
        if fid:
            field_ids.append(fid)

    tables: List[Dict[str, Any]] = []
    for table in soup.find_all("table"):
        tid = table.get("id")
        if not tid:
            continue
        header_cells = table.find_all("th")
        if not header_cells:
            first_row = table.find("tr")
            header_cells = first_row.find_all("td") if first_row else []
        headers = [re.sub(r"\s+", " ", c.get_text(" ", strip=True)).strip() for c in header_cells]
        tables.append({"id": tid, "headers": [h for h in headers if h][:20]})

    dropdowns: List[Dict[str, Any]] = []
    for sel in soup.find_all("select"):
        sid = sel.get("id")
        if not sid:
            continue
        options = sel.find_all("option")
        dropdowns.append({"id": sid, "option_count": len(options)})

    return {
        "field_ids": sorted(set(field_ids)),
        "tables": tables,
        "dropdowns": dropdowns,
    }


def _extract_wpid_links(html: str, base_url: str) -> List[Dict[str, str]]:
    """Tìm mọi <a href> có wpid=..., trả về [{wpid, url, text}], đã lọc link hành động ghi."""
    soup = _soup(html)
    out: List[Dict[str, str]] = []
    seen: Set[str] = set()
    for a in soup.find_all("a", href=True):
        href = a.get("href") or ""
        if "wpid=" not in href.lower():
            continue
        text = a.get_text(" ", strip=True)
        if _looks_like_write_action(text):
            continue
        abs_url = urljoin(base_url, href)
        qs = dict(parse_qsl(urlparse(abs_url).query))
        wpid = qs.get("wpid") or ""
        if not wpid or wpid in seen:
            continue
        seen.add(wpid)
        out.append({"wpid": wpid, "url": abs_url, "text": text})
    return out


def _check_known_page(sess: "EmrHttpSession", page_key: str, page_cfg: Dict[str, Any],
                       url: str) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "page_key": page_key,
        "label": page_cfg.get("label", page_key),
        "url": url,
        "status": "ok",
        "missing_fields": [],
        "missing_tables": [],
    }
    try:
        html, final_url = sess.get_html(url)
    except Exception as exc:
        result["status"] = "fetch_error"
        result["error"] = str(exc)
        return result

    structure = _extract_page_structure(html)
    result["field_ids_found_count"] = len(structure["field_ids"])
    result["tables_found_count"] = len(structure["tables"])

    expected_fields = page_cfg.get("fields") or []
    found_field_set = set(structure["field_ids"])
    missing_fields = [f for f in expected_fields if f not in found_field_set]

    expected_tables = page_cfg.get("tables") or []
    found_table_ids = {t["id"] for t in structure["tables"]}
    # Bảng dạng "div#id table" (không có id riêng) — chỉ kiểm tra bằng cách tìm chuỗi id
    # trong HTML thô, vì BeautifulSoup structure ở trên chỉ gom table CÓ id.
    missing_tables = []
    for t in expected_tables:
        m = re.search(r'id=["\']([^"\']+)["\']', t)
        tid = m.group(1) if m else t
        if tid in found_table_ids:
            continue
        if f'id="{tid}"' in html or f"id='{tid}'" in html:
            continue
        missing_tables.append(t)

    result["missing_fields"] = missing_fields
    result["missing_tables"] = missing_tables
    if missing_fields or missing_tables:
        result["status"] = "changed"

    result["_html_links"] = _extract_wpid_links(html, final_url)
    return result


def run_scan(max_discovered: int = 15) -> Dict[str, Any]:
    if EmrHttpSession is None:
        return {"status": "error", "message": f"Không import được EmrHttpSession: {_IMPORT_ERROR}"}

    config = load_config()
    manifest = _load_manifest()
    pages_cfg: Dict[str, Any] = manifest.get("pages", {})

    sess = EmrHttpSession.from_config_dict(config)
    sess.login()

    all_rows, link_map = sess.scan_all_inpatients()
    inpatient_list_source = "html_table"

    # Một số bản HIS vẽ bảng nội trú bằng AjaxPro/JS, không có sẵn trong HTML tĩnh — GET
    # thường không bao giờ thấy bảng dù đăng nhập đúng. Chỉ thử khi đường HTML thường
    # không thấy gì, và chỉ hoạt động nếu đã cấu hình ajaxpro_inpatient_endpoint (xem
    # docs/EMR_STRUCTURE_SCAN.md) — không tự bật ngầm.
    if not link_map and hasattr(sess, "fetch_inpatient_list_via_ajaxpro"):
        try:
            ajax_rows, ajax_link_map = sess.fetch_inpatient_list_via_ajaxpro(sess._effective_inpatient_url())
        except Exception:
            ajax_rows, ajax_link_map = [], {}
        if ajax_link_map:
            all_rows, link_map = ajax_rows, ajax_link_map
            inpatient_list_source = "ajaxpro_fallback"
        else:
            inpatient_list_source = "none"

    sample_ma_bn = next(iter(link_map), None)

    # Không có bệnh nhân mẫu thì vẫn tiếp tục: các trang không cần patient (vd chính
    # danh sách nội trú) vẫn kiểm được, và đó chính là chỗ hay hé lộ lý do (bảng
    # tblNoiTru đổi cấu trúc, đổi tên cột Mã BN, hay danh sách trống thật). Chỉ các
    # trang cần patient mới bị đánh dấu "skipped_no_sample_patient".
    warning: Optional[str] = None
    inpatient_scan_diag: Optional[Dict[str, Any]] = None
    if not sample_ma_bn:
        warning = (
            "Không tìm được bệnh nhân mẫu nào trong danh sách nội trú (link_map rỗng) — "
            "các trang cần patient bị bỏ qua. Xem mục 'known_pages' của trang danh sách "
            "nội trú và inpatient_scan_diag bên dưới để biết bảng/cột có đổi không."
        )
        inpatient_scan_diag = {
            "source": inpatient_list_source,
            "rows_parsed_count": len(all_rows),
            "link_map_count": len(link_map),
            "sample_row_headers": sorted(set(all_rows[0].keys())) if all_rows else [],
        }

    known_results: List[Dict[str, Any]] = []
    known_wpids: Set[str] = set()
    discovered_links: List[Dict[str, str]] = []

    for page_key, page_cfg in pages_cfg.items():
        needs_patient = bool(page_cfg.get("needs_patient"))
        wpid = page_cfg.get("wpid_literal") or config.get(page_cfg.get("wpid_config_key", ""), page_cfg.get("wpid_default", ""))
        wpid = str(wpid or "").strip()
        if not wpid:
            known_results.append({
                "page_key": page_key,
                "label": page_cfg.get("label", page_key),
                "status": "skipped_not_configured",
            })
            continue
        known_wpids.add(wpid)

        if needs_patient and not sample_ma_bn:
            known_results.append({
                "page_key": page_key, "label": page_cfg.get("label", page_key),
                "status": "skipped_no_sample_patient", "wpid": wpid,
            })
            continue

        if needs_patient:
            base_url = _patient_page_url(link_map, sample_ma_bn, config, sess.base_origin, kind=page_cfg.get("kind", "doctor"))
            if not base_url:
                known_results.append({
                    "page_key": page_key, "label": page_cfg.get("label", page_key),
                    "status": "no_url", "wpid": wpid,
                })
                continue
            url = _upsert_query(base_url, wpid=wpid)
        else:
            url = _upsert_query(sess._effective_inpatient_url(), wpid=wpid) if hasattr(sess, "_effective_inpatient_url") else None
            if not url:
                known_results.append({
                    "page_key": page_key, "label": page_cfg.get("label", page_key),
                    "status": "no_url", "wpid": wpid,
                })
                continue

        time.sleep(REQUEST_DELAY_SEC)
        r = _check_known_page(sess, page_key, page_cfg, url)
        r["wpid"] = wpid
        for link in r.pop("_html_links", []):
            if link["wpid"] not in known_wpids:
                discovered_links.append(link)
        known_results.append(r)

    # Dò trang mới (rộng): từ link tìm được ở các trang đã biết, GET thêm tối đa
    # max_discovered trang chưa từng thấy wpid — chỉ 1 tầng (không đệ quy tiếp từ trang
    # mới phát hiện), để giới hạn phạm vi và không dồn dập lên EMR thật.
    seen_new_wpids: Set[str] = set()
    discovered_results: List[Dict[str, Any]] = []
    for link in discovered_links:
        if len(discovered_results) >= max_discovered:
            break
        if link["wpid"] in seen_new_wpids or link["wpid"] in known_wpids:
            continue
        seen_new_wpids.add(link["wpid"])
        time.sleep(REQUEST_DELAY_SEC)
        try:
            html, final_url = sess.get_html(link["url"])
            structure = _extract_page_structure(html)
            discovered_results.append({
                "wpid": link["wpid"],
                "url": link["url"],
                "link_text": link["text"],
                "status": "ok",
                "field_ids": structure["field_ids"][:40],
                "tables": structure["tables"][:10],
                "dropdowns": structure["dropdowns"][:20],
            })
        except Exception as exc:
            discovered_results.append({
                "wpid": link["wpid"], "url": link["url"], "link_text": link["text"],
                "status": "fetch_error", "error": str(exc),
            })

    changed_count = sum(1 for r in known_results if r.get("status") == "changed")
    error_count = sum(1 for r in known_results if r.get("status") in ("fetch_error", "no_url"))
    ok_count = sum(1 for r in known_results if r.get("status") == "ok")

    return {
        "status": "ok",
        "scanned_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "sample_ma_bn": sample_ma_bn,
        "summary": {
            "known_pages_total": len(known_results),
            "known_pages_ok": ok_count,
            "known_pages_changed": changed_count,
            "known_pages_error": error_count,
            "discovered_pages_new": len(discovered_results),
            "discovered_links_seen_total": len(discovered_links),
        },
        "known_pages": known_results,
        "discovered_pages": discovered_results,
        "known_gaps": manifest.get("known_gaps", []),
        "warning": warning,
        "inpatient_scan_diag": inpatient_scan_diag,
        "inpatient_list_source": inpatient_list_source,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Dò cấu trúc EMR, so với danh mục đã biết")
    parser.add_argument("--out", required=True, help="Đường dẫn file JSON kết quả")
    parser.add_argument("--max-discovered", type=int, default=15)
    args = parser.parse_args()

    try:
        report = run_scan(max_discovered=args.max_discovered)
    except Exception as exc:
        report = {"status": "error", "message": f"Lỗi khi dò cấu trúc EMR: {exc}"}

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(f"[emr_structure_scan] status={report.get('status')} -> {args.out}")
    return 0 if report.get("status") == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
