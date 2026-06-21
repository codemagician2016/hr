// Sprint 3.3e — shared image-processing helpers used by ImageEditorModal
// and the existing CoverImageField / hero / logo / gallery upload paths.
//
// All helpers are client-only (use the DOM Image + canvas APIs). We keep
// them in a plain JS module so any 'use client' component can import.
//
// The pipeline for a saved image:
//   1. loadImage(srcOrFile)            — File or URL → HTMLImageElement
//   2. renderEditedToCanvas(opts)      — apply zoom/rotation/offset/crop
//   3. canvasToDataUrl(canvas, q)      — encode (JPEG default, PNG for favicons)
//   4. uploadDataUrl(dataUrl, scope)   — POST to /api/upload/image,
//                                        falls back to keeping the data
//                                        URL inline if S3 isn't set up

// Resolve a File OR URL string to an HTMLImageElement.
//
// CORS handling — when we draw the loaded image to a canvas and call
// toDataURL(), the canvas must NOT be "tainted." That requires the
// browser to have fetched the image with CORS. So:
//   1. Try with crossOrigin='anonymous' on the original URL.
//   2. If that fails (the host doesn't return CORS headers), retry
//      via the same-origin /api/upload/proxy?url= endpoint, which
//      streams our-S3 images back through our backend (no CORS
//      complication).
//   3. Last-resort, fall back to no-crossOrigin so at least the
//      preview renders. canvas.toDataURL() will throw SecurityError
//      on save in this case — caller should handle gracefully.
//
// File inputs and data: URLs skip the dance entirely — neither has
// CORS issues.
function tryLoad(src, useCrossOrigin) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (useCrossOrigin) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image'));
    img.src = src;
  });
}

export async function loadImage(srcOrFile) {
  if (!srcOrFile) throw new Error('No image source');
  // File path — read as data URL via FileReader, then load.
  if (typeof srcOrFile !== 'string') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.onload = () => {
        tryLoad(reader.result, false).then(resolve, reject);
      };
      reader.readAsDataURL(srcOrFile);
    });
  }
  // Data URLs and same-origin paths — direct load, no CORS dance.
  if (srcOrFile.startsWith('data:') || srcOrFile.startsWith('/')) {
    return tryLoad(srcOrFile, true);
  }
  // Cross-origin URL: try crossOrigin first, then proxy, then bare.
  try {
    return await tryLoad(srcOrFile, true);
  } catch {
    try {
      const proxied = `/api/upload/proxy?url=${encodeURIComponent(srcOrFile)}`;
      return await tryLoad(proxied, true);
    } catch {
      // Last resort: load without crossOrigin so preview at least
      // shows. Canvas operations will throw SecurityError on save
      // — caller catches and shows a friendly message.
      return tryLoad(srcOrFile, false);
    }
  }
}

// Render an edited image to an offscreen canvas. The source image is
// drawn into the canvas frame:
//   - rotated by `rotation` (0 / 90 / 180 / 270 degrees)
//   - scaled by `zoom` (1.0 = fit-to-frame; >1 = zoom in)
//   - translated by `offsetX`/`offsetY` in canvas pixels (drag offset)
//   - cropped to the canvas's aspect ratio (frameAspect)
//
// Output canvas dimensions: outputWidth × outputWidth/frameAspect, capped
// at maxOutputWidth. Background fills with white so JPEG encoding
// doesn't bleed transparent regions to black.
export function renderEditedToCanvas({
  image,
  rotation = 0,
  zoom = 1,
  offsetX = 0,
  offsetY = 0,
  frameAspect = 16 / 9,    // canvas width / height
  maxOutputWidth = 1600,
  background = '#ffffff',
  fitMode = 'cover',
}) {
  const outW = Math.min(maxOutputWidth, Math.round(maxOutputWidth));
  const outH = Math.round(outW / frameAspect);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (background && background !== 'transparent') {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, outW, outH);
  }

  // Compute the rotated bounding box of the image so we can pick the
  // correct fit-scale (cover the canvas before applying user zoom).
  const isQuarterTurn = rotation % 180 !== 0;
  const naturalW = isQuarterTurn ? image.naturalHeight : image.naturalWidth;
  const naturalH = isQuarterTurn ? image.naturalWidth : image.naturalHeight;
  const fitScale = fitMode === 'contain'
    ? Math.min(outW / naturalW, outH / naturalH)
    : Math.max(outW / naturalW, outH / naturalH);
  const drawScale = fitScale * zoom;

  ctx.save();
  ctx.translate(outW / 2 + offsetX, outH / 2 + offsetY);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(
    image,
    -image.naturalWidth * drawScale / 2,
    -image.naturalHeight * drawScale / 2,
    image.naturalWidth * drawScale,
    image.naturalHeight * drawScale,
  );
  ctx.restore();
  return canvas;
}

export function canvasToDataUrl(canvas, quality = 0.92, type = 'image/jpeg') {
  return canvas.toDataURL(type, quality);
}

// Upload a data URL through the existing /api/upload/image endpoint.
// Returns the final URL (S3 URL when configured, else the original data
// URL when the backend signals "501 not configured" so the page still
// works without S3).
export async function uploadDataUrl(dataUrl, scope = 'image') {
  try {
    const res = await fetch('/api/upload/image', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl, scope }),
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data?.url) return data.url;
    }
  } catch {
    // Network or S3 hiccup — fall through to data URL fallback.
  }
  return dataUrl;
}

// Convenience: Image File → final URL ready to drop into a content blob.
// Skips the editor entirely; preserves aspect ratio, just resizes to
// maxWidth and re-encodes. Used by paths that don't surface the editor
// (drag-drop with no UI, programmatic uploads, etc.).
export async function quickUploadImage(file, { maxWidth = 1600, quality = 0.92, scope = 'image' } = {}) {
  const img = await loadImage(file);
  const ratio = img.naturalHeight / img.naturalWidth;
  const w = Math.min(img.naturalWidth, maxWidth);
  const h = Math.round(w * ratio);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return uploadDataUrl(dataUrl, scope);
}
