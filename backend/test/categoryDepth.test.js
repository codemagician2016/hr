// 3-level category support — unit tests for the depth + cycle helpers
// in src/core/lib/categoryDepth.js. Mocks prisma so this stays a fast
// unit suite (no DB needed). Exercises:
//   - depthOf walks the parent chain correctly
//   - wouldCycle catches both self-parent + descendant-as-parent
//   - descendantIds collects multi-level subtrees
//   - validateDepthAndCycle composes the rules + reports clear reasons

jest.mock('../src/core/lib/prisma', () => ({
  productCategory: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
}));

const prisma = require('../src/core/lib/prisma');
const {
  depthOf, wouldCycle, descendantIds, projectedDepth,
  maxSubtreeDepth, validateDepthAndCycle,
} = require('../src/core/lib/categoryDepth');

// Helper — fixture set: a 3-level tree
//   A (top)
//   ├─ A1 (child of A)
//   │  └─ A1a (sub-child of A)
//   └─ A2 (child of A)
//   B (top, no children)
function tree() {
  return {
    A:    { id: 'A',    parentId: null },
    A1:   { id: 'A1',   parentId: 'A' },
    A1a:  { id: 'A1a',  parentId: 'A1' },
    A2:   { id: 'A2',   parentId: 'A' },
    B:    { id: 'B',    parentId: null },
  };
}

