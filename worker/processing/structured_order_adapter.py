# -*- coding: utf-8 -*-
"""Adapter for completed EMR doctor slips -> legacy classification + lossless source.

The source has individual completed slips with separate medicine, VTYT and
clinical-service arrays. The legacy classifier expects medication text. Do
not feed equipment/services into the medication parser.
"""
import re
from copy import deepcopy


def _clean(value):
    return str(value or "").strip()


def _order_forms(record):
    """Returns unique completed slips in source order (never dedupe by drug name)."""
    forms = record.get("order_history") if isinstance(record, dict) else None
    if not isinstance(forms, list):
        return None  # legacy record; use its original "Y lệnh" unchanged
    seen, result = set(), []
    for form in forms:
        if not isinstance(form, dict):
            continue
        status = _clean(form.get("trang_thai_y_lenh")).casefold()
        if status and status != "hoàn tất":
            continue
        form_id = _clean(form.get("id"))
        if form_id and form_id in seen:
            continue
        if form_id:
            seen.add(form_id)
        result.append(form)
    return result


def _service_rows(form):
    sections = form.get("chi_dinh_khac") or {}
    if not isinstance(sections, dict):
        return []
    result = []
    for category, section in sections.items():
        if not isinstance(section, dict):
            continue
        for table in section.get("bang") or []:
            if not isinstance(table, dict):
                continue
            headers = [_clean(x).lower() for x in (table.get("cot") or [])]
            def column(*names):
                return next((i for i, label in enumerate(headers)
                             if any(name in label for name in names)), -1)
            name_idx = column("thông tin chỉ định", "tên dịch vụ")
            order_time_idx = column("thời gian chỉ định")
            status_idx = column("trạng thái")
            for entry in table.get("dong") or []:
                if not isinstance(entry, dict):
                    continue
                cells = entry.get("gia_tri") or []
                if not isinstance(cells, list):
                    continue
                # Category-heading rows are not service orders.
                if name_idx < 0 or name_idx >= len(cells) or len(cells) != len(headers):
                    continue
                name = _clean(cells[name_idx])
                if not name:
                    continue
                result.append({
                    "id": _clean(entry.get("id")),
                    "so_phieu": _clean(form.get("so_phieu")),
                    "loai": category,
                    "ten": name,
                    "gio": _clean(cells[order_time_idx]) if 0 <= order_time_idx < len(cells) else "",
                    "trang_thai": _clean(cells[status_idx]) if 0 <= status_idx < len(cells) else "",
                    "cot": deepcopy(table.get("cot") or []),
                    "gia_tri": deepcopy(cells),
                })
    return result


def build_classification_text(forms):
    """Produce per-slip medication/other-order blocks; exclude VTYT completely."""
    blocks = []
    for form in forms or []:
        order_time = _clean(form.get("gio_y_lenh"))
        m = re.search(r"(?<!\d)(\d{1,2}:\d{2})(?!\d)", order_time)
        hour = m.group(1) if m else "00:00"
        doc = _clean(form.get("bac_si_chi_dinh") or form.get("bac_si")) or "Không rõ"
        # Remove characters that could create fake multiline doctor headers.
        doc = " ".join(doc.splitlines())
        lines = [f"{hour} | Bác sĩ: {doc}"]
        if _clean(form.get("dien_bien_benh")).casefold() == "dự trù thuốc":
            lines.append("Dự trù thuốc")
        meds = form.get("thuoc") or []
        if meds:
            lines.append("+ Thuốc:")
        for med in meds:
            if not isinstance(med, dict):
                continue
            name = _clean(med.get("ten_duoc"))
            if not name:
                continue
            qty = _clean(med.get("so_luong"))
            unit = _clean(med.get("don_vi"))
            drug_line = name
            if qty:
                drug_line += f" x {qty}"
            if unit:
                drug_line += f" ({unit})"
            strength = _clean(med.get("ham_luong"))
            if strength:
                drug_line += f" - {strength}"
            usage = _clean(med.get("cach_dung")) or _clean(med.get("duong_dung"))
            mixing = _clean(med.get("thuoc_pha"))
            if mixing:
                usage = (usage + " | " if usage else "") + "Thuốc pha: " + mixing
            if usage:
                drug_line += " | " + usage
            lines.append(drug_line)
        other = form.get("y_lenh_khac_muc")
        if not isinstance(other, list):
            other = _clean(form.get("y_lenh_khac")).splitlines()
        other = [_clean(x) for x in other if _clean(x)]
        if other:
            lines.append("+ Y lệnh khác:")
            lines.extend(other)
        follow_up = form.get("y_lenh_theo_doi_muc")
        if not isinstance(follow_up, list):
            follow_up = _clean(form.get("y_lenh_theo_doi")).splitlines()
        follow_up = [_clean(x) for x in follow_up if _clean(x)]
        if follow_up:
            lines.append("+ Theo dõi:")
            lines.extend(follow_up)
        services = _service_rows(form)
        if services:
            lines.append("+ Chỉ định DVKT:")
            for svc in services:
                lines.append("- " + svc["ten"])
        blocks.append("\n".join(lines))
    return "\n".join(blocks)


def extract_structured_source(record):
    """Do not change the shape of old records; retain full original source rows."""
    forms = _order_forms(record)
    if forms is None:
        return None
    medications = []
    supplies = []
    services = []
    other_orders = []
    follow_up = []
    for form in forms:
        fid = _clean(form.get("id"))
        ticket = _clean(form.get("so_phieu"))
        for item in form.get("thuoc") or []:
            if isinstance(item, dict):
                medications.append({"so_phieu": ticket, "order_id": fid, **deepcopy(item)})
        for item in form.get("vat_tu_y_te") or []:
            if isinstance(item, dict):
                supplies.append({"so_phieu": ticket, "order_id": fid, **deepcopy(item)})
        services.extend(_service_rows(form))
        for key, target in (("y_lenh_khac", other_orders), ("y_lenh_theo_doi", follow_up)):
            content = _clean(form.get(key))
            if content:
                target.append({"so_phieu": ticket, "order_id": fid, "noi_dung": content})
    return {
        "source": "completed_emr_slips",
        "order_count": len(forms),
        "order_ids": [_clean(f.get("id")) for f in forms],
        "medications": medications,
        "supplies": supplies,
        "services": services,
        "other_orders": other_orders,
        "follow_up": follow_up,
    }
