'use strict';
// Talent vertical sub-routers (recruitment/ATS + performance + ESS performance).
// Re-exported for the HR aggregator (backend/src/hr/routes/index.js), which mounts
// each under /api/hr/recruitment, /api/hr/performance and /api/hr/ess/performance.
module.exports = {
  recruitment: require('./recruitment.routes'),
  performance: require('./performance.routes'),
  // Feature 34 — 9-box grid + competency framework (talent-review depth over a closed
  // F8 cycle). Mounted at /api/hr/ninebox.
  ninebox: require('./ninebox.routes'),
  essPerformance: require('./ess-performance.routes'),
  // Feature 12 — UNAUTHENTICATED public careers board + apply. Mounted at
  // /api/public/careers in backend/src/index.js (NOT under /api/hr).
  publicCareers: require('./publicCareers.routes'),
};
