'use strict';
// Talent vertical sub-routers (recruitment/ATS + performance). Re-exported for
// the HR aggregator (backend/src/hr/routes/index.js), which mounts each under
// /api/hr/recruitment and /api/hr/performance.
module.exports = {
  recruitment: require('./recruitment.routes'),
  performance: require('./performance.routes'),
};
