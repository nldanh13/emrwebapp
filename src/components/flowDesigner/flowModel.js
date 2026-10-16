// Mô hình dữ liệu của tab "Thiết kế luồng": một luồng gồm nhiều màn hình, mỗi màn hình gồm nhiều ô.
// Ô "Nút" và ô "Chức năng" có thể nối tới một màn hình khác: bấm vào thì mở màn hình đó.
// Mọi thay đổi đi qua các hàm thuần ở đây (trả bản mới, không sửa bản cũ) để phần Thiết kế,
// phần Chạy thử và phần Xuất/Nhập dùng chung một cách hiểu dữ liệu (docs/UX_RULES.md mục 5.1).

export const FLOW_VERSION = 1;

export const ELEMENT_TYPES = {
  heading: { label: 'Tiêu đề / ghi chú', linkable: false },
  input: { label: 'Ô nhập', linkable: false },
  select: { label: 'Ô chọn', linkable: false },
  button: { label: 'Nút', linkable: true },
  tile: { label: 'Ô chức năng', linkable: true },
  list: { label: 'Danh sách / bảng', linkable: false },
};
export const ELEMENT_TYPE_ORDER = ['tile', 'button', 'input', 'select', 'list', 'heading'];

let seq = 0;
export function newId(prefix) {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const DEFAULT_LABEL = {
  heading: 'Tiêu đề', input: 'Ô nhập', select: 'Ô chọn', button: 'Nút', tile: 'Chức năng', list: 'Danh sách',
};

export function makeElement(type, fields = {}) {
  const t = ELEMENT_TYPES[type] ? type : 'heading';
  return normalizeElement({ id: newId('el'), type: t, label: DEFAULT_LABEL[t], ...fields });
}

export function normalizeElement(raw = {}) {
  const type = ELEMENT_TYPES[raw.type] ? raw.type : 'heading';
  return {
    id: String(raw.id || newId('el')),
    type,
    label: String(raw.label ?? '').slice(0, 200),
    hint: String(raw.hint ?? '').slice(0, 400),
    // Ô chọn: các lựa chọn; danh sách: tên các cột. Mỗi mục một chuỗi.
    options: Array.isArray(raw.options) ? raw.options.map(o => String(o ?? '').trim()).filter(Boolean).slice(0, 30) : [],
    target: ELEMENT_TYPES[type].linkable && raw.target ? String(raw.target) : '',
  };
}

export function normalizeScreen(raw = {}) {
  return {
    id: String(raw.id || newId('sc')),
    name: String(raw.name ?? '').slice(0, 120) || 'Màn hình',
    // Nhóm để xếp danh sách màn hình theo menu (vd. "Điều dưỡng"); trống thì không nhóm.
    group: String(raw.group ?? '').slice(0, 60),
    // Các bước máy làm / người dùng thao tác ở màn hình này, mỗi dòng một bước.
    note: String(raw.note ?? '').slice(0, 4000),
    elements: (Array.isArray(raw.elements) ? raw.elements : []).map(normalizeElement),
  };
}

// Đọc luồng từ kho/tệp nhập: bỏ phần hỏng, giữ phần dùng được, không ném lỗi.
export function normalizeFlow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const screens = (Array.isArray(raw.screens) ? raw.screens : []).map(normalizeScreen);
  if (!screens.length) return null;
  const ids = new Set();
  const unique = screens.filter(s => (ids.has(s.id) ? false : (ids.add(s.id), true)));
  const startId = ids.has(raw.startId) ? raw.startId : unique[0].id;
  return { version: FLOW_VERSION, name: String(raw.name ?? '').slice(0, 120) || 'Luồng chức năng', startId, screens: unique };
}

// Luồng mẫu theo ví dụ: Đăng nhập → Trang chính (các ô chức năng) → Danh sách điều trị nội trú.
export function createSampleFlow() {
  const login = { id: 'sc_login', name: 'Đăng nhập', note: '', elements: [] };
  const home = { id: 'sc_home', name: 'Trang chính', note: '', elements: [] };
  const clinic = { id: 'sc_clinic', name: 'Danh sách phòng khám', note: '', elements: [] };
  const inpatient = { id: 'sc_inpatient', name: 'Danh sách điều trị nội trú', note: '', elements: [] };
  login.elements = [
    makeElement('heading', { label: 'Đăng nhập EMR Data Hub' }),
    makeElement('input', { label: 'Tài khoản' }),
    makeElement('input', { label: 'Mật khẩu' }),
    makeElement('button', { label: 'Đăng nhập', target: home.id }),
  ];
  home.elements = [
    makeElement('heading', { label: 'Chọn chức năng' }),
    makeElement('tile', { label: 'Danh sách phòng khám', hint: 'Người bệnh khám ngoại trú trong ngày', target: clinic.id }),
    makeElement('tile', { label: 'Danh sách điều trị nội trú', hint: 'Người bệnh đang nằm khoa', target: inpatient.id }),
  ];
  clinic.elements = [
    makeElement('select', { label: 'Phòng khám', options: ['Phòng 1', 'Phòng 2'] }),
    makeElement('list', { label: 'Người bệnh chờ khám', options: ['Họ tên', 'Giờ đến', 'Trạng thái'] }),
    makeElement('button', { label: 'Quay lại', target: home.id }),
  ];
  inpatient.elements = [
    makeElement('input', { label: 'Tên người bệnh' }),
    makeElement('button', { label: 'Tìm kiếm' }),
    makeElement('list', { label: 'Kết quả', options: ['Mã BN', 'Họ tên', 'Giường'] }),
    makeElement('button', { label: 'Quay lại', target: home.id }),
  ];
  return normalizeFlow({ name: 'Luồng chức năng', startId: login.id, screens: [login, home, clinic, inpatient] });
}

