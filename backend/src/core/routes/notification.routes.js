const express = require('express');
const router = express.Router();
const { requireAuth, requireSuperAdmin } = require('../../core/middleware/auth.middleware');
const { getActive, listAll, create, update, remove } = require('../controllers/notification.controller');

// Public — anyone can fetch active banners (called by frontends on page load)
router.get('/active', getActive);

// Admin only — manage banners
router.get('/', requireAuth, requireSuperAdmin, listAll);
router.post('/', requireAuth, requireSuperAdmin, create);
router.put('/:id', requireAuth, requireSuperAdmin, update);
router.delete('/:id', requireAuth, requireSuperAdmin, remove);

module.exports = router;
