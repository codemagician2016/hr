const s3 = require('../lib/s3');

// POST /api/upload/image
// Body: { dataUrl: 'data:image/...;base64,....', scope: 'hero' | 'about' | ... }
// Returns: { url: 'https://cdn.../key.jpg' }
// 501 when S3 isn't configured so the client can fall back to inline base64.
async function uploadImage(req, res) {
  if (!req.user?.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  if (!s3.isConfigured()) {
    return res.status(501).json({ message: 'Image hosting not configured on this server' });
  }
  const { dataUrl, scope } = req.body || {};
  if (!dataUrl || typeof dataUrl !== 'string') {
    return res.status(400).json({ message: 'dataUrl is required' });
  }
  // Guard payload size so a bug in the client can't blow the DB/S3 bill.
  if (dataUrl.length > 20 * 1024 * 1024) {
    return res.status(413).json({ message: 'Image too large' });
  }
  try {
    const { url } = await s3.uploadDataUrl({
      dataUrl,
      businessId: req.user.businessId,
      scope: scope || 'image',
    });
    res.json({ url });
  } catch (err) {
    const msg = err.message || 'Upload failed';
    res.status(400).json({ message: msg });
  }
}

// GET /api/upload/proxy?url=<url>
// Streams a public image from our own S3/CloudFront bucket back to the
// caller on the same origin, so the editor's "adjust image" modal can
// FileReader the bytes without CORS. SSRF-safe: only URLs beginning with
// our S3 public URL prefix are fetched; anything else is 400.
async function proxyImage(req, res) {
  if (!req.user?.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  const target = req.query.url;
  if (!target || typeof target !== 'string') {
    return res.status(400).json({ message: 'url is required' });
  }
  if (!s3.isOurUrl(target)) {
    return res.status(400).json({ message: 'Only our own image URLs can be proxied' });
  }
  try {
    const upstream = await fetch(target);
    if (!upstream.ok) {
      return res.status(upstream.status).json({ message: `Upstream ${upstream.status}` });
    }
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    const arrayBuffer = await upstream.arrayBuffer();
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    res.status(502).json({ message: err.message || 'Proxy fetch failed' });
  }
}

module.exports = { uploadImage, proxyImage };
