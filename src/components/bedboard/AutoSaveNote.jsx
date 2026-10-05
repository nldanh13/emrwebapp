import { C, FS } from '../../tokens.js';

// Trạng thái tự lưu xếp phòng (hiện cạnh nút Lưu).
export function AutoSaveNote({ autoSave }) {
  const st = autoSave?.state;
  if (!st || st === 'idle') return null;
  const [text, color] = st === 'pending' ? ['Có thay đổi, đang chờ tự lưu…', C.text3]
    : st === 'saving' ? ['Đang tự lưu…', C.text3]
    : st === 'error' ? ['Chưa lưu được — bấm Lưu xếp phòng', C.red]
    : [`Đã tự lưu lúc ${autoSave.at}`, C.green];
  return <span role="status" style={{ fontSize: FS.xs, color, whiteSpace: 'nowrap' }}>{text}</span>;
}
