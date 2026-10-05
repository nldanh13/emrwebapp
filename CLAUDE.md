# Hướng dẫn cho người sửa code (người và AI)

Trước khi thay đổi bất cứ thứ gì, đọc:

1. [PRODUCT.md](PRODUCT.md) — người dùng, mục đích, nguyên tắc sản phẩm.
2. [DESIGN.md](DESIGN.md) — màu, chữ, nút, bố cục.
3. [docs/UX_RULES.md](docs/UX_RULES.md) — hành vi giao diện: chuyển tab, lưu, tác vụ chạy lâu,
   không mở EMR khi không cần, thông báo lỗi, quy trình mỗi lần thay đổi.

Tóm tắt những điều không được làm (chi tiết và lý do trong docs/UX_RULES.md):

- Không để chuyển tab làm mất dữ liệu đang xem/đang nhập: tab mới phải nằm trong danh sách
  `KeepAliveTab` của `src/App.jsx`; màn hình tải dữ liệu lúc mở phải có `useOnTabReturn`.
- Không để mất thao tác im lặng: chỉnh sửa tự lưu, hoặc hiện "Chưa lưu" và lưu trước khi chuyển.
- Không mở EMR lấy lại dữ liệu đã có trong kho; ghi trạng thái "đã lấy" đúng định dạng worker.
- Bước xem trước và bước lưu/xuất dùng chung một hàm, có test so kết quả.
- Lỗi bằng tiếng Việt, nói rõ làm gì tiếp; không hiện "404 Not Found" hay traceback trần.
- Không in token/mật khẩu/.env.

Mỗi lần sửa:

- Sửa lỗi thì viết test tái hiện lỗi trước.
- `npm run test:ci` phải xanh (gồm `node scripts/ux_rules_check.mjs`).
- Có thay đổi phía máy chủ thì nhắc người dùng khởi động lại máy chủ lúc không có tác vụ đang chạy.
- Giao diện, thông báo, tài liệu cho người dùng viết bằng tiếng Việt có dấu.
