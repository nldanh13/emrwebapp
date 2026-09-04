// server/routes/activity_log.js — Nhận log thao tác từ giao diện

'use strict';

const router = require('express').Router();
const { logClientEvents } = require('../services/activity_logger');

router.post('/client-log', (req, res) => {
  try {
    const events = Array.isArray(req.body?.events) ? req.body.events : req.body?.event;
    const result = logClientEvents(req, events || []);
    return res.json({ status: 'ok', ...result });
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      message: String(err.message || err),
    });
  }
});

module.exports = router;
