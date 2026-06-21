const express = require('express');
const router = express.Router();
const { requireAuth, requireBusinessAdmin } = require('../../core/middleware/auth.middleware');
const { listConnections, connectService, disconnectService, testConnection, registerWebhook, callConnection, ssoConnection } = require('../controllers/integrations.controller');

// (The inbound webhook POST /api/integrations/:id/webhook is mounted in index.js
//  BEFORE express.json so the HMAC can be verified over the raw body.)
router.use(requireAuth);

router.get('/', requireBusinessAdmin, listConnections);
router.post('/', requireBusinessAdmin, connectService);
router.delete('/:id', requireBusinessAdmin, disconnectService);
router.post('/:id/test', requireBusinessAdmin, testConnection);
router.post('/:id/register-webhook', requireBusinessAdmin, registerWebhook);
router.post('/:category/call', requireBusinessAdmin, callConnection);
router.post('/:category/sso', requireBusinessAdmin, ssoConnection);

module.exports = router;
