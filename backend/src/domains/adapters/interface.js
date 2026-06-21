function methodNotImplemented(adapterName, method) {
  const err = new Error(`${adapterName}.${method} is not implemented`);
  err.code = 'REGISTRAR_METHOD_NOT_IMPLEMENTED';
  return err;
}

class RegistrarAdapter {
  constructor(options = {}) {
    this.mode = options.mode || 'sandbox';
    this.baseUrl = options.baseUrl || '';
    this.credentials = options.credentials || {};
    this.fetchImpl = options.fetchImpl || global.fetch;
    this.now = options.now || (() => new Date());
  }

  get registrar() {
    return 'UNKNOWN';
  }

  async searchAvailable() {
    throw methodNotImplemented(this.registrar, 'searchAvailable');
  }

  async register() {
    throw methodNotImplemented(this.registrar, 'register');
  }

  async renew() {
    throw methodNotImplemented(this.registrar, 'renew');
  }

  async transferIn() {
    throw methodNotImplemented(this.registrar, 'transferIn');
  }

  async getAuthCode() {
    throw methodNotImplemented(this.registrar, 'getAuthCode');
  }

  async setPrivacy() {
    throw methodNotImplemented(this.registrar, 'setPrivacy');
  }

  async setNameservers() {
    throw methodNotImplemented(this.registrar, 'setNameservers');
  }
}

function addYears(date, years = 1) {
  const out = new Date(date);
  out.setUTCFullYear(out.getUTCFullYear() + Math.max(1, Number(years) || 1));
  return out;
}

function stableRef(prefix, value) {
  const clean = String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `${prefix}-${clean || Date.now().toString(36).toUpperCase()}`;
}

module.exports = {
  RegistrarAdapter,
  addYears,
  methodNotImplemented,
  stableRef,
};
