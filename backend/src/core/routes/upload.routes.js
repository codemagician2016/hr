const express = require('express');
const router = express.Router();
const { protect } = require('../../core/middleware/auth.middleware');
const { uploadImage, proxyImage } = require('../controllers/upload.controller');

router.post('/image', protect, uploadImage);
router.get('/proxy', protect, proxyImage);

module.exports = router;
