// Tests for the rich /health endpoint logic. Mocks Prisma so we don't
// hit a real DB.

jest.mock('../src/core/lib/prisma', () => ({
  $queryRaw: jest.fn(),
}));

const prisma = require('../src/core/lib/prisma');
const health = require('../src/core/lib/health');

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  prisma.$queryRaw.mockReset();
});

afterAll(() => {
  Object.assign(process.env, ORIGINAL_ENV);
});

describe('dbCheck', () => {
  test('returns ok=true when SELECT 1 succeeds', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
    const r = await health.dbCheck();
    expect(r.ok).toBe(true);
    expect(typeof r.latencyMs).toBe('number');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('returns ok=false on DB error', async () => {
    prisma.$queryRaw.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const r = await health.dbCheck();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
  });

  test('times out after 1.5s if query hangs', async () => {
    prisma.$queryRaw.mockReturnValueOnce(new Promise(() => {})); // never resolves
    const r = await health.dbCheck();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout/i);
  }, 3000);
});

describe('migrationCheck', () => {
  test('returns latest migration name + applied time', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{
      migration_name: '20260428000100_add_custom_domain_status',
      finished_at: new Date('2026-04-28T12:00:00Z'),
    }]);
    const r = await health.migrationCheck();
    expect(r.ok).toBe(true);
    expect(r.latestMigration).toMatch(/add_custom_domain_status/);
  });

  test('reports error when no migrations applied', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]);
    const r = await health.migrationCheck();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No migrations applied/);
  });

  test('reports error when _prisma_migrations table missing', async () => {
    prisma.$queryRaw.mockRejectedValueOnce(new Error('relation "_prisma_migrations" does not exist'));
    const r = await health.migrationCheck();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/_prisma_migrations/);
  });
});

describe('processInfo', () => {
  test('returns node version + uptime + memory', () => {
    const p = health.processInfo();
    expect(p.nodeVersion).toMatch(/^v\d+/);
    expect(typeof p.uptimeSec).toBe('number');
    expect(typeof p.uptimeHuman).toBe('string');
    expect(typeof p.memory.rssMb).toBe('number');
    expect(p.memory.rssMb).toBeGreaterThan(0);
    expect(typeof p.pid).toBe('number');
  });
});

describe('envSummary', () => {
  test('reports NODE_ENV + has flags without leaking secrets', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://user:secret@host/db';
    process.env.JWT_SECRET = 'super-secret';
    delete process.env.MSG91_API_KEY;
    const e = health.envSummary();
    expect(e.nodeEnv).toBe('production');
    expect(e.has.DATABASE_URL).toBe(true);
    expect(e.has.JWT_SECRET).toBe(true);
    expect(e.has.MSG91_API_KEY).toBe(false);
    // Values must not leak
    expect(JSON.stringify(e)).not.toContain('secret');
    expect(JSON.stringify(e)).not.toContain('postgresql://');
  });
});

describe('runHealthCheck', () => {
  test('detailed=true returns full body incl. process + env', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ '?column?': 1 }]) // dbCheck
      .mockResolvedValueOnce([{ migration_name: 'm1', finished_at: new Date() }]); // migrationCheck
    const r = await health.runHealthCheck({ detailed: true });
    expect(r.status).toBe('ok');
    expect(r.checks.db.ok).toBe(true);
    expect(r.checks.migration.ok).toBe(true);
    expect(r.timestamp).toBeTruthy();
    expect(r.process.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(r.env).toBeTruthy();
    expect(r.env.has).toBeTruthy();
  });

  test('default (undetailed) response withholds env + process (info-disclosure guard)', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ '?column?': 1 }]) // dbCheck
      .mockResolvedValueOnce([{ migration_name: 'm1', finished_at: new Date() }]); // migrationCheck
    const r = await health.runHealthCheck();
    expect(r.status).toBe('ok');
    expect(r.checks.db.ok).toBe(true);
    expect(r.checks.migration.ok).toBe(true);
    // No provider inventory, schema version, PID or Node version for anon callers.
    expect(r.env).toBeUndefined();
    expect(r.process).toBeUndefined();
    expect(r.checks.migration.name).toBeUndefined();
  });

  test('returns degraded status when DB is down', async () => {
    prisma.$queryRaw
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) // dbCheck
      .mockRejectedValueOnce(new Error('ECONNREFUSED')); // migrationCheck
    const r = await health.runHealthCheck();
    expect(r.status).toBe('degraded');
    expect(r.checks.db.ok).toBe(false);
  });

  test('migration check failure alone does NOT degrade overall status', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ '?column?': 1 }]) // db ok
      .mockRejectedValueOnce(new Error('migration table missing')); // migration fail
    const r = await health.runHealthCheck();
    expect(r.status).toBe('ok'); // DB is up — that's all that matters for HTTP 200
    expect(r.checks.migration.ok).toBe(false);
  });
});
