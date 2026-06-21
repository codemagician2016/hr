// Public webhook endpoints for SMS / WhatsApp providers.
// Mounted at /api/notifications/webhook (no auth — providers call us).
//
// Production: Verify X-Twilio-Signature header before trusting the body.
// We accept urlencoded bodies (Twilio default) and JSON (MSG91).
'use strict';

const express = require('express');
const {
  twilioInbound,
  twilioStatus,
  msg91Inbound,
  msg91Status,
} = require('../controllers/notificationWebhook.controller');

const router = express.Router();

// Twilio sends form-urlencoded by default
router.post('/twilio/inbound', express.urlencoded({ extended: true }), twilioInbound);
router.post('/twilio/status',  express.urlencoded({ extended: true }), twilioStatus);

// MSG91 sends JSON
router.post('/msg91/inbound', express.json(), msg91Inbound);
router.post('/msg91/status',  express.json(), msg91Status);

module.exports = router;
