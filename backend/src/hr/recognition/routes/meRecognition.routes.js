'use strict';

/**
 * meRecognition.routes.js — Feature 35 ESS surface, mounted at /api/hr/me (spec §5
 * path shapes: /me/recognitions, /me/wallet, /me/award-cycles, /me/award-nominations,
 * /me/catalog, /me/redemptions, /me/recognition/leaderboard). CUSTOMER session;
 * SELF-ONLY (subject resolved from the session inside the controller — never from
 * the client). No permission key — these are self-scope rights for every active
 * employee, exactly like /me/engagement. Paths here don't overlap any other /me/*
 * mount, so aggregator ordering is not load-bearing.
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../../core/middleware/auth.middleware');
const c = require('../controllers/meRecognition.controller');

router.use(requireCustomer);

// Peer recognition (give + my given/received)
router.post('/recognitions', c.giveRecognition);
router.get('/recognitions', c.listRecognitions);

// Wallet
router.get('/wallet', c.wallet);
router.get('/wallet/ledger', c.walletLedger);

// Awards (nominate + track)
router.get('/award-cycles', c.openAwardCycles);
router.post('/award-nominations', c.nominate);
router.get('/award-nominations', c.myNominations);

// Catalog + redemptions
router.get('/catalog', c.catalog);
router.post('/redemptions', c.redeem);
router.get('/redemptions', c.myRedemptions);
router.post('/redemptions/:id/cancel', c.cancelRedemption);

// The wall leaderboard (read)
router.get('/recognition/values', c.giveOptions);
router.get('/recognition/leaderboard', c.essLeaderboard);

module.exports = router;
