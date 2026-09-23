#!/usr/bin/env node
'use strict';

// Sinh docs/DATA_DICTIONARY.md từ server/research/data_dictionary.js.
//   node scripts/build_data_dictionary.js          # ghi lại file
//   node scripts/build_data_dictionary.js --check  # báo lỗi nếu file đang lệch (dùng trong CI)

const fs = require('fs');
const path = require('path');

const dict = require('../server/research/data_dictionary');

const OUT = path.join(__dirname, '..', 'docs', 'DATA_DICTIONARY.md');

const TYPE_LABEL = {
  string: 'chuỗi', text: 'văn bản', integer: 'số nguyên', decimal: 'số thập phân',
  date: 'ngày', datetime: 'ngày giờ', flag01: 'cờ 1/0', enum: 'danh mục', json: 'JSON',
};
const IDENT_LABEL = {
  direct: 'Trực tiếp', quasi: 'Gián tiếp', free_text: 'Văn bản tự do', staff: 'Nhân viên',
  pseudonymous: 'Giả danh', none: '—',
};
const USE_LABEL = { allowed: 'Được dùng', approval_required: 'Cần đề cương duyệt', excluded: 'Loại (bị che khi xuất)' };

function cell(value) {
  if (value == null || value === '') return '';
  const s = Array.isArray(value) ? value.map(v => `\`${v}\``).join(', ') : String(value);
  return s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

function valueCell(c) {
  const parts = [];
  if (c.unit) parts.push(`Đơn vị: ${cell(c.unit)}`);
  if (c.format) parts.push(`Dạng: ${cell(c.format)}`);
  if (c.allowed) parts.push(Array.isArray(c.allowed) ? cell(c.allowed) : cell(c.allowed));
  return parts.join('; ');
}

function meaningCell(c) {
  const parts = [cell(c.meaning)];
  if (c.derivation) parts.push(`Cách tính: ${cell(c.derivation)}`);
  if (c.source) parts.push(`Nguồn: ${cell(c.source)}`);
  if (c.inferred) parts.push('**Suy luận tự động.**');
  if (c.note) parts.push(`Lưu ý: ${cell(c.note)}`);
  return parts.join(' ');
}

function list(items) {
  return (items || []).length ? items.map(i => `- ${i}`).join('\n') : '- (không có)';
}

function render() {
  const lines = [];
  lines.push('# Từ điển dữ liệu Kho nghiên cứu');
  lines.push('');
  lines.push(`> File này được sinh tự động từ \`server/research/data_dictionary.js\` (phiên bản \`${dict.DICTIONARY_VERSION}\`). Đừng sửa tay: sửa file nguồn rồi chạy \`node scripts/build_data_dictionary.js\`.`);
  lines.push('>');
  lines.push('> Mô tả được viết từ code chuẩn hóa hiện tại. Cột "Dùng" là đề xuất kỹ thuật; phạm vi dùng thực tế phải theo đề cương được hội đồng đạo đức/bệnh viện phê duyệt.');
  lines.push('');
  lines.push('## Quy ước chung');
  lines.push('');
  for (const v of Object.values(dict.CONVENTIONS)) lines.push(`- ${v}`);
  lines.push('');
  lines.push('**Định danh:** Trực tiếp = nhận diện được người bệnh hoặc tra ngược EMR; Gián tiếp = có thể góp phần nhận diện khi kết hợp; Văn bản tự do = có thể lẫn tên/SĐT do người nhập gõ; Nhân viên = thông tin nhân viên y tế; Giả danh = mã do hệ thống tạo.');
  lines.push('');
  lines.push('**Dùng:** Được dùng = đưa vào dataset nghiên cứu; Cần đề cương duyệt = chỉ đưa vào khi đề cương cần tới (hiện **không** bị tự che khi xuất); Loại = mặc định bị che khi xem/xuất.');
  lines.push('');
  lines.push('## Danh sách bảng');
  lines.push('');
  lines.push('| Bảng | Mỗi dòng là | Khóa chính |');
  lines.push('|---|---|---|');
  for (const [name, t] of Object.entries(dict.TABLES)) {
    lines.push(`| [\`${t.file}\`](#${name}) | ${cell(t.grain)} | ${cell(t.primary_key)} |`);
  }
  lines.push('');

  for (const [name, t] of Object.entries(dict.TABLES)) {
    lines.push(`## ${name}`);
    lines.push('');
    lines.push(`**File:** \`${t.file}\` · **Tầng:** ${t.tier === 'analysis' ? 'phân tích' : 'chuẩn hóa'} · **Có biến suy luận:** ${t.inferred ? 'có' : 'không'}`);
    lines.push('');
    lines.push(`**Mỗi dòng là:** ${t.grain}`);
    lines.push('');
    lines.push(`**Khóa chính (duy nhất):** ${cell(t.primary_key)}`);
    lines.push('');
    const fks = (t.foreign_keys || []).map(fk => `${cell(fk.columns)} → \`${fk.references}\`${fk.when ? ` (khi ${fk.when})` : ''}`);
    lines.push(`**Khóa nối:** ${fks.length ? fks.join('; ') : '(không có)'}${t.referenced_by?.length ? ` · Được nối từ: ${t.referenced_by.map(r => `\`${r}\``).join(', ')}` : ''}`);
    lines.push('');
    lines.push(`**Nguồn:** ${t.sources.join('; ')}`);
    lines.push('');
    lines.push(`**Cách xử lý:** ${t.processing}`);
    lines.push('');
    lines.push('**Quy tắc chất lượng**');
    lines.push('');
    lines.push(`- Bắt buộc: ${cell(t.quality.required)}`);
    lines.push(`- Duy nhất: ${cell(t.quality.unique)}`);
    for (const c of t.quality.checks || []) lines.push(`- ${c}`);
    lines.push('');
    lines.push('**Cần người kiểm tra khi:**');
    lines.push('');
    lines.push(list(t.quality.manual_review));
    lines.push('');
    if (t.dynamic_columns) {
      lines.push('**Cột sinh động (không cố định):**');
      lines.push('');
      for (const v of Object.values(t.dynamic_columns)) lines.push(`- ${v}`);
      lines.push('');
    }
    lines.push('| Cột | Kiểu | Ý nghĩa | Giá trị / đơn vị | Ô trống nghĩa là | Định danh | Dùng |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const [colName, c] of Object.entries(t.columns)) {
      lines.push(`| \`${colName}\` | ${TYPE_LABEL[c.type] || c.type} | ${meaningCell(c)} | ${valueCell(c)} | ${cell(c.empty)} | ${IDENT_LABEL[c.identifier]} | ${USE_LABEL[c.use]} |`);
    }
    lines.push('');
  }

  lines.push('## Bảng thô (đầu vào)');
  lines.push('');
  lines.push('Bảng thô giữ nguyên dữ liệu EMR, **đều chứa định danh**, không dùng trực tiếp làm dataset nghiên cứu.');
  lines.push('');
  lines.push('| File | Mỗi dòng là | Lấy từ | Cột định danh |');
  lines.push('|---|---|---|---|');
  for (const t of Object.values(dict.RAW_TABLES)) {
    lines.push(`| \`${t.file}\` | ${cell(t.grain)} | ${cell(t.source)} | ${cell(t.identifiers.join(', '))} |`);
  }
  lines.push('');
  lines.push('## Hạn chế đã biết');
  lines.push('');
  lines.push(list(dict.KNOWN_ISSUES));
  lines.push('');
  return lines.join('\n');
}

const content = render();
if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf-8') : '';
  if (current !== content) {
    console.error('docs/DATA_DICTIONARY.md lệch với server/research/data_dictionary.js. Chạy: node scripts/build_data_dictionary.js');
    process.exit(1);
  }
  console.log('docs/DATA_DICTIONARY.md khớp từ điển.');
} else {
  fs.writeFileSync(OUT, content, 'utf-8');
  console.log(`Đã ghi ${path.relative(process.cwd(), OUT)}`);
}
