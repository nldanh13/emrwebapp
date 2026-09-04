import { getPatientId, getPatientName, normalizeRoom } from './bedBoardUtils.js';

const COLUMNS_PER_PAGE = 3;
const COLUMN_CAPACITY_UNITS = 30;
const ROOM_HEADER_UNITS = 1.65;
const ROOM_GAP_UNITS = 0.45;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function roomNumber(room) {
  const match = String(room || '').match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function compareRooms(a, b) {
  const na = roomNumber(a);
  const nb = roomNumber(b);
  if (na !== nb) return na - nb;
  return String(a || '').localeCompare(String(b || ''), 'vi', { numeric: true, sensitivity: 'base' });
}

function displayRoom(room) {
  const normalized = normalizeRoom(room) || String(room || '').trim();
  const match = normalized.match(/^P0*(\d+)$/i);
  return match ? `P${Number.parseInt(match[1], 10)}` : normalized;
}

export function buildPrintableRoomGroups(patients = []) {
  const groups = new Map();
  for (const patient of Array.isArray(patients) ? patients : []) {
    const room = normalizeRoom(patient?.Vi_Tri || patient?.vi_tri || '');
    if (!room) continue;
    if (!groups.has(room)) groups.set(room, []);
    groups.get(room).push({
      id: getPatientId(patient),
      name: getPatientName(patient),
    });
  }

  return [...groups.entries()]
    .sort(([roomA], [roomB]) => compareRooms(roomA, roomB))
    .map(([room, roomPatients]) => ({
      room,
      displayRoom: displayRoom(room),
      patients: roomPatients,
    }));
}

export function paginateRoomGroups(groups = [], options = {}) {
  const columnsPerPage = Math.max(1, Number(options.columnsPerPage || COLUMNS_PER_PAGE));
  const capacity = Math.max(8, Number(options.columnCapacityUnits || COLUMN_CAPACITY_UNITS));
  const columns = [];
  let current = { used: 0, blocks: [] };

  const pushColumn = () => {
    columns.push(current);
    current = { used: 0, blocks: [] };
  };

  for (const group of groups) {
    let remaining = [...(group.patients || [])];
    let continuation = false;
    let consumed = 0;

    while (remaining.length) {
      const wholeBlockUnits = ROOM_HEADER_UNITS + remaining.length + ROOM_GAP_UNITS;
      const remainingCapacity = capacity - current.used;

      if (current.blocks.length && wholeBlockUnits <= capacity && wholeBlockUnits > remainingCapacity) {
        pushColumn();
      }

      let patientCapacity = Math.floor(capacity - current.used - ROOM_HEADER_UNITS - ROOM_GAP_UNITS);
      if (patientCapacity < 1) {
        pushColumn();
        patientCapacity = Math.floor(capacity - ROOM_HEADER_UNITS - ROOM_GAP_UNITS);
      }

      const take = Math.max(1, Math.min(remaining.length, patientCapacity));
      const blockPatients = remaining.splice(0, take);
      current.blocks.push({
        room: group.room,
        displayRoom: group.displayRoom,
        continuation,
        totalPatients: group.patients.length,
        startNumber: consumed + 1,
        patients: blockPatients,
      });
      consumed += blockPatients.length;
      current.used += ROOM_HEADER_UNITS + blockPatients.length + ROOM_GAP_UNITS;
      continuation = true;

      if (remaining.length) pushColumn();
    }
  }

  if (current.blocks.length || !columns.length) columns.push(current);

  const pages = [];
  for (let index = 0; index < columns.length; index += columnsPerPage) {
    const pageColumns = columns.slice(index, index + columnsPerPage);
    while (pageColumns.length < columnsPerPage) pageColumns.push({ used: 0, blocks: [] });
    pages.push(pageColumns);
  }
  return pages;
}

function renderBlock(block) {
  const title = `${escapeHtml(block.displayRoom)}${block.continuation ? ' (tiếp)' : ''}`;
  const rows = block.patients.map((patient) => `
    <div class="patient-row">
      <span class="patient-name">${escapeHtml(patient.name || patient.id || 'Chưa có tên')}</span>
    </div>
  `).join('');
  return `
    <section class="room-block">
      <div class="room-title">${title}</div>
      <div class="patient-list">${rows}</div>
    </section>
  `;
}

function renderPrintHtml(groups, pages) {
  const patientCount = groups.reduce((sum, group) => sum + group.patients.length, 0);
  const pageHtml = pages.map((columns) => `
    <section class="print-page">
      <header class="page-header">
        <h1>DANH SÁCH XẾP PHÒNG</h1>
        <div class="summary">Tổng số bệnh nhân: ${patientCount}</div>
      </header>
      <main class="room-columns">
        ${columns.map(column => `<div class="room-column">${column.blocks.map(renderBlock).join('')}</div>`).join('')}
      </main>
    </section>
  `).join('');

  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <title>Danh sách xếp phòng</title>
  <style>
    @page { size: A4 landscape; margin: 10mm; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; font-family: "Aptos", "Segoe UI Variable", "Segoe UI", sans-serif; color: #111; background: #fff; }
    .print-page { min-height: 190mm; display: grid; grid-template-rows: auto 1fr; page-break-after: always; break-after: page; }
    .print-page:last-child { page-break-after: auto; break-after: auto; }
    .page-header { margin-bottom: 5mm; }
    h1 { margin: 0 0 2mm; font-size: 18pt; letter-spacing: .03em; }
    .summary { font-size: 11pt; }
    .room-columns { min-height: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8mm; align-items: start; }
    .room-column { min-width: 0; }
    .room-block { margin: 0 0 5mm; break-inside: avoid; page-break-inside: avoid; }
    .room-title { margin: 0 0 1.5mm; font-size: 14pt; font-weight: 700; }
    .patient-list { display: grid; gap: 1.2mm; }
    .patient-row { font-size: 12pt; line-height: 1.25; }
    .patient-name { display: block; }
    @media screen {
      body { background: #e5e7eb; padding: 12px; }
      .print-page { width: 277mm; min-height: 190mm; margin: 0 auto 12px; padding: 10mm; background: #fff; box-shadow: 0 4px 20px rgba(0,0,0,.12); }
    }
    @media print {
      .print-page { width: auto; min-height: 190mm; }
    }
  </style>
</head>
<body>${pageHtml}</body>
</html>`;
}

export function printRoomAssignment(patients = []) {
  const groups = buildPrintableRoomGroups(patients);
  if (!groups.length) {
    return { ok: false, message: 'Chưa có người bệnh nào được xếp phòng để in.' };
  }

  const pages = paginateRoomGroups(groups);
  const printWindow = window.open('', '_blank', 'width=1280,height=900');
  if (!printWindow) {
    return { ok: false, message: 'Trình duyệt đang chặn cửa sổ in. Hãy cho phép popup rồi thử lại.' };
  }

  try {
    printWindow.opener = null;
    printWindow.document.open();
    printWindow.document.write(renderPrintHtml(groups, pages));
    printWindow.document.close();
    window.setTimeout(() => {
      printWindow.focus();
      printWindow.print();
    }, 250);
    return {
      ok: true,
      message: `Đã mở bản in ${groups.length} phòng, ${groups.reduce((sum, group) => sum + group.patients.length, 0)} người bệnh.`,
    };
  } catch (error) {
    try { printWindow.close(); } catch (_) {}
    return { ok: false, message: `Không tạo được bản in: ${String(error?.message || error)}` };
  }
}
