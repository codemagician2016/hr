// Unit tests for the shared email / password / phone validators used
// across controllers. Pure functions, no DB, safe in any CI.
const {
  validateSignupEmail,
  validatePassword,
  validatePhone,
  isDisposableEmail,
  hasValidFormat,
} = require('../src/core/lib/inputValidation');

describe('validateSignupEmail', () => {
  test('accepts a normal email', () => {
    expect(validateSignupEmail('user@gmail.com')).toBeNull();
  });

  test('rejects empty', () => {
    expect(validateSignupEmail('')).toMatch(/required/i);
  });

  test('rejects malformed', () => {
    expect(validateSignupEmail('not-an-email')).toMatch(/valid email/i);
  });

  test('rejects known disposable domains', () => {
    expect(validateSignupEmail('test@yopmail.com')).toMatch(/permanent/i);
    expect(validateSignupEmail('foo@mailinator.com')).toMatch(/permanent/i);
    expect(validateSignupEmail('bar@10minutemail.com')).toMatch(/permanent/i);
  });
});

describe('isDisposableEmail', () => {
  test('returns true for disposable', () => {
    expect(isDisposableEmail('test@yopmail.com')).toBe(true);
  });
  test('returns false for gmail', () => {
    expect(isDisposableEmail('user@gmail.com')).toBe(false);
  });
  test('returns false for malformed', () => {
    expect(isDisposableEmail('not-an-email')).toBe(false);
  });
});

describe('hasValidFormat', () => {
  test('accepts valid shapes', () => {
    expect(hasValidFormat('a@b.c')).toBe(true);
    expect(hasValidFormat('user.name+tag@sub.example.co.uk')).toBe(true);
  });
  test('rejects invalid shapes', () => {
    expect(hasValidFormat('plain')).toBe(false);
    expect(hasValidFormat('@nohost')).toBe(false);
    expect(hasValidFormat('')).toBe(false);
    expect(hasValidFormat(null)).toBe(false);
  });
});

describe('validatePassword', () => {
  test('accepts a well-formed password', () => {
    expect(validatePassword('Good1pass')).toBeNull();
  });
  test('rejects short', () => {
    expect(validatePassword('Ab1')).toMatch(/at least 8/i);
  });
  test('rejects all lowercase + number', () => {
    expect(validatePassword('lowercase1')).toMatch(/uppercase/i);
  });
  test('rejects all uppercase + number', () => {
    expect(validatePassword('UPPERCASE1')).toMatch(/lowercase/i);
  });
  test('rejects mixed case without digit', () => {
    expect(validatePassword('NoDigitsHere')).toMatch(/number/i);
  });
  test('rejects empty', () => {
    expect(validatePassword('')).toMatch(/required/i);
  });
  test('rejects too long', () => {
    expect(validatePassword('Abc1' + 'x'.repeat(200))).toMatch(/too long/i);
  });
});

describe('validatePhone', () => {
  test('accepts international format', () => {
    expect(validatePhone('+64 21 999 1111')).toBeNull();
    expect(validatePhone('+919876543210')).toBeNull();
  });
  test('accepts US format with parentheses', () => {
    expect(validatePhone('(555) 123-4567')).toBeNull();
  });
  test('accepts bare digits', () => {
    expect(validatePhone('9876543210')).toBeNull();
  });
  test('rejects too short', () => {
    expect(validatePhone('12345')).toMatch(/valid phone/i);
  });
  test('rejects alpha characters', () => {
    expect(validatePhone('call-me')).toMatch(/valid phone/i);
  });
  test('empty returns null when not required', () => {
    expect(validatePhone('')).toBeNull();
    expect(validatePhone(null)).toBeNull();
  });
  test('empty returns error when required', () => {
    expect(validatePhone('', { required: true })).toMatch(/required/i);
  });
});
