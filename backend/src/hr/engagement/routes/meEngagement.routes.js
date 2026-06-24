'use strict';

/**
 * meEngagement.routes.js — ESS engagement surface (news feed + celebrations),
 * mounted at /api/hr/me/engagement. CUSTOMER session; SELF-ONLY (the subject is
 * resolved from the session inside the controller, never from the client).
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../../core/middleware/auth.middleware');
const c = require('../controllers/meEngagement.controller');

router.use(requireCustomer);

// News feed
router.get('/feed', c.feed);
router.get('/feed/unread-count', c.unreadCount);
router.post('/feed/read-all', c.markAllRead);
router.post('/feed/:id/read', c.markRead);

// Celebration feed (birthdays + work anniversaries)
router.get('/celebrations', c.celebrations);

module.exports = router;
