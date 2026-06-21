const availability = require('./availability');
const config = require('./config');
const domainNames = require('./domainNames');
const domainService = require('./domainService');
const pricing = require('./pricing');
const renewalCron = require('./renewalCron');
const routing = require('./routing');

module.exports = {
  ...availability,
  ...config,
  ...domainNames,
  ...domainService,
  ...pricing,
  ...renewalCron,
  ...routing,
};
