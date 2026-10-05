#!/usr/bin/env node
// Kiểm tra tự động một phần docs/UX_RULES.md (chạy trong npm run test:ci).
//  R1  Mọi tab trong config/feature_registry.json → navigation được App giữ lại khi chuyển tab
//      (nằm trong danh sách KeepAliveTab), không vẽ kiểu {tab === 'x' && <X />}.
//  R2  Màn hình tab tải dữ liệu lúc mở (useEffect(() => { load(); })) phải cập nhật lại khi người
//      dùng quay lại tab (useOnTabReturn hoặc nghe sự kiện emr:tab-active).
//  R3  Màn hình tab có tự làm mới định kỳ (setInterval gọi máy chủ) phải dừng khi tab ẩn
//      (useTabActive) hoặc chỉ chạy khi có việc đang chạy; ghi rõ bằng chú thích "ux-rules: polling-ok".
//  R4  Màn hình số liệu (mục 9): khung hiển thị chỉ nhận gói số liệu qua props, không tự gọi
//      máy chủ (không import api.js); file dùng kho chung useServerData không tự setInterval gọi
//      máy chủ — máy chủ báo qua kênh sự kiện (hẹn giờ dự phòng chỉ khi có useRealtimeConnected).
//  R5  Màn hình tab còn hẹn giờ gọi máy chủ thì hẹn giờ đó phải là dự phòng theo kênh sự kiện
//      (useRealtimeConnected), hoặc ghi "ux-rules: no-realtime — <lý do>" khi nguồn không theo dõi được.
// Chạy: node scripts/ux_rules_check.mjs
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = process.cwd();
const read = p => readFileSync(join(ROOT, p), 'utf8');
const problems = [];

const registry = JSON.parse(read('config/feature_registry.json'));
const navIds = (registry.navigation || []).map(n => n.id);
const app = read('src/App.jsx');

// R1
for (const id of [...navIds, 'functions']) {
  if (!app.includes(`['${id}', () =>`)) problems.push(`R1: tab "${id}" chưa nằm trong danh sách KeepAliveTab của src/App.jsx.`);
}
if (/\{tab === '[^']+'\s*&&\s*</.test(app)) problems.push('R1: src/App.jsx còn vẽ tab kiểu {tab === \'x\' && <X />} (bị gỡ khi chuyển tab). Thêm vào danh sách KeepAliveTab.');

// Màn hình tab = các file App nạp bằng lazy(() => import('./components/...')).
const tabFiles = [...app.matchAll(/lazy\(\(\) => import\('\.\/([^']+)'\)\)/g)].map(m => join('src', m[1]));

for (const file of tabFiles) {
  if (!existsSync(join(ROOT, file))) continue;
  let src = read(file);
  // Màn hình dùng hook riêng (vd. useHchanh) thì xét cả hook đó.
  for (const m of src.matchAll(/from '(\.\/[^']+use[A-Z][^']*)'/g)) {
    const hook = join(dirname(file), m[1]).replace(/(\.js)?$/, '.js');
    if (existsSync(join(ROOT, hook))) src += read(hook);
  }
  const refreshesOnReturn = /useOnTabReturn\(|'emr:tab-active'/.test(src);
  const loadsOnMount = /useEffect\(\(\) => \{ *(load|reload)\(\); *\}, \[/.test(src) || /useEffect\(\(\) => \{\s*let cancelled = false;[\s\S]{0,200}?(getHchanh_Dashboard|getRecordsCheckDashboard)/.test(src);
  // R2
  if (loadsOnMount && !refreshesOnReturn) problems.push(`R2: ${file} tải dữ liệu lúc mở nhưng không cập nhật khi quay lại tab (thêm useOnTabReturn).`);
  const pollsServer = /setInterval\(\s*(\(\)\s*=>\s*\{?\s*)?(load|refresh|fetch|revalidate)\w*/.test(src);
  // R5
  if (pollsServer && !/useRealtimeConnected\(|ux-rules: no-realtime/.test(src)) {
    problems.push(`R5: ${file} hẹn giờ hỏi máy chủ mà không theo kênh sự kiện. Đăng ký watchScreen ở route, dùng useServerData/useScreenChanged, hẹn giờ chỉ khi !useRealtimeConnected() (hoặc ghi "ux-rules: no-realtime — lý do").`);
  }
  // R3
  if (/setInterval\(\s*(load|refresh|fetch)\w*/.test(src) && !/useTabActive\(|ux-rules: polling-ok/.test(src)) {
    problems.push(`R3: ${file} tự làm mới định kỳ mà không dừng khi tab ẩn (dùng useTabActive, hoặc ghi "ux-rules: polling-ok" nếu chỉ chạy khi có việc đang chạy).`);
  }
}

// R4
const SCREEN_VIEWS = [
  'src/components/research/ResearchMonitor.jsx',
  'src/components/research/GeneralOverviewView.jsx',
  'src/components/research/dataHealth.js',
];
for (const file of SCREEN_VIEWS) {
  if (!existsSync(join(ROOT, file))) { problems.push(`R4: không thấy ${file} (cập nhật danh sách SCREEN_VIEWS).`); continue; }
  if (/from '[^']*\/api(\.js)?'/.test(read(file))) problems.push(`R4: ${file} là khung hiển thị số liệu nhưng tự gọi máy chủ (import api.js). Nhận gói số liệu qua props.`);
}
const srcFiles = [];
const walk = (dir) => {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
    else if (/\.(jsx?|mjs)$/.test(name) && !/\.test\./.test(name)) srcFiles.push(rel);
  }
};
walk('src');
let screenFiles = 0;
for (const file of srcFiles) {
  const src = read(file);
  if (!/useServerData\(/.test(src) || file.endsWith('useServerData.js')) continue;
  screenFiles += 1;
  if (/setInterval\(\s*(\(\)\s*=>\s*\{?\s*)?(load|refresh|fetch|revalidate|screenQuery)\w*/.test(src)
    && !/useRealtimeConnected\(/.test(src)) {
    problems.push(`R4: ${file} dùng kho chung useServerData nhưng tự hẹn giờ gọi máy chủ. Để kênh sự kiện (invalidate) báo khi số liệu đổi; hẹn giờ dự phòng phải theo useRealtimeConnected (thưa khi kênh đang nối).`);
  }
}

if (problems.length) {
  console.error('[ux-rules] Không đạt docs/UX_RULES.md:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`[ux-rules] OK: ${navIds.length + 1} tab giữ lại khi chuyển tab, ${tabFiles.length} màn hình đạt R2/R3/R5, ${SCREEN_VIEWS.length} khung hiển thị + ${screenFiles} màn hình dùng kho chung đạt R4.`);
