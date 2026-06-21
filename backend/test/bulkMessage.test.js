// Tests for the bulk-message Zod schema. Pure shape rules; the
// controller integration is DB-bound and lives outside Jest.

const { bulkMessageSchema } = require('../src/core/lib/schemas/bulkMessage.schema');

describe('bulkMessageSchema', () => {
  const valid = { ids: ['a1', 'a2'], subject: 'Hi', body: 'Test message body' };

  test('accepts a well-formed payload', () => {
    expect(bulkMessageSchema.safeParse(valid).success).toBe(true);
  });

  test('rejects empty ids array', () => {
    expect(bulkMessageSchema.safeParse({ ...valid, ids: [] }).success).toBe(false);
  });

  test('rejects ids array containing empty strings', () => {
    expect(bulkMessageSchema.safeParse({ ...valid, ids: ['a1', ''] }).success).toBe(false);
  });

  test('rejects more than 200 ids (rate-limit safety)', () => {
    const too_many = Array.from({ length: 201 }, (_, i) => `a${i}`);
    expect(bulkMessageSchema.safeParse({ ...valid, ids: too_many }).success).toBe(false);
  });

  test('accepts exactly 200 ids', () => {
    const ok = Array.from({ length: 200 }, (_, i) => `a${i}`);
    expect(bulkMessageSchema.safeParse({ ...valid, ids: ok }).success).toBe(true);
  });

  test('requires subject', () => {
    expect(bulkMessageSchema.safeParse({ ...valid, subject: '' }).success).toBe(false);
    expect(bulkMessageSchema.safeParse({ ...valid, subject: '   ' }).success).toBe(false);
  });

  test('caps subject at 200 chars', () => {
    expect(bulkMessageSchema.safeParse({ ...valid, subject: 'x'.repeat(201) }).success).toBe(false);
    expect(bulkMessageSchema.safeParse({ ...valid, subject: 'x'.repeat(200) }).success).toBe(true);
  });

  test('requires body', () => {
    expect(bulkMessageSchema.safeParse({ ...valid, body: '' }).success).toBe(false);
  });

  test('caps body at 4000 chars', () => {
    expect(bulkMessageSchema.safeParse({ ...valid, body: 'x'.repeat(4001) }).success).toBe(false);
    expect(bulkMessageSchema.safeParse({ ...valid, body: 'x'.repeat(4000) }).success).toBe(true);
  });

  test('trims whitespace from subject + body', () => {
    const r = bulkMessageSchema.safeParse({ ...valid, subject: '  Hi  ', body: '  hey  ' });
    expect(r.success).toBe(true);
    expect(r.data.subject).toBe('Hi');
    expect(r.data.body).toBe('hey');
  });
});
