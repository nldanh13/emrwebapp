---
name: EMR Data Hub
description: Công cụ vận hành dữ liệu người bệnh nội trú cho điều dưỡng và hành chánh khoa
colors:
  canvas: "#f4f7fb"
  surface: "#ffffff"
  surface-subtle: "#f7f9fc"
  surface-selected: "#edf4ff"
  surface-muted: "#eef3f8"
  border: "#d7e0ec"
  border-soft: "#e7ecf3"
  ink: "#172033"
  ink-secondary: "#46546c"
  ink-tertiary: "#5f6d86"
  accent: "#2463d4"
  accent-soft: "#eef4ff"
  accent-line: "#c5d6f8"
  success: "#07755a"
  success-soft: "#edf9f4"
  warning: "#a35a00"
  warning-soft: "#fff8eb"
  danger: "#c93232"
  danger-soft: "#fff1f1"
  selection: "#dbe8ff"
  scrim: "rgba(15, 23, 42, 0.42)"
typography:
  page-title:
    fontFamily: "Aptos, Segoe UI Variable, Segoe UI, sans-serif"
    fontSize: "16.5px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  section-title:
    fontSize: "14.5px"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.35
  caption:
    fontSize: "11.5px"
    fontWeight: 500
    lineHeight: 1.35
  data:
    fontSize: "13px"
    fontFeature: "tnum"
rounded:
  sm: "5px"
  md: "7px"
  lg: "10px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    height: "32px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: "32px"
  nav-item-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    rounded: "{rounded.sm}"
---

# Design System: EMR Data Hub

## Overview

**North Star (đề xuất): "Bảng việc của khoa"** — một mặt bàn làm việc sạch, trả lời ngay "người bệnh nào còn việc gì", rồi lùi lại cho người dùng làm việc.

Chế độ **Operate** (Impeccable): công cụ phải tan vào công việc. Nền sáng, một màu nhấn xanh dương, mật độ thông tin cao nhưng có nhịp. Nhận diện hiện có (nền xanh xám nhạt, thẻ trắng, nhấn xanh) được **giữ nguyên theo lựa chọn của người dùng (09/2026)**; đợt tinh chỉnh chỉ sửa độ tương phản, cỡ chữ, sự nhất quán và bố cục.

Thang đo taste-skill cho sản phẩm này: **DESIGN_VARIANCE 3 · MOTION_INTENSITY 2 · VISUAL_DENSITY 7** (công cụ nội bộ, cần tin cậy, nhiều dữ liệu).

**Key Characteristics:**
- Một màu nhấn (`accent`) chỉ dùng cho thao tác chính, mục đang chọn và trạng thái "đang chạy".
- Màu trạng thái chỉ mang nghĩa trạng thái: xanh lục = xong/ổn, cam = cần xem, đỏ = lỗi/ưu tiên. Luôn kèm chữ hoặc icon.
- Một họ chữ hệ thống cho mọi thứ; số liệu dùng chữ số đều (`tabular-nums`).
- Icon từ **Tabler Icons** (`@tabler/icons-react`), nét 1.75, không dùng ký tự Unicode làm icon.

## Colors

Xanh xám mát, một nhấn xanh dương. Mọi màu chữ đạt WCAG AA (≥4,5:1) trên `surface`, `canvas` và các nền nhạt trạng thái.

- `ink` chữ chính; `ink-secondary` chữ phụ/nhãn; `ink-tertiary` ghi chú, chú thích. Không có màu chữ nào nhạt hơn `ink-tertiary`.
- Tím, cam đậm, xanh ngọc (`purple`, `orange`, `cyan` trong `src/tokens.js`) chỉ dùng để **phân loại** trong dòng thời gian (loại y lệnh), không dùng cho nút hay trạng thái.
- Nguồn giá trị: `src/tokens.js` (`C`) cho style trong JSX và biến `--emr-*` trong `src/styles/app.css`; hai nơi phải khớp nhau.

## Typography

Họ chữ hệ thống Windows (`Aptos`, `Segoe UI Variable`, `Segoe UI`), không tải font từ ngoài vì app chạy trong mạng nội bộ. Thang cố định (px), tỉ lệ ~1.13: 11.5 · 12 · 13 · 14.5 · 16.5.

- **Tối thiểu 11.5px** cho mọi chữ người dùng cần đọc (trước đây có nhãn 9.5–10.5px).
- Không viết HOA toàn bộ cho nhãn nhóm hay nhãn trường; dùng chữ thường có dấu (sentence case).
- Không đặt "eyebrow" (nhãn nhỏ viết hoa) phía trên tiêu đề.

## Layout

- Khung: menu trái 232px (máy tính) · thanh trên 56px · thanh khoảng ngày (chỉ ở màn hình dùng ngày) · vùng nội dung tối đa 1480px.
- Điện thoại (<768px): không có menu trái; **thanh điều hướng dưới** gồm 4 màn hình hằng ngày + "Tất cả" (mở menu đầy đủ). Vùng bấm ≥40px.
- Mỗi màn hình có **một** tiêu đề (ở thanh trên); nội dung không lặp lại tiêu đề đó.
- Nhịp khoảng cách theo bội số 4px; nhóm liên quan cách 8px, nhóm khác nhau cách 16–24px.

## Elevation & Depth

Phẳng, phân lớp bằng nền (`canvas` → `surface`) và viền 1px. Bóng đổ chỉ cho lớp nổi (menu điện thoại, thông báo, hộp thoại): `0 10px 30px rgba(25,45,75,0.10)`. Không vừa viền vừa bóng lớn trên thẻ thường.

## Shapes

Góc bo `sm` 5px cho nút/ô nhập/chip, `md` 7px cho thẻ và panel, `lg` 10px cho lớp nổi. Không bo tròn kiểu viên thuốc cho nút.

## Components

- **Nút** (`Btn` trong `src/components/shared.jsx`): cao 32px (điện thoại 40px). Một nút chính (`solidPrimary`) cho mỗi vùng thao tác; còn lại là `default`. Đủ trạng thái hover, focus (vòng 2px màu nhấn), active, disabled, loading.
- **Menu trái**: nhóm theo công việc, mục đang chọn nền `accent-soft` + chữ `accent` + icon cùng màu; không dùng viền màu bên trái.
- **Ô chọn ngày** (`DateField`): luôn hiển thị `dd/mm/yyyy` bất kể ngôn ngữ trình duyệt; bấm để mở lịch của trình duyệt.
- **Thông báo**: góc dưới phải (điện thoại: phía trên thanh điều hướng dưới). Lỗi nói việc gì không làm được và lý do bằng tiếng Việt; không hiện đường dẫn API. Có nút đóng; lỗi tự ẩn sau 9 giây.

## Do's and Don'ts

- **Do** dùng icon Tabler cho mọi hành động có icon; kèm `aria-label` khi nút chỉ có icon.
- **Do** dùng token màu từ `C`/`--emr-*`; không viết mã màu mới trong component.
- **Don't** dùng ký tự Unicode (◇ ◎ ⊘ ⌕ ☰ ✕) làm icon.
- **Don't** thêm nhãn viết HOA nhỏ phía trên tiêu đề, viền màu dày bên trái thẻ, hay chữ nhỏ hơn 11.5px.
- **Don't** dùng nhiều màu cho các nút cùng cấp; màu là tín hiệu trạng thái, không phải trang trí.
