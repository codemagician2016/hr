'use strict';

// Category-tree depth + cycle helpers used by createCategory /
// updateCategory in the product controller. Encapsulates the
// "Business.categoryMaxDepth" rule so the controller doesn't grow a
// thicket of recursive parent-walk loops.
//
// Vocabulary:
//   - depth 1 = top-level category (parentId = null)
//   - depth 2 = child of a top-level (current default behaviour)
//   - depth 3 = sub-child (the new 3-level feature)
//
// All functions assume the caller has already verified businessId
// ownership of `categoryId` / `parentId`. Cycle protection is double-
// belt-and-braces: in addition to "would-cycle?" pre-checks, every
// recursive walk has a hard guard at MAX_WALK to prevent infinite
// loops on malformed data (orphaned parentId, etc.).

const MAX_WALK = 32; // hard ceiling — way above any realistic depth

// Walk up the parent chain for a category. Returns the depth of that
// category (1 = top-level). Stops when parentId is null OR we've walked
// MAX_WALK times (defence against malformed data, never expected to hit).
async function depthOf(prisma, categoryId) {
  if (!categoryId) return 1;
  let id = categoryId;
  let depth = 1;
  for (let i = 0; i < MAX_WALK; i += 1) {
    const cat = await prisma.productCategory.findUnique({
      where: { id },
      select: { parentId: true },
    });
    if (!cat || !cat.parentId) return depth;
    depth += 1;
    id = cat.parentId;
  }
  // Hit the safety ceiling — return MAX_WALK so a downstream depth check
  // will reject the operation rather than silently truncating.
  return MAX_WALK;
}

// Would setting `categoryId.parentId = newParentId` create a cycle?
// True if newParentId is a descendant of categoryId (or === categoryId).
async function wouldCycle(prisma, categoryId, newParentId) {
  if (!newParentId) return false;
  if (newParentId === categoryId) return true;
  // Walk up from newParentId; if we hit categoryId, it's a cycle.
  let id = newParentId;
  for (let i = 0; i < MAX_WALK; i += 1) {
    if (id === categoryId) return true;
    const cat = await prisma.productCategory.findUnique({
      where: { id },
      select: { parentId: true },
    });
    if (!cat) return false; // dangling parent — not our cycle, controller will reject separately
    if (!cat.parentId) return false;
    id = cat.parentId;
  }
  return true; // safety: assume cycle if we ran out of walk budget
}

// Resolve the maximum depth a NEW or moved category would occupy if it
// were placed under newParentId. For a top-level (newParentId = null),
// this is 1; for a child of a top-level, 2; etc. This includes any
// existing sub-tree under categoryId — moving a node carries its
// descendants along, and the deepest descendant might exceed the cap
// even if the node itself is shallow.
async function projectedDepth(prisma, categoryId, newParentId) {
  // Depth at the new position
  const baseDepth = newParentId ? (await depthOf(prisma, newParentId)) + 1 : 1;
  if (!categoryId) return baseDepth; // brand-new category, no descendants
  // How deep does this subtree go below categoryId today?
  const subtreeDepth = await maxSubtreeDepth(prisma, categoryId);
  return baseDepth + subtreeDepth - 1; // -1 because subtreeDepth counts the node itself
}

// Depth of the deepest leaf below categoryId (categoryId itself = 1).
// Iterative BFS so we never blow the stack.
async function maxSubtreeDepth(prisma, categoryId) {
  let level = [categoryId];
  let depth = 1;
  for (let i = 0; i < MAX_WALK && level.length > 0; i += 1) {
    const children = await prisma.productCategory.findMany({
      where: { parentId: { in: level } },
      select: { id: true },
    });
    if (children.length === 0) return depth;
    level = children.map((c) => c.id);
    depth += 1;
  }
  return depth;
}

// All descendant ids of a category (excluding the category itself).
// Used by the storefront to expand `?categorySlug=X` into "products
// in X or any of its sub-categories" when ECOMMERCE Path B / 3-level
// is enabled. Iterative BFS — typical grocery subtree is shallow,
// but we cap at MAX_WALK levels just in case.
async function descendantIds(prisma, categoryId) {
  if (!categoryId) return [];
  const out = [];
  let level = [categoryId];
  for (let i = 0; i < MAX_WALK && level.length > 0; i += 1) {
    const children = await prisma.productCategory.findMany({
      where: { parentId: { in: level } },
      select: { id: true },
    });
    if (children.length === 0) break;
    const ids = children.map((c) => c.id);
    out.push(...ids);
    level = ids;
  }
  return out;
}

// Master pre-flight check used by both create + update. Returns a
// rejection reason string if the operation would violate depth or
// cycle constraints; null if the operation is allowed.
//
// Pass `categoryId = null` for create (no existing node, no subtree).
async function validateDepthAndCycle(prisma, {
  businessId, categoryId, newParentId, maxDepth,
}) {
  // 1. cycle protection (only for moves of an existing category)
  if (categoryId && newParentId && await wouldCycle(prisma, categoryId, newParentId)) {
    return 'A category cannot be its own ancestor (would create a cycle)';
  }
  // 2. parent ownership — must belong to the same business
  if (newParentId) {
    const parent = await prisma.productCategory.findFirst({
      where: { id: newParentId, businessId },
      select: { id: true },
    });
    if (!parent) return 'Parent category not found';
  }
  // 3. depth check — projected depth must not exceed maxDepth
  const projected = await projectedDepth(prisma, categoryId, newParentId);
  if (projected > maxDepth) {
    return `Category nesting limit reached — your plan supports up to ${maxDepth} level${maxDepth === 1 ? '' : 's'}`;
  }
  return null;
}

module.exports = {
  depthOf,
  wouldCycle,
  projectedDepth,
  maxSubtreeDepth,
  descendantIds,
  validateDepthAndCycle,
  MAX_WALK,
};
