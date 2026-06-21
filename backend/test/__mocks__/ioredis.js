'use strict';

class RedisMock {
  constructor() {}
  get() { return Promise.resolve(null); }
  set() { return Promise.resolve('OK'); }
  del() { return Promise.resolve(0); }
  quit() { return Promise.resolve('OK'); }
  on() { return this; }
}

module.exports = RedisMock;
