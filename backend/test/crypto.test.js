const { encrypt, decrypt } = require('../src/core/lib/crypto');

describe('crypto (AES-256-GCM token storage)', () => {
  const ORIGINAL_SECRET = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret-for-crypto-tests-not-for-prod';
  });

  afterAll(() => {
    process.env.JWT_SECRET = ORIGINAL_SECRET;
  });

  test('round-trips a short string', () => {
    const enc = encrypt('hello world');
    expect(typeof enc).toBe('string');
    expect(enc).not.toBe('hello world');
    expect(decrypt(enc)).toBe('hello world');
  });

  test('round-trips a realistic refresh-token-shaped string', () => {
    const token = '1//06abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKL';
    expect(decrypt(encrypt(token))).toBe(token);
  });

  test('round-trips Unicode safely', () => {
    const text = '你好 — café — राकेश';
    expect(decrypt(encrypt(text))).toBe(text);
  });

  test('returns null for null/undefined/empty input', () => {
    expect(encrypt(null)).toBe(null);
    expect(encrypt(undefined)).toBe(null);
    expect(decrypt(null)).toBe(null);
    expect(decrypt(undefined)).toBe(null);
    expect(decrypt('')).toBe(null);
  });

  test('two encryptions of the same plaintext differ (random IV)', () => {
    const a = encrypt('same input');
    const b = encrypt('same input');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('same input');
    expect(decrypt(b)).toBe('same input');
  });

  test('decrypt fails on tampered ciphertext (GCM auth tag)', () => {
    const enc = encrypt('secret');
    // Flip a single byte in the ciphertext — base64 decode, mutate,
    // re-encode. Last byte is most likely inside the ciphertext segment.
    const buf = Buffer.from(enc, 'base64');
    buf[buf.length - 1] = buf[buf.length - 1] ^ 0xff;
    const tampered = buf.toString('base64');
    expect(() => decrypt(tampered)).toThrow();
  });

  test('decrypt fails when the key (JWT_SECRET) changes', () => {
    const enc = encrypt('rotation test');
    process.env.JWT_SECRET = 'a-completely-different-secret';
    expect(() => decrypt(enc)).toThrow();
    process.env.JWT_SECRET = 'test-secret-for-crypto-tests-not-for-prod';
  });

  test('encrypt throws when JWT_SECRET is missing', () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    expect(() => encrypt('whatever')).toThrow(/JWT_SECRET/);
    process.env.JWT_SECRET = saved;
  });
});
