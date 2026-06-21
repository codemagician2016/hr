const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { requireAuth, requireStaff } = require('../middleware/auth.middleware');
const { customerOrUserOptional } = require('../middleware/customerOrUser.middleware');
const support = require('../controllers/support.controller');
const aapkaChatActions = require('../controllers/aapkaChatActions.controller');
const aapkaChatGateway = require('../controllers/aapkaChatGateway.controller');

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// Project-level API for reusable chat clients.
router.get('/widget.js', (_req, res) => {
  const widgetPath = path.resolve(__dirname, '../../../../packages/chat-v2-widget/index.js');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.send(fs.readFileSync(widgetPath, 'utf8'));
});

router.get('/tenant/platform', requireAuth, requireStaff, wrap(support.listPlatformForTenant));
router.post('/tenant/platform', requireAuth, requireStaff, wrap(support.createPlatformForTenant));
router.post('/tenant/platform/:id/messages', requireAuth, requireStaff, wrap(support.replyPlatformForTenant));

router.get('/actions/catalog', requireAuth, requireStaff, wrap(aapkaChatActions.catalog));
router.post('/actions/preview', requireAuth, requireStaff, wrap(aapkaChatActions.preview));
router.post('/actions/commit', requireAuth, requireStaff, wrap(aapkaChatActions.commit));

router.get('/aapkachat/v1/widget/bootstrap', wrap(aapkaChatGateway.bootstrap));
router.get('/aapkachat/v1/integrations/sitepresso', wrap(aapkaChatGateway.manifest));
router.post('/aapkachat/v1/integrations/sitepresso/register', requireAuth, requireStaff, wrap(aapkaChatGateway.register));
router.get('/aapkachat/v1/actions/catalog', requireAuth, requireStaff, wrap(aapkaChatActions.catalog));
router.post('/aapkachat/v1/actions/preview', requireAuth, requireStaff, wrap(aapkaChatActions.preview));
router.post('/aapkachat/v1/actions/commit', requireAuth, requireStaff, wrap(aapkaChatActions.commit));
router.post('/aapkachat/v1/ai/answer', wrap(aapkaChatGateway.answerKnowledge));
router.post('/aapkachat/v1/support/self-help/answer', wrap(aapkaChatGateway.answerSelfHelp));
router.post('/aapkachat/v1/support/conversations', customerOrUserOptional, wrap(aapkaChatGateway.createSupportConversation));

router.get('/tenant/customer', requireAuth, requireStaff, wrap(support.listCustomerForTenant));
router.post('/tenant/customer/:id/messages', requireAuth, requireStaff, wrap(support.replyCustomerForTenant));
router.post('/tenant/customer/:id/close', requireAuth, requireStaff, wrap(support.closeCustomerForTenant));

router.get('/public/:projectKey/:slug/self-help', wrap(support.getPublicSelfHelp));
router.post('/public/:projectKey/:slug/self-help/answer', wrap(support.answerPublicSelfHelp));
router.post('/public/:projectKey/:slug/conversations', customerOrUserOptional, wrap(support.createPublicCustomerConversation));
router.get('/public/conversations/:id', customerOrUserOptional, wrap(support.getPublicCustomerConversation));
router.get('/public/conversations/:id/stream', wrap(support.streamPublicCustomerConversation));
router.post('/public/conversations/:id/messages', customerOrUserOptional, wrap(support.replyPublicCustomerConversation));

module.exports = router;
