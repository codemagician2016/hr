// Tiny shared error class so each provider can throw a consistent
// "Phase B/C/D pending" error without circular-importing the registry.

class NotImplemented extends Error {
  constructor(provider, method) {
    super(`${provider}.${method}() not implemented yet — pending phased rollout`);
    this.code = 'PROVIDER_NOT_IMPLEMENTED';
  }
}

module.exports = { NotImplemented };