const mapScreen = (flow, screenId, fn) => ({ ...flow, screens: flow.screens.map(s => (s.id === screenId ? fn(s) : s)) });

export function addScreen(flow, name = 'Màn hình mới') {
  const screen = normalizeScreen({ id: newId('sc'), name, elements: [] });
  return { flow: { ...flow, screens: [...flow.screens, screen] }, screenId: screen.id };
}

export function screenSteps(screen) {
  return String(screen?.note || '').split('\n').map(line => line.trim()).filter(Boolean);
}

export function updateScreen(flow, screenId, patch) {
  return mapScreen(flow, screenId, s => normalizeScreen({ ...s, ...patch, id: s.id, elements: s.elements }));
}

// Xóa màn hình: các ô đang nối tới nó được gỡ nối (không để nút trỏ vào màn hình không còn).
export function removeScreen(flow, screenId) {
  if (flow.screens.length <= 1) return flow;
  const screens = flow.screens.filter(s => s.id !== screenId).map(s => ({
    ...s,
    elements: s.elements.map(el => (el.target === screenId ? { ...el, target: '' } : el)),
  }));
  return { ...flow, screens, startId: flow.startId === screenId ? screens[0].id : flow.startId };
}

export function setStartScreen(flow, screenId) {
  return flow.screens.some(s => s.id === screenId) ? { ...flow, startId: screenId } : flow;
}

export function addElement(flow, screenId, type) {
  const el = makeElement(type);
  return { flow: mapScreen(flow, screenId, s => ({ ...s, elements: [...s.elements, el] })), elementId: el.id };
}

export function updateElement(flow, screenId, elementId, patch) {
  return mapScreen(flow, screenId, s => ({
    ...s,
    elements: s.elements.map(el => (el.id === elementId ? normalizeElement({ ...el, ...patch, id: el.id }) : el)),
  }));
}

export function removeElement(flow, screenId, elementId) {
  return mapScreen(flow, screenId, s => ({ ...s, elements: s.elements.filter(el => el.id !== elementId) }));
}

export function moveElement(flow, screenId, elementId, delta) {
  return mapScreen(flow, screenId, s => {
    const i = s.elements.findIndex(el => el.id === elementId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= s.elements.length) return s;
    const elements = [...s.elements];
    [elements[i], elements[j]] = [elements[j], elements[i]];
    return { ...s, elements };
  });
}

// Các mũi tên của luồng: ô nào trên màn hình nào mở màn hình nào.
export function flowLinks(flow) {
  const links = [];
  for (const s of flow.screens) {
    for (const el of s.elements) if (el.target) links.push({ from: s.id, to: el.target, elementId: el.id, label: el.label });
  }
  return links;
}

// Kiểm tra luồng: nút trỏ vào màn hình không có, màn hình không đi tới được từ màn hình bắt đầu.
export function checkFlow(flow) {
  const ids = new Set(flow.screens.map(s => s.id));
  const name = id => flow.screens.find(s => s.id === id)?.name || '';
  const problems = [];
  const links = flowLinks(flow);
  for (const l of links) {
    if (!ids.has(l.to)) problems.push(`Ô "${l.label}" trên màn hình "${name(l.from)}" nối tới màn hình đã xóa.`);
  }
  const reached = new Set([flow.startId]);
  const queue = [flow.startId];
  while (queue.length) {
    const cur = queue.shift();
    for (const l of links) if (l.from === cur && ids.has(l.to) && !reached.has(l.to)) { reached.add(l.to); queue.push(l.to); }
  }
  for (const s of flow.screens) {
    if (!reached.has(s.id)) problems.push(`Màn hình "${s.name}" chưa có ô nào dẫn tới từ "${name(flow.startId)}".`);
  }
  return problems;
}

// Sơ đồ cây của luồng: từ màn hình bắt đầu, mỗi màn hình liệt kê các ô bấm được và màn hình mở ra,
// màn hình đó lại bung tiếp các ô của nó. Mỗi màn hình chỉ bung một lần, ở chỗ gần màn hình bắt đầu
// nhất (duyệt theo chiều rộng); những chỗ khác dẫn tới nó ghi là "đã có ở nhánh khác".
export function buildFlowTree(flow, startId = flow.startId) {
  const byId = new Map(flow.screens.map(s => [s.id, s]));
  if (!byId.has(startId)) return null;
  const owner = new Map([[startId, null]]); // màn hình → ô (screenId:elementId) được bung nó
  const queue = [startId];
  while (queue.length) {
    const s = byId.get(queue.shift());
    for (const el of s.elements) {
      if (el.target && byId.has(el.target) && !owner.has(el.target)) {
        owner.set(el.target, `${s.id}:${el.id}`);
        queue.push(el.target);
      }
    }
  }
  const build = (screen, depth) => ({
    screen,
    depth,
    fields: screen.elements.filter(el => !ELEMENT_TYPES[el.type].linkable && el.type !== 'heading'),
    actions: screen.elements.filter(el => ELEMENT_TYPES[el.type].linkable).map(el => {
      const target = el.target && byId.get(el.target);
      if (!target) return { element: el, target: null, child: null };
      const expandHere = owner.get(target.id) === `${screen.id}:${el.id}`;
      return { element: el, target, child: expandHere ? build(target, depth + 1) : null };
    }),
  });
  return build(byId.get(startId), 0);
}
