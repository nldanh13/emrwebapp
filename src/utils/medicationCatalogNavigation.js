// Mỗi thuốc đang sử dụng chỉ có một cấu hình; nguồn và công cụ không phải
// những danh mục song song có tác dụng tự động lên y lệnh.
export const MAIN_SECTIONS = [
  { value: 'drugs', label: 'Thuốc đã cấu hình' },
  { value: 'sources', label: 'Tìm & thêm thuốc' },
  { value: 'tools', label: 'Công cụ' },
];
export const SOURCE_SECTIONS = [
  { value: 'hospital', label: 'Danh mục bệnh viện' },
  { value: 'new', label: 'Chưa nhận diện' },
  { value: 'builtin', label: 'Kiến thức sẵn có' },
];
export const TOOL_SECTIONS = [
  { value: 'check', label: 'Kiểm tra tiêm/truyền' },
  { value: 'ingredients', label: 'Gắn hoạt chất' },
  { value: 'cleanup', label: 'Dọn trùng' },
  { value: 'routes', label: 'Thiết kế đường dùng' },
];
export const SECTION_DESCRIPTIONS = {
  drugs: 'Nơi duy nhất quản lý cấu hình thuốc mà hệ thống dùng để nhận diện y lệnh, đường dùng và quy tắc pha.',
  sources: 'Các nguồn giúp tìm thuốc để cấu hình. Xem và tìm kiếm không tự kích hoạt thuốc hay thay đổi y lệnh.',
  tools: 'Kiểm tra cách phân loại tiêm/truyền và quản lý các thiết lập nâng cao khi cần.',
};
export const SOURCE_DESCRIPTIONS = {
  hospital: 'Mã/tên/hàm lượng trích từ danh sách bệnh viện đã cung cấp. Chọn “Tạo cấu hình”, kiểm tra rồi lưu; không tự nhập hàng loạt.',
  new: 'Thuốc đã thấy trong y lệnh lưu tại ứng dụng nhưng chưa nhận diện trong danh mục đang dùng.',
  builtin: 'Luật kiến thức đi kèm ứng dụng. Chỉ chép vào danh mục khi cần chỉnh sửa; danh mục đã cấu hình được ưu tiên.',
};
