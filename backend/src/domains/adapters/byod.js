const { assertValidDomainName } = require('../domainNames');
const { RegistrarAdapter } = require('./interface');

class ByodAdapter extends RegistrarAdapter {
  get registrar() {
    return 'BYOD';
  }

  async searchAvailable() {
    return [];
  }

  async register(opts = {}) {
    const domainName = assertValidDomainName(opts.domainName);
    return {
      registrarRef: null,
      domainName,
      status: 'BYOD',
      expiresAt: null,
    };
  }

  async renew() {
    const err = new Error('BYOD domains are renewed at the external registrar.');
    err.code = 'BYOD_RENEW_UNSUPPORTED';
    throw err;
  }

  async transferIn(domainName) {
    assertValidDomainName(domainName);
    return {
      registrarRef: null,
      status: 'BYOD',
    };
  }

  async getAuthCode() {
    const err = new Error('BYOD authorization codes must be retrieved at the external registrar.');
    err.code = 'BYOD_AUTH_CODE_UNSUPPORTED';
    throw err;
  }

  async setPrivacy(registrarRef, enabled) {
    return { registrarRef: registrarRef || null, privacyEnabled: Boolean(enabled), external: true };
  }

  async setNameservers(registrarRef, nameservers = []) {
    return { registrarRef: registrarRef || null, nameservers, external: true };
  }
}

module.exports = {
  ByodAdapter,
};
