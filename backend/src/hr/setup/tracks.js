'use strict';

/**
 * tracks.js — the TRACK DESCRIPTORS the setup controller is generic over.
 *
 * A track is "a registry + the probe map that answers it + who may see it". Every
 * piece of arithmetic in setupChecklist.controller.js — the filters, lockedOf /
 * dismissedOf, the prerequisite pass, tally()/scorePercent()'s two clamps,
 * pickNextAction(), the stage roll-up, the completion stamp — is already
 * registry-agnostic, so parameterising it over one of these objects reuses 100% of
 * the probe / percentage / next-action logic with zero duplicated maths. The two
 * tracks therefore cannot drift: there is one implementation of "percent".
 *
 * The step ARRAYS stay in physically separate modules, and that is the point. A
 * hiring step cannot enter the core denominator because it is not in the array the
 * core request iterates — a structural guarantee rather than a `track === 'core'`
 * check somebody has to remember. It is also why there is no `?track=` query
 * parameter: a cached client or a defaulted parameter would silently change which
 * denominator a percentage was computed over.
 *
 * Descriptor fields:
 *   key/title/subtitle/route   what the client renders and where the page lives
 *   registry / probes          the two modules that define the track
 *   permission                 the primary RBAC key, used for wording
 *   anyPermission              THE ROUTE'S GATE, as an OR-list. setupChecklist.routes.js
 *                              builds the middleware from it and the core payload
 *                              serialises it on the pointer, so the card that links to
 *                              a track and the gate that answers it cannot drift — a
 *                              pointer rendered for an operator the route 403s is a
 *                              link into a dead end.
 *   entitlement                an HR add-on key, or null. When set and the plan
 *                              lacks it the controller returns the upsell envelope
 *                              and runs NO probes.
 *   extras(ctx)                optional per-track payload hook. Core passes null;
 *                              talent returns { activation }.
 */

const coreRegistry = require('./checklistItems');
const coreProbes = require('./probes');
const talentRegistry = require('./talent/checklistItems');
const talentProbes = require('./talent/probes');
const { activationFor } = require('./talent/activation');

const CORE = Object.freeze({
  key: 'core',
  title: 'Setup guide',
  subtitle: null,
  route: '/setup',
  registry: coreRegistry,
  probes: coreProbes,
  permission: 'canManageCompanyProfile',
  anyPermission: Object.freeze(['canManageCompanyProfile']),
  entitlement: null,
  extras: null,
});

const TALENT = Object.freeze({
  key: 'talent',
  title: 'Hiring setup',
  subtitle: 'Get your careers page live and taking applications',
  route: '/setup/hiring',
  registry: talentRegistry,
  probes: talentProbes,
  // NOT canManageCompanyProfile: the recruiter persona frequently lacks it, and the
  // hiring track must not inherit the core guide's gate. The OR-list is the same one
  // every recruitment WRITE route enforces (talent/routes/recruitment.routes.js
  // `canManage`), so whoever can do the work can read the guide for it.
  permission: 'canManageHiring',
  anyPermission: Object.freeze(['canManageHiring', 'canManageEmployees']),
  entitlement: 'talent_acquisition',
  extras: activationFor,
});

const TRACKS = Object.freeze({ core: CORE, talent: TALENT });

// Every track except core, in render order — this is what the core payload's
// `tracks` pointer array is built from, so adding a track here is the only edit a
// third track needs on the core side.
const SECONDARY_TRACKS = Object.freeze([TALENT]);

/**
 * findTrackForStep — which track owns this step key?
 *
 * POST /dismiss and /restore receive a bare key, and the four recruitment rows were
 * MOVED (not copied) out of the core registry, so no key exists in two registries
 * and this lookup is unambiguous. It exists so a key posted to the wrong track's
 * endpoint can be diagnosed ("that step belongs to Hiring setup") instead of
 * answering a flat "Unknown setup step".
 */
function findTrackForStep(key) {
  if (!key) return null;
  for (const track of Object.values(TRACKS)) {
    if (track.registry.BY_KEY.has(key)) return track;
  }
  return null;
}

module.exports = { TRACKS, CORE, TALENT, SECONDARY_TRACKS, findTrackForStep };
