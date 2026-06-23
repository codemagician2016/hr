'use strict';

/**
 * meTasks.routes.js — Employee Self-Service (ESS) "pending tasks" feed, mounted at
 * /api/hr/me/tasks. CUSTOMER session (req.customer); SELF_ONLY — the feed is the
 * caller's own outstanding self-service actions, resolved from the session inside
 * the controller (no id is accepted from the client).
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/meTasks.controller');

router.use(requireCustomer);

router.get('/', c.listMyTasks);

module.exports = router;
