// server/routes/index.js — Gắn tất cả routes vào /api

'use strict';

const router = require('express').Router();
const { heavyTaskLimiter, readWriteLimiter, researchReadLimiter, clientLogLimiter } = require('../middleware/rate_limit');
const { requestAuditMiddleware } = require('../services/activity_logger');
const { featureGate } = require('../middleware/feature_gate');

// Endpoint kích hoạt Python process — giới hạn 5 lần/phút/session
const HEAVY_TASK_ROUTES = [
  '/hchanh/fetch',
  '/hchanh/records-check/scan-completed',
  '/hchanh/rescan',
  '/hchanh/print-billing',
  '/hchanh/print-discharge-bundle',
  '/run-scan',
  '/run-details',
  '/run-details-one',
  '/run-postprocess',
  '/check-input-changes',
  '/run-input-care',
  '/run-input-infusions',
  '/run-input-procedures',
  '/run-input-vtyt',
  '/check-current-bed',
  '/admin-workflow/snapshot/morning',
  '/admin-workflow/snapshot/afternoon',
  '/admin-workflow/diff',
  '/admin-workflow/discharge-qa',
  '/admin-workflow/ticket',
  '/admin-workflow/ticket/:ticketId',
  '/admin-workflow/rescan',
  '/admin-workflow/print-pack',
  '/admin-workflow/clear',
  '/clinic/preview',
  '/clinic/care-preview',
  '/clinic/care-order-seeds',
  '/clinic/input-care',
  '/clinic/input-procedures',
  '/research/archive/run',
  '/research/archive/patient-info',
  '/research/archive/fetch-hchanh',
  '/research/archive/fetch-order-history',
  '/research/archive/normalize',
  '/research/archive/finalize-dataset',
  '/research/archive/build-encoded-dataset',
  '/research/refetch-missing',
  '/research/studies/:studyId/patient-info',
  '/research/studies/:studyId/fetch-hchanh',
  '/research/studies/:studyId/fetch-order-history',
  '/research/studies/:studyId/import-from-archive',
  '/research/studies/:studyId/normalize',
  '/research/studies/:studyId/finalize-dataset',
  '/research/studies/:studyId/build-encoded-dataset',
  '/care-baseline/run',
  '/run-report-infusion',
  '/workflows/:workflowId/run',
];
router.use(HEAVY_TASK_ROUTES, heavyTaskLimiter);

// Research có auto-poll tiến độ và nhiều API đọc nhỏ; dùng limiter riêng cao hơn.
// Các route chạy Python/ghi dữ liệu nặng vẫn đã bị chặn bởi heavyTaskLimiter ở trên.
router.use('/research', researchReadLimiter);

// Endpoint đọc/ghi nhẹ — giới hạn 60 lần/phút/session
router.use(['/data', '/save', '/get-raw', '/get-patients', '/has-processed', '/data-info', '/nurse-settings', '/admin-nurse-state', '/admin-workflow', '/export-data', '/import-data', '/cancel', '/session-logs', '/data-sessions', '/hchanh', '/features', '/workflows', '/artifacts', '/care-baseline', '/report-token', '/clinic/care-draft'], readWriteLimiter);
router.use('/client-log', clientLogLimiter);
// Health/diagnostics nhẹ — vẫn yêu cầu token nếu EMR_APP_TOKEN được bật.
router.use(['/health', '/diagnostics'], readWriteLimiter);

// Ghi log mọi API sau khi qua giới hạn tần suất.
router.use(requestAuditMiddleware);

// Gate dùng registry hiệu lực: chỉ route thuộc module bị tắt mới bị skip.
router.use(featureGate);

router.use(require('./health'));
router.use(require('./features'));
router.use(require('./workflows'));
router.use(require('./activity_log'));
router.use(require('./scan'));
router.use(require('./board'));
router.use(require('./details'));
router.use(require('./patients'));
router.use(require('./nurse'));
router.use(require('./admin_nurse'));
router.use(require('./admin_workflow'));
router.use(require('./clinic'));
router.use(require('./hchanh'));
router.use(require('./vtyt_catalog'));
router.use(require('./research'));
router.use(require('./report'));
router.use(require('./care_baseline'));
router.use(require('./data_transfer'));

module.exports = router;
