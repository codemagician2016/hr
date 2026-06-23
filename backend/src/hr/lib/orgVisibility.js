'use strict';

/**
 * orgVisibility.js — Feature 19 §3.3. A tiny code map governing how far an ESS
 * (customer) user may TRAVERSE the org chart. Operators are governed purely by the
 * F1 band; this layers ONLY on the ESS surface.
 *
 * Default (safe): an employee can see the ancestor chain to the top and the
 * tenant root(s) as read-only CARDS (the same directory fields F13 already exposes
 * tenant-wide — name/photo/designation/department, never compensation), but cannot
 * DRILL into sub-trees outside their own (lateralDepth: 0 ⇒ peers/ancestors are
 * `expandable:false`). Inside their OWN sub-tree they expand freely to the leaves.
 *
 * A tenant wanting a fully-open directory flips lateralDepth to Infinity (flag).
 * The per-tenant override UI is deferred (roadmap); for now this is the one default.
 */

const DEFAULT_ESS_ORG_POLICY = Object.freeze({
  canSeeAncestorsToTop: true, // breadcrumb CEO → … → me (read-only cards)
  canSeeTop: true,            // "Go to top" → browse down from the root(s), card-only
  lateralDepth: 0,            // peers / cousins shown as cards but NOT expandable
  showInactive: false,        // ESS hides TERMINATED/PRE_HIRE; admin shows them dimmed
});

// Resolve the effective policy for a tenant. v1: always the default (override is a
// future flag). Kept as a function so the override hook is a one-line change later.
function essOrgPolicy(/* businessId */) {
  return DEFAULT_ESS_ORG_POLICY;
}

// Statuses an ESS user may see when showInactive is false.
const ESS_ACTIVE_STATUSES = new Set(['ACTIVE', 'ON_LEAVE', 'PROBATION', 'NOTICE_PERIOD', 'SUSPENDED']);
// (PRE_HIRE / TERMINATED / RETIRED are hidden from ESS by default.)

function isEssVisibleStatus(status, policy) {
  if (policy.showInactive) return true;
  return ESS_ACTIVE_STATUSES.has(status);
}

// Given a node and the actor's in-scope id-set, decide whether the node is DRILLABLE
// (its children may be lazy-loaded). A node is expandable iff it is inside the actor's
// own reporting sub-tree (scopeIds) OR the tenant opens lateral drilling
// (lateralDepth === Infinity). Ancestors/peers outside the sub-tree → card-only.
function isExpandable(nodeId, scopeIds, policy) {
  if (policy.lateralDepth === Infinity) return true;
  if (!scopeIds) return true; // ALL-band ESS (rare) → everything drillable
  return scopeIds.has(nodeId);
}

// Annotate a node array with `expandable` per policy + drop hasChildren affordance on
// non-expandable cards (reportsCount stays informative). Mutates copies (returns new).
function annotateExpandable(nodes, scopeIds, policy) {
  return nodes.map((n) => ({
    ...n,
    expandable: isExpandable(n.id, scopeIds, policy),
  }));
}

module.exports = {
  DEFAULT_ESS_ORG_POLICY,
  essOrgPolicy,
  isEssVisibleStatus,
  isExpandable,
  annotateExpandable,
  ESS_ACTIVE_STATUSES,
};
