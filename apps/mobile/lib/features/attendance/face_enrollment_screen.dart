// Face enrolment (Feature 2) — capture the ONE reference selfie the FACE
// attendance-capture mode matches each punch against. SELF_ONLY: POSTs to
// /api/hr/me/attendance/face/enroll (the employee is the session subject). The
// reference is stored server-side for audit + (with a real matcher) embedded; the
// default stub matcher stores the selfie and defers matches to HR review.
//
// Reached from the attendance screen ("Set up face") when the resolved policy
// requires FACE and faceEnrolled is false.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'attendance_providers.dart';
import 'selfie.dart';

class FaceEnrollmentScreen extends ConsumerStatefulWidget {
  const FaceEnrollmentScreen({super.key});

  @override
  ConsumerState<FaceEnrollmentScreen> createState() => _FaceEnrollmentScreenState();
}

class _FaceEnrollmentScreenState extends ConsumerState<FaceEnrollmentScreen> {
  bool _busy = false;
  String? _error;
  bool _enrolled = false;
  DateTime? _enrolledAt;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _loadStatus();
  }

  Future<void> _loadStatus() async {
    try {
      final res = await ref.read(apiClientProvider).get(Api.faceEnrollment);
      if (res is Map<String, dynamic>) {
        setState(() {
          _enrolled = res['enrolled'] == true;
          _enrolledAt = DateTime.tryParse((res['enrolledAt'] ?? '').toString());
        });
      }
    } catch (_) {/* show the enrol CTA regardless */} finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _enroll() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final shot = await Selfie.capture();
    if (!shot.ok) {
      setState(() {
        _busy = false;
        _error = shot.error;
      });
      return;
    }
    try {
      await ref.read(apiClientProvider).post(Api.faceEnroll, {'selfieDataUrl': shot.dataUrl});
      // Refresh the capture policy so the attendance screen sees faceEnrolled=true.
      ref.invalidate(capturePolicyProvider);
      if (mounted) {
        setState(() {
          _enrolled = true;
          _enrolledAt = DateTime.now();
        });
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Your face is enrolled. You can now punch with a selfie.')),
        );
      }
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not enrol your face. Please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Face setup')),
      body: _loading
          ? const LoadingView()
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                SectionCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      Icon(
                        _enrolled ? Icons.verified_user_outlined : Icons.face_retouching_natural,
                        size: 56,
                        color: _enrolled ? BrandColors.success : BrandColors.teal,
                      ),
                      const SizedBox(height: 12),
                      Text(
                        _enrolled ? 'Face enrolled' : 'Set up face recognition',
                        style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: BrandColors.text),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        _enrolled
                            ? 'Your reference photo is on file${_enrolledAt != null ? ' (since ${_enrolledAt!.toLocal().toString().split(' ').first})' : ''}. Re-take it any time below.'
                            : 'Capture a clear, front-facing selfie once. We use it to confirm it is you each time you punch. Good lighting, no mask, face centred.',
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: BrandColors.muted, fontSize: 13),
                      ),
                      const SizedBox(height: 16),
                      if (_error != null) ...[
                        ErrorBanner(message: _error!),
                        const SizedBox(height: 12),
                      ],
                      FilledButton.icon(
                        onPressed: _busy ? null : _enroll,
                        icon: _busy
                            ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                            : const Icon(Icons.camera_alt_outlined),
                        label: Text(_enrolled ? 'Re-take selfie' : 'Take selfie'),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                const Text(
                  'Your selfie is stored securely for verification only. Liveness detection is not used in this version.',
                  style: TextStyle(color: BrandColors.muted, fontSize: 11),
                ),
              ],
            ),
    );
  }
}
