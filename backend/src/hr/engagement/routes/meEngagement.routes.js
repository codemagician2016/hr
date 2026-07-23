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
const social = require('../controllers/feedSocial.controller');

router.use(requireCustomer);

// News feed
router.get('/feed', c.feed);
router.get('/feed/unread-count', c.unreadCount);
router.post('/feed/read-all', c.markAllRead);
router.post('/feed/:id/read', c.markRead);

// Feed social layer — reactions + threaded comments (SELF-scope, audience-gated).
// The single-reaction model: PUT upserts/replaces the caller's one reaction.
router.put('/feed/:id/reaction', social.setReaction);
router.delete('/feed/:id/reaction', social.removeReaction);
router.get('/feed/:id/comments', social.listComments);
router.post('/feed/:id/comments', social.createComment);
router.patch('/feed/:id/comments/:commentId', social.editComment);
router.delete('/feed/:id/comments/:commentId', social.deleteComment);

// Celebration feed (birthdays + work anniversaries)
router.get('/celebrations', c.celebrations);
// Self-service celebration opt-out (the privacy control the feed honours). The static
// /preferences paths are declared with their own verbs — no `:id` param route here to
// swallow them, so ordering is unambiguous.
router.get('/celebrations/preferences', c.getCelebrationPreferences);
router.patch('/celebrations/preferences', c.updateCelebrationPreferences);

// Program P1.6 — unified notification preferences (announcements + celebrations).
router.get('/notification-prefs', c.getNotificationPrefs);
router.patch('/notification-prefs', c.updateNotificationPrefs);

module.exports = router;
