'use strict';

/**
 * meNotifications.routes.js — ESS notification inbox, mounted at
 * /api/hr/me/notifications. CUSTOMER session; SELF-ONLY (the recipient User is
 * resolved from the session inside the controller, never from the client). Static
 * /unread-count + /read-all are declared with their own verbs; /:id/read carries the
 * only param and cannot swallow them (distinct path shapes).
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../../core/middleware/auth.middleware');
const c = require('../controllers/meNotifications.controller');

router.use(requireCustomer);

router.get('/', c.list);
router.get('/unread-count', c.unreadCount);
router.post('/read-all', c.markAllRead);
router.post('/:id/read', c.markRead);

module.exports = router;
