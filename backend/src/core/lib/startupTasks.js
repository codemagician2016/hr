const path = require('path');
const { spawn } = require('child_process');
const prisma = require('./prisma');

const BACKEND_ROOT = path.resolve(__dirname, '../../..');

async function repairTaxFixyPagesIfNeeded() {
  const isStaging = process.env.DEPLOY_ENV === 'staging'
    || (process.env.PLATFORM_DOMAIN || '').toLowerCase() === 'aapkatech.com';
  if (!isStaging) return;

  try {
    const business = await prisma.business.findUnique({
      where: { slug: 'taxfixy' },
      select: { id: true },
    });
    if (!business) return;

    const pageCount = await prisma.businessPage.count({ where: { businessId: business.id } });
    if (pageCount > 0) return;

    const seedScript = path.join(BACKEND_ROOT, 'scripts', 'seed-taxfixy-web.js');
    console.warn('[taxfixy-repair] taxfixy has zero CMS pages; running seed script once');
    const child = spawn(process.execPath, [seedScript], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, TAXFIXY_SCRAPE: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (buf) => process.stdout.write(`[taxfixy-repair] ${buf}`));
    child.stderr.on('data', (buf) => process.stderr.write(`[taxfixy-repair] ${buf}`));
    child.on('exit', (code) => {
      if (code === 0) console.log('[taxfixy-repair] seed completed');
      else console.error(`[taxfixy-repair] seed exited with code ${code}`);
    });
  } catch (err) {
    console.error('[taxfixy-repair] check failed:', err.message);
  }
}

function runStartupTasks() {
  require('./ecomPermissionSeeder')
    .seedEcomPermissions()
    .then((r) => {
      if (r.skipped) return;
      console.log(`[ecom-permissions] seeded - inserted=${r.inserted} updated=${r.updated} total=${r.total}`);
    })
    .catch((err) => {
      console.error('[ecom-permissions] seed failed:', err.message);
    });

  require('./notifications/templates')
    .seedTemplates()
    .catch((err) => {
      console.error('[templates] seed failed:', err.message);
    });

  repairTaxFixyPagesIfNeeded();
}

module.exports = {
  repairTaxFixyPagesIfNeeded,
  runStartupTasks,
};
