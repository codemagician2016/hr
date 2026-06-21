// Launch-period free access. LAUNCH_FREE_UNTIL only describes the calendar
// window; actual paid-plan grants are now behind an explicit second switch so
// billing environments cannot accidentally create paid access without Paddle.
//
// Format: ISO date string — e.g. '2026-09-01'

function isProductionPlatform() {
  const platformDomain = String(process.env.PLATFORM_DOMAIN || '').toLowerCase();
  const envLabel = String(process.env.ENV_LABEL || process.env.DEPLOY_ENV || '').toLowerCase();
  return platformDomain === 'sitepresso.com' || envLabel === 'prod' || envLabel === 'production';
}

function launchFreeAllowedInThisEnvironment() {
  if (!isProductionPlatform()) return true;
  return String(process.env.LAUNCH_FREE_ALLOW_PROD || '').toLowerCase() === 'true';
}

function isLaunchFreePeriod() {
  const until = process.env.LAUNCH_FREE_UNTIL;
  if (!until) return false;
  if (!launchFreeAllowedInThisEnvironment()) return false;
  return new Date() < new Date(until);
}

function launchFreePlanGrantsAllowed() {
  const enabled = String(process.env.LAUNCH_FREE_ENABLE_PLAN_GRANTS || '').toLowerCase() === 'true';
  return enabled && isLaunchFreePeriod();
}

function launchFreeUntil() {
  const until = process.env.LAUNCH_FREE_UNTIL;
  return until ? new Date(until) : null;
}

module.exports = {
  isLaunchFreePeriod,
  launchFreeUntil,
  isProductionPlatform,
  launchFreeAllowedInThisEnvironment,
  launchFreePlanGrantsAllowed,
};
