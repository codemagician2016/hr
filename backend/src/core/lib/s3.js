// ============================================================================
// S3 helper — used by the image-upload endpoint. Graceful fallback: when
// S3_BUCKET isn't configured, isConfigured() returns false and callers fall
// back to embedding base64 inline (legacy behaviour).
// ============================================================================

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

const BUCKET = process.env.S3_BUCKET || '';
const REGION = process.env.S3_REGION || process.env.AWS_REGION || 'ap-south-1';
// Public URL base. Prefer a CloudFront distribution (faster, CDN'd, custom
// domain) over the raw S3 endpoint. If neither is set, falls back to the
// virtual-hosted-style S3 URL so the feature still works without a CDN.
const PUBLIC_URL = (process.env.S3_PUBLIC_URL
  || (BUCKET ? `https://${BUCKET}.s3.${REGION}.amazonaws.com` : '')).replace(/\/+$/, '');

// Prefer dedicated S3 credentials when present so the SES IAM user (used
// for outbound email) doesn't need s3:PutObject. Falls back to the
// shared AWS_* keys for backwards compatibility — no breakage if S3_*
// env vars aren't set yet on a given environment.
const ACCESS_KEY_ID     = process.env.S3_ACCESS_KEY_ID     || process.env.AWS_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;

// Custom S3-compatible endpoint. For Cloudflare R2 set this to
// https://<account_id>.r2.cloudflarestorage.com and S3_REGION=auto. When unset,
// the AWS S3 endpoint is used (derived from region) — fully backward-compatible.
const ENDPOINT = process.env.S3_ENDPOINT || '';

let client = null;
function getClient() {
  if (!BUCKET) return null;
  if (!client) {
    client = new S3Client({
      region: REGION,
      // Cloudflare R2 (or any S3-compatible store) via a custom endpoint.
      ...(ENDPOINT ? { endpoint: ENDPOINT } : {}),
      // Use explicit keys when provided; otherwise fall back to the default AWS
      // credential chain (EC2 instance role) so prod needs no long-lived secrets.
      // NOTE: the role must carry s3:PutObject/DeleteObject on the asset bucket
      // for uploads to work keyless (the deploy role is otherwise S3-read-only).
      ...(ACCESS_KEY_ID && SECRET_ACCESS_KEY
        ? { credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY } }
        : {}),
    });
  }
  return client;
}

function isConfigured() {
  return !!BUCKET && !!PUBLIC_URL;
}

// Decode a data URL like "data:image/jpeg;base64,XXXX" into { buffer, mime, ext }.
// Throws on invalid input. Only images + PDF are accepted (defence against
// arbitrary uploads — an authenticated caller still shouldn't be able to push an
// arbitrary content type into the tenant's bucket). PDF is on the allow-list so the
// documents controller's PDF path works on the S3 branch exactly as on the inline
// fallback (D12); the per-payload size cap stays enforced by the caller.
const ALLOWED_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/pdf': 'pdf',
};
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') throw new Error('dataUrl must be a string');
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('Only base64 data URLs are supported');
  const mime = m[1].toLowerCase();
  const ext  = ALLOWED_EXT[mime];
  if (!ext) throw new Error(`Unsupported upload type: ${mime}`);
  const buffer = Buffer.from(m[2], 'base64');
  return { buffer, mime, ext };
}

// Deterministic-ish key: businessId/scope/<random>.<ext>. The businessId
// prefix lets us scope bucket policies per tenant later if we want, and
// makes objects easy to list / clean up.
function buildKey({ businessId, scope, ext }) {
  const rand = crypto.randomBytes(10).toString('hex');
  const clean = (s) => String(s || 'image').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40);
  return `${clean(businessId)}/${clean(scope)}-${rand}.${ext}`;
}

// Upload a base64 image data URL. Returns { url, key }.
async function uploadDataUrl({ dataUrl, businessId, scope }) {
  if (!isConfigured()) throw new Error('S3 not configured');
  const { buffer, mime, ext } = parseDataUrl(dataUrl);
  const key = buildKey({ businessId, scope, ext });
  await getClient().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mime,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  return { url: `${PUBLIC_URL}/${key}`, key };
}

async function deleteByUrl(url) {
  if (!isConfigured() || typeof url !== 'string') return;
  if (!url.startsWith(PUBLIC_URL + '/')) return; // not ours — skip
  const key = url.slice(PUBLIC_URL.length + 1);
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    console.warn('[s3] delete failed for', key, err.message);
  }
}

// The public URL prefix callers can check against (e.g. to allow-list
// the proxy endpoint only for our own bucket and block SSRF).
function getPublicUrlPrefix() { return PUBLIC_URL; }

// True if the URL points at our bucket, via either the configured public
// prefix (CloudFront/custom domain) or the raw S3 virtual-hosted-style
// endpoint. The dual check matters for tenants whose DB has URLs written
// before a CDN was put in front of S3 (or vice versa).
function isOurUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (PUBLIC_URL && url.startsWith(PUBLIC_URL + '/')) return true;
  if (BUCKET) {
    const rawHost = `https://${BUCKET}.s3.${REGION}.amazonaws.com/`;
    const pathStyle = `https://s3.${REGION}.amazonaws.com/${BUCKET}/`;
    if (url.startsWith(rawHost) || url.startsWith(pathStyle)) return true;
  }
  return false;
}

module.exports = { isConfigured, uploadDataUrl, deleteByUrl, parseDataUrl, getPublicUrlPrefix, isOurUrl };
