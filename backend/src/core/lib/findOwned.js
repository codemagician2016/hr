// Cleanup #7 — fetch a tenant-owned record OR write a 404. Replaces
// the pattern:
//
//   const existing = await prisma.businessPage.findFirst({
//     where: { id: req.params.id, businessId: req.user.businessId },
//   });
//   if (!existing) return res.status(404).json({ message: 'Page not found' });
//
// with:
//
//   const page = await findOwned(prisma.businessPage, req, res, { resource: 'page' });
//   if (!page) return; // findOwned already wrote a 404
//
// The `resource` arg controls the 404 message. `select` is forwarded to
// Prisma when callers want to limit columns. `id` defaults to
// req.params.id but can be overridden for endpoints that take the id
// from the body or a different param.

async function findOwned(model, req, res, { resource = 'record', id, select } = {}) {
  const recordId = id ?? req.params?.id;
  if (!recordId) {
    res.status(400).json({ message: `${resource} id is required` });
    return null;
  }
  const businessId = req.user?.businessId;
  if (!businessId) {
    res.status(400).json({ message: 'You must set up your business first' });
    return null;
  }
  const existing = await model.findFirst({
    where: { id: recordId, businessId },
    ...(select ? { select } : {}),
  });
  if (!existing) {
    res.status(404).json({ message: `${resource[0].toUpperCase()}${resource.slice(1)} not found` });
    return null;
  }
  return existing;
}

module.exports = { findOwned };
