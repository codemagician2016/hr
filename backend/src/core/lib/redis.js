'use strict';
const Redis = require('ioredis');

let client = null;

function getRedis() {
  if (!process.env.REDIS_URL) return null;
  if (!client) {
    client = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
    });
    client.on('error', () => {});
  }
  return client;
}

// DB vertical enum → router key (booking/shop/web)
const VERTICAL_TO_ROUTER = { APPOINTMENT: 'booking', ECOMMERCE: 'shop', STATIC: 'web' };

async function setTenantVertical(slug, dbVertical) {
  const redis = getRedis();
  if (!redis || !slug || !dbVertical) return;
  const routerKey = VERTICAL_TO_ROUTER[dbVertical];
  if (!routerKey) return;
  await redis.set(`vertical:${slug}`, routerKey, 'EX', 86400).catch(() => {});
}

module.exports = { getRedis, setTenantVertical };
