// Public unsubscribe routes (no auth — recipients click from email).
'use strict';

const express = require('express');
const { getPage, confirm } = require('../controllers/unsubscribe.controller');

const router = express.Router();
router.get('/', getPage);
router.post('/', confirm);

module.exports = router;
