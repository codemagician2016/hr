// apiExt.js — Feature 11. Re-exports the hr-admin API helpers + adds `put` (the policy
// builder bulk-replaces a rule grid with PUT). Keeps lib/api.js untouched (shared file).

import { request, get, post, patch, del, qs } from '@/lib/api';

export function put(path, data) {
  return request(path, { method: 'PUT', body: JSON.stringify(data ?? {}) });
}

export { get, post, patch, del, qs, request };
