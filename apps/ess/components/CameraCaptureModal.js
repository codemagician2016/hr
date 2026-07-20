'use client';

// CameraCaptureModal — the ONE live-camera selfie capture surface for the ESS app
// (Feature 39: face check-in at punch + face registration). Live camera ONLY —
// deliberately NO file-upload fallback: the anti-proxy posture requires the selfie
// to come from a camera the person is in front of right now, not from the photo
// library (docs/features/39-face-geo-attendance-controls.md §1 non-goals).
//
// The preview <video> is MIRRORED (people expect a mirror when they look at
// themselves) but the captured frame is the RAW, UNMIRRORED video — the server-side
// face matcher wants the true image, so the canvas draw does NOT flip.
//
// `onCapture(dataUrl)` may be async: while it runs the modal shows a busy state,
// and if it THROWS the error message is shown inline and the preview stays open
// for a retake (this is how the enroll 422 "no face / too small / multiple faces"
// retake loop works). On success the parent closes the modal by unmounting it.

import { useEffect, useRef, useState } from 'react';
import { Modal, ErrorBanner, Spinner } from '@hr/ui';

const CAMERA_DENIED_MSG =
  'Camera access is needed for face check-in — allow it in your browser settings and try again.';

// Long-side cap for the captured frame — plenty for the matcher, small upload.
const MAX_SIDE = 720;

export default function CameraCaptureModal({ title, hint, onCapture, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [ready, setReady] = useState(false);        // stream attached & playing
  const [camError, setCamError] = useState(null);   // getUserMedia unavailable/denied
  const [photo, setPhoto] = useState(null);         // captured (unmirrored) dataUrl
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  // Open the front camera on mount; stop every track on unmount/close — the
  // camera light MUST go off the moment the modal goes away.
  useEffect(() => {
    let cancelled = false;
    async function start() {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setCamError(CAMERA_DENIED_MSG);
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 720 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setReady(true);
      } catch (_e) {
        if (!cancelled) setCamError(CAMERA_DENIED_MSG);
      }
    }
    start();
    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, []);

  function capture() {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    // Draw the RAW frame — no scaleX(-1) here; only the on-screen preview mirrors.
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    setSubmitError(null);
    setPhoto(canvas.toDataURL('image/jpeg', 0.85));
  }

  function retake() {
    setSubmitError(null);
    setPhoto(null);
  }

  async function usePhoto() {
    if (!photo || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onCapture(photo);
      // Success → the parent unmounts this modal; nothing more to do here.
    } catch (e) {
      // e.g. enroll 422 (NO_FACE / FACE_TOO_SMALL / MULTIPLE_FACES) — show the
      // server's human message and keep the modal open so they can retake.
      setSubmitError(e?.message || 'Could not use this photo. Please retake.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3">
        {hint && (
          <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>{hint}</p>
        )}

        {camError ? (
          <div
            className="rounded-xl border border-dashed px-4 py-8 text-center text-sm"
            style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}
          >
            {camError}
          </div>
        ) : (
          <div
            className="relative overflow-hidden rounded-xl bg-black"
            style={{ aspectRatio: '3 / 4', maxHeight: '55vh' }}
          >
            {/* The live video stays mounted (stream attached) even while the
                captured preview covers it — retake is instant. playsInline keeps
                iOS Safari from hijacking the stream into fullscreen. */}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="h-full w-full object-cover"
              style={{ transform: 'scaleX(-1)', display: photo ? 'none' : 'block' }}
            />
            {photo && (
              // Preview mirrored too, so it looks exactly like the live view the
              // person just saw — the underlying dataUrl stays unmirrored.
              <img
                src={photo}
                alt="Your captured selfie"
                className="h-full w-full object-cover"
                style={{ transform: 'scaleX(-1)' }}
              />
            )}
            {!ready && !photo && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Spinner />
              </div>
            )}
          </div>
        )}

        {submitError && <ErrorBanner message={submitError} />}

        {!camError && (
          photo ? (
            <div className="flex gap-3">
              <button
                type="button"
                onClick={retake}
                disabled={submitting}
                className="flex-1 rounded-lg border py-2.5 text-sm font-semibold transition disabled:opacity-50"
                style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}
              >
                Retake
              </button>
              <button
                type="button"
                onClick={usePhoto}
                disabled={submitting}
                className="flex-1 rounded-lg py-2.5 text-sm font-semibold transition disabled:opacity-50"
                style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
              >
                {submitting ? 'Sending…' : 'Use photo'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={capture}
              disabled={!ready}
              className="w-full rounded-lg py-2.5 text-sm font-semibold transition disabled:opacity-50"
              style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
            >
              Capture
            </button>
          )
        )}
      </div>
    </Modal>
  );
}
