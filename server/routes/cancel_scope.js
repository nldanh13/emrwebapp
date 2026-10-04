'use strict';

// /api/cancel trước đây chỉ huỷ theo x-session-id của request hiện tại. Trong Kho
// nghiên cứu, banner /research/running là trạng thái toàn server nên sau reload,
// tab khác hoặc máy khác, session bấm Dừng có thể không phải session đã khởi chạy
// worker. Route này giữ tương thích cho mọi chức năng cũ, đồng thời fallback sang
// session sở hữu research scope đang chạy.

const router = require('express').Router();
const { getRuntimePaths } = require('../services/session');
const { cancelSession } = require('../services/task_queue');
const { RESEARCH_SCOPE_LOCKS } = require('../research/research_http');

function cleanScopeKey(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  if (key === 'archive') return key;
  if (/^study:[A-Za-z0-9._-]{1,120}$/.test(key)) return key;
  return '';
}

function researchOwnerForCancel(scopeKey, currentSid) {
  if (scopeKey) {
    const holder = RESEARCH_SCOPE_LOCKS.get(scopeKey);
    return holder?.sid ? { scopeKey, holder } : null;
  }

  const running = [...RESEARCH_SCOPE_LOCKS.entries()]
    .filter(([, holder]) => String(holder?.sid || '').trim())
    .map(([key, holder]) => ({ scopeKey: key, holder }));

  // Nếu đúng session hiện tại có duy nhất một research lock thì chọn nó trước.
  const sameOwner = running.filter(x => x.holder.sid === currentSid);
  if (sameOwner.length === 1) return sameOwner[0];

  // Trường hợp thường gặp sau reload/tab mới: chỉ có một tác vụ nghiên cứu đang chạy.
  if (running.length === 1) return running[0];
  return null;
}

router.post('/cancel', (req, res) => {
  const ctx = getRuntimePaths(req);
  const requestedScope = cleanScopeKey(req.body?.scope_key || req.body?.scopeKey);

  // Khi caller chỉ rõ scope, ưu tiên chính xác research job đó thay vì vô tình huỷ
  // một tác vụ khác cùng session.
  if (requestedScope) {
    const target = researchOwnerForCancel(requestedScope, ctx.sid);
    const cancelled = target ? cancelSession(target.holder.sid) : false;
    return res.json({
      status: 'ok',
      cancelled,
      scope_key: requestedScope,
      message: cancelled
        ? 'Đã gửi lệnh dừng tác vụ nghiên cứu.'
        : 'Không tìm thấy worker đang chạy của phạm vi này.',
    });
  }

  // Tương thích các nút Dừng cũ: trước hết huỷ task của chính session hiện tại.
  if (cancelSession(ctx.sid)) {
    return res.json({ status: 'ok', cancelled: true, message: 'Đã gửi lệnh huỷ.' });
  }

  // Nếu banner nghiên cứu được mở từ session khác, tìm session sở hữu lock.
  const target = researchOwnerForCancel('', ctx.sid);
  if (target && cancelSession(target.holder.sid)) {
    return res.json({
      status: 'ok',
      cancelled: true,
      scope_key: target.scopeKey,
      message: 'Đã gửi lệnh dừng đúng tác vụ nghiên cứu đang chạy.',
    });
  }

  const runningResearch = [...RESEARCH_SCOPE_LOCKS.values()].filter(x => x?.sid).length;
  return res.json({
    status: 'ok',
    cancelled: false,
    message: runningResearch > 1
      ? 'Có nhiều tác vụ nghiên cứu đang chạy; cần dừng theo đúng phạm vi.'
      : 'Không có tác vụ đang chạy có thể huỷ.',
  });
});

module.exports = router;
