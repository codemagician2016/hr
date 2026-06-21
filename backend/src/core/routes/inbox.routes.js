const express = require('express');
const router = express.Router();
const { customerOrUser } = require('../../core/middleware/customerOrUser.middleware');
const { calendarFeed, list, markAllRead, markRead } = require('../controllers/inbox.controller');

router.use(customerOrUser);

router.get('/', list);
router.get('/calendar-feed', calendarFeed);
router.post('/read-all', markAllRead);
router.post('/:id/read', markRead);

module.exports = router;