function mountTree(t) {
  prisma.productCategory.findUnique.mockImplementation(({ where }) => {
    return Promise.resolve(t[where.id] || null);
  });
  prisma.productCategory.findMany.mockImplementation(({ where }) => {
    const ids = where.parentId?.in || [];
    const rows = Object.values(t).filter((c) => ids.includes(c.parentId));
    return Promise.resolve(rows.map((c) => ({ id: c.id })));
  });
  prisma.productCategory.findFirst.mockImplementation(({ where }) => {
    // Used only for parent ownership check — always return a hit
    // for ids that exist in the tree.
    return Promise.resolve(t[where.id] ? { id: t[where.id].id } : null);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('depthOf', () => {
  test('null categoryId → depth 1 (treated as top-level slot)', async () => {
    expect(await depthOf(prisma, null)).toBe(1);
  });
  test('top-level node → depth 1', async () => {
    mountTree(tree());
    expect(await depthOf(prisma, 'A')).toBe(1);
    expect(await depthOf(prisma, 'B')).toBe(1);
  });
  test('child of top-level → depth 2', async () => {
    mountTree(tree());
    expect(await depthOf(prisma, 'A1')).toBe(2);
    expect(await depthOf(prisma, 'A2')).toBe(2);
  });
  test('sub-child → depth 3', async () => {
    mountTree(tree());
    expect(await depthOf(prisma, 'A1a')).toBe(3);
  });
});

describe('wouldCycle', () => {
  test('self as parent → cycle', async () => {
    mountTree(tree());
    expect(await wouldCycle(prisma, 'A', 'A')).toBe(true);
  });
  test('unrelated nodes → no cycle', async () => {
    mountTree(tree());
    expect(await wouldCycle(prisma, 'A', 'B')).toBe(false);
    expect(await wouldCycle(prisma, 'B', 'A')).toBe(false);
  });
  test('placing parent under its own descendant → cycle', async () => {
    mountTree(tree());
    // Trying to make A a child of A1 would loop A → A1 → A
    expect(await wouldCycle(prisma, 'A', 'A1')).toBe(true);
    // Trying to make A a child of A1a (deeper) — also a cycle
    expect(await wouldCycle(prisma, 'A', 'A1a')).toBe(true);
  });
  test('placing child under a sibling → no cycle', async () => {
    mountTree(tree());
    // Move A1a to be under A2 (instead of A1) — both are children of A,
    // so no cycle. A2's parent chain doesn't pass through A1a.
    expect(await wouldCycle(prisma, 'A1a', 'A2')).toBe(false);
  });
  test('newParentId null → no cycle (becoming top-level is always safe)', async () => {
    mountTree(tree());
    expect(await wouldCycle(prisma, 'A1a', null)).toBe(false);
  });
});

describe('descendantIds', () => {
  test('leaf returns empty list', async () => {
    mountTree(tree());
    expect(await descendantIds(prisma, 'A1a')).toEqual([]);
    expect(await descendantIds(prisma, 'B')).toEqual([]);
  });
  test('one level of children', async () => {
    mountTree(tree());
    const ids = await descendantIds(prisma, 'A1');
    expect(ids).toEqual(['A1a']);
  });
  test('multi-level subtree includes grandchildren', async () => {
    mountTree(tree());
    const ids = await descendantIds(prisma, 'A');
    expect(ids.sort()).toEqual(['A1', 'A1a', 'A2'].sort());
  });
});

describe('maxSubtreeDepth', () => {
  test('leaf → depth 1', async () => {
    mountTree(tree());
    expect(await maxSubtreeDepth(prisma, 'A1a')).toBe(1);
    expect(await maxSubtreeDepth(prisma, 'B')).toBe(1);
  });
  test('node with one level of children → depth 2', async () => {
    mountTree(tree());
    expect(await maxSubtreeDepth(prisma, 'A1')).toBe(2);
  });
  test('node with two levels of descendants → depth 3', async () => {
    mountTree(tree());
    expect(await maxSubtreeDepth(prisma, 'A')).toBe(3);
  });
});

describe('projectedDepth', () => {
  test('new top-level → 1', async () => {
    mountTree(tree());
    expect(await projectedDepth(prisma, null, null)).toBe(1);
  });
  test('new node under top-level → 2', async () => {
    mountTree(tree());
    expect(await projectedDepth(prisma, null, 'A')).toBe(2);
  });
  test('new node under depth-2 parent → 3', async () => {
    mountTree(tree());
    expect(await projectedDepth(prisma, null, 'A1')).toBe(3);
  });
  test('moving leaf with no descendants — depth = parent depth + 1', async () => {
    mountTree(tree());
    // Move A1a (leaf) under B (top-level) → depth 2
    expect(await projectedDepth(prisma, 'A1a', 'B')).toBe(2);
  });
  test('moving subtree carries its descendants — depth = parent + subtree depth', async () => {
    mountTree(tree());
    // Move A (which has 2 levels below it) to under B → A would be at
    // depth 2, A1 at 3, A1a at 4 → deepest = 4
    expect(await projectedDepth(prisma, 'A', 'B')).toBe(4);
  });
});

describe('validateDepthAndCycle', () => {
  const businessId = 'biz-1';

  test('create top-level always allowed', async () => {
    mountTree(tree());
    const reason = await validateDepthAndCycle(prisma, {
      businessId, categoryId: null, newParentId: null, maxDepth: 2,
    });
    expect(reason).toBeNull();
  });

  test('create at depth 2 with maxDepth 2 → OK', async () => {
    mountTree(tree());
    const reason = await validateDepthAndCycle(prisma, {
      businessId, categoryId: null, newParentId: 'A', maxDepth: 2,
    });
    expect(reason).toBeNull();
  });

  test('create at depth 3 with maxDepth 2 → rejected with clear message', async () => {
    mountTree(tree());
    const reason = await validateDepthAndCycle(prisma, {
      businessId, categoryId: null, newParentId: 'A1', maxDepth: 2,
    });
    expect(reason).toMatch(/nesting limit/i);
    expect(reason).toMatch(/2 level/);
  });

  test('create at depth 3 with maxDepth 3 → OK', async () => {
    mountTree(tree());
    const reason = await validateDepthAndCycle(prisma, {
      businessId, categoryId: null, newParentId: 'A1', maxDepth: 3,
    });
    expect(reason).toBeNull();
  });

  test('parent that does not belong to business → rejected', async () => {
    mountTree(tree());
    // Override findFirst to simulate a foreign parent
    prisma.productCategory.findFirst.mockResolvedValueOnce(null);
    const reason = await validateDepthAndCycle(prisma, {
      businessId, categoryId: null, newParentId: 'A', maxDepth: 3,
    });
    expect(reason).toMatch(/parent.*not found/i);
  });

  test('moving a parent under its own descendant → cycle rejected', async () => {
    mountTree(tree());
    const reason = await validateDepthAndCycle(prisma, {
      businessId, categoryId: 'A', newParentId: 'A1', maxDepth: 5,
    });
    expect(reason).toMatch(/cycle/i);
  });

  test('moving a subtree that would exceed depth → rejected even within maxDepth 3', async () => {
    mountTree(tree());
    // A has subtree depth 3 (A → A1 → A1a). Move A under B: would
    // produce B → A → A1 → A1a = depth 4. With maxDepth 3, reject.
    const reason = await validateDepthAndCycle(prisma, {
      businessId, categoryId: 'A', newParentId: 'B', maxDepth: 3,
    });
    expect(reason).toMatch(/nesting limit/i);
  });

  test('moving a leaf within depth budget → OK', async () => {
    mountTree(tree());
    // Move A1a (leaf) to be a child of B → depth 2, well under 3
    const reason = await validateDepthAndCycle(prisma, {
      businessId, categoryId: 'A1a', newParentId: 'B', maxDepth: 3,
    });
    expect(reason).toBeNull();
  });
});
