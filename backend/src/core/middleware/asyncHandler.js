'use strict';

// Wrap an async Express handler so a rejected promise is forwarded to the
// error-handling middleware (Express 4 does NOT do this natively) instead of
// surfacing as a process-level unhandled rejection. The one failing request
// gets a clean 500 JSON response; the rest of the API — and the whole payment
// gateway — keeps serving. Pair with the process-level guards in src/index.js.
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
module.exports.asyncHandler = asyncHandler;
