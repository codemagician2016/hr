const {
  buildCalendarFeedLinks,
  listInboxNotificationsForRequest,
  markAllInboxNotificationsReadForRequest,
  markInboxNotificationReadForRequest,
} = require('../lib/inbox');

async function list(req, res) {
  const unreadOnly = String(req.query.filter || '').trim().toLowerCase() === 'unread';
  const limit = req.query.limit;
  const payload = await listInboxNotificationsForRequest(req, { unreadOnly, limit });
  res.json(payload);
}

async function markRead(req, res) {
  const notification = await markInboxNotificationReadForRequest(req, req.params.id);
  if (!notification) return res.status(404).json({ message: 'Notification not found' });
  res.json({ notification });
}

async function markAllRead(req, res) {
  const count = await markAllInboxNotificationsReadForRequest(req);
  res.json({ count });
}

async function calendarFeed(req, res) {
  const links = await buildCalendarFeedLinks(req);
  res.json({ links });
}

module.exports = {
  calendarFeed,
  list,
  markAllRead,
  markRead,
};
