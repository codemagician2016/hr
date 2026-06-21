const { PrismaClient } = require('@prisma/client');

const prismaGlobalKey = Symbol.for('sitepresso.prisma');
const prismaPatchKey = Symbol.for('sitepresso.prisma.constructorPatch');

const prisma = globalThis[prismaGlobalKey] || new PrismaClient();
globalThis[prismaGlobalKey] = prisma;

// Several legacy controllers instantiate PrismaClient directly. Make those
// calls return the process singleton so adding API workers does not multiply
// PostgreSQL pools by every controller module.
const prismaModule = require('@prisma/client');
if (!globalThis[prismaPatchKey]) {
  prismaModule.PrismaClient = new Proxy(PrismaClient, {
    construct() {
      return prisma;
    },
    apply() {
      return prisma;
    },
  });
  globalThis[prismaPatchKey] = true;
}

module.exports = prisma;
