// Nghỉ ốm tự động (tab Nghỉ ốm): chia hồ sơ của công cụ nhập cổng (tools/bhyt_selenium_app) thành
// danh sách ra viện (giấy ra viện, mẫu 03) và phòng khám (phiếu nghỉ, mẫu 07), và tóm tắt lượt chạy.

export const DOC_GRV = 'GRV03';
export const DOC_PHIEU = 'BHXH07';
export const EMR_SOURCE = 'EMR-phieu';

/** Nhóm của một hồ sơ: hỏi (thẻ DN chờ trả lời), loi, cho (sẵn sàng/chưa nhập), xong, bo (không nghỉ). */
export function recordGroup(r) {
  const answer = r?.fields?.hoi_nghi_om;
  if (answer === 'khong') return 'bo';
  if (r?.status === 'success') return 'xong';
  if (answer === 'can_hoi' && !r?.ready) return 'hoi';
  if (r?.status === 'error' || !r?.ready) return 'loi';
  return 'cho';
}

export const GROUP_ORDER = ['hoi', 'loi', 'cho', 'xong', 'bo'];

export const GROUP_LABELS = {
  hoi: 'Cần hỏi người bệnh',
  loi: 'Chưa nhập được',
  cho: 'Chờ nhập',
  xong: 'Đã nhập lên cổng',
  bo: 'Không nghỉ ốm',
};

/** Hồ sơ đọc từ EMR theo loại giấy, sắp theo nhóm (việc cần làm lên trước) rồi theo tên. */
export function listByDoc(records, docType) {
  return (records || [])
    .filter(r => r.doc_type === docType && r.source_file === EMR_SOURCE)
    .map(r => ({ ...r, group: recordGroup(r) }))
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)
      || String(a.patient_name || '').localeCompare(String(b.patient_name || ''), 'vi'));
}

export function countGroups(list) {
  const out = Object.fromEntries(GROUP_ORDER.map(g => [g, 0]));
  for (const r of list || []) out[r.group] += 1;
  return out;
}

/** Lý do chưa nhập được, tiếng Việt, gộp một dòng. */
export function recordProblem(r) {
  if (r?.issues?.length) return r.issues.join('; ');
  return r?.message || '';
}

function part(label, res) {
  if (!res) return '';
  if (res.skipped) return `${label}: ${res.skipped}`;
  if (res.error) return `${label}: lỗi, ${res.error}`;
  const ask = res.ask_sick_leave ? `, ${res.ask_sick_leave} ca thẻ DN cần hỏi` : '';
  return `${label}: ${res.scanned} ca, ${res.working_age} ca tuổi lao động, đọc được ${res.found} giấy${ask}`;
}

/** Các dòng tóm tắt lượt chạy gần nhất (để hiện dưới nút chạy). */
export function runSummaryLines(auto) {
  const r = auto?.results || {};
  const lines = [part('Phòng khám', r.clinic), part('Ra viện', r.discharge)].filter(Boolean);
  if (r.submit) {
    lines.push(r.submit.count
      ? `Nhập cổng: ${r.submit.success}/${r.submit.count} hồ sơ thành công${r.submit.error ? `, ${r.submit.error} lỗi` : ''}`
      : 'Nhập cổng: không có hồ sơ nào đủ dữ liệu để nhập');
  }
  return lines;
}
