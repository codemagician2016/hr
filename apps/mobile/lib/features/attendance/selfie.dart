// Selfie capture for the FACE attendance-capture mode (Feature 2). Uses
// image_picker's camera source (front camera preferred) and encodes the captured
// JPEG to a base64 data URL — the exact `selfieDataUrl` shape the backend
// /me/attendance/punch + /me/attendance/face/enroll endpoints accept.
//
// A denied camera permission / a cancelled capture is NOT fatal — the caller
// decides what to do (the punch flow re-prompts or, when FACE is only WARN, lets
// the punch proceed and the server flags it for HR review).

import 'dart:convert';

import 'package:image_picker/image_picker.dart';

class SelfieResult {
  const SelfieResult({this.dataUrl, this.error});

  /// "data:image/jpeg;base64,…" ready to POST as `selfieDataUrl`, or null.
  final String? dataUrl;

  /// A human note when the selfie could not be captured (cancelled / denied).
  final String? error;

  bool get ok => dataUrl != null;
}

class Selfie {
  Selfie._();

  static final ImagePicker _picker = ImagePicker();

  /// Capture a selfie from the FRONT camera and return it as a base64 data URL.
  /// imageQuality + maxWidth keep the payload comfortably under the backend's 6 MB
  /// cap (a phone selfie at 1080px JPEG-80 is ~150-400 KB).
  static Future<SelfieResult> capture() async {
    try {
      final XFile? shot = await _picker.pickImage(
        source: ImageSource.camera,
        preferredCameraDevice: CameraDevice.front,
        imageQuality: 80,
        maxWidth: 1080,
      );
      if (shot == null) {
        return const SelfieResult(error: 'Selfie cancelled.');
      }
      final bytes = await shot.readAsBytes();
      final mime = _mimeFor(shot.name);
      final b64 = base64Encode(bytes);
      return SelfieResult(dataUrl: 'data:$mime;base64,$b64');
    } catch (_) {
      return const SelfieResult(
        error: 'Could not access the camera — check the app camera permission.',
      );
    }
  }

  static String _mimeFor(String name) {
    final n = name.toLowerCase();
    if (n.endsWith('.png')) return 'image/png';
    if (n.endsWith('.webp')) return 'image/webp';
    return 'image/jpeg';
  }
}
