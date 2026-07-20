// Face registration (Features 2 + 39) — capture the ONE reference selfie the
// FACE attendance-capture mode matches each punch against. SELF_ONLY: POSTs to
// /api/hr/me/attendance/face/enroll (the employee is the session subject).
//
// Feature 39: a submission is no longer live immediately — it lands PENDING and
// HR approves it before face check-in activates. This screen renders the full
// lifecycle: NONE → PENDING (awaiting HR) → ACTIVE (approved) / REJECTED (with
// HR's reason + retake) / REVOKED. A retake while ACTIVE deliberately pauses
// face check-in until HR re-approves the new photo (secure default).
//
// Reached from the attendance screen ("Set up face") when the resolved policy
// requires FACE and no APPROVED reference exists.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';
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
  String _status = 'NONE'; // NONE | PENDING | ACTIVE | REJECTED | REVOKED
  String? _decisionNote;
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
          _status = (res['status'] as String?) ?? (res['enrolled'] == true ? 'ACTIVE' : 'NONE');
          _decisionNote = res['decisionNote'] as String?;
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
      final res = await ref
          .read(apiClientProvider)
          .post(Api.faceEnroll, {'selfieDataUrl': shot.dataUrl});
      // Refresh the capture policy so the attendance screen sees the new state.
      ref.invalidate(capturePolicyProvider);
      if (mounted) {
        final body = res is Map<String, dynamic> ? res : const <String, dynamic>{};
        setState(() {
          _status = (body['status'] as String?) ?? 'PENDING';
          _decisionNote = null;
          _enrolledAt = DateTime.now();
        });
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              (body['message'] as String?) ??
                  'Face submitted — HR will review and approve it before face check-in activates.',
            ),
          ),
        );
      }
    } on ApiException catch (e) {
      // 422 = capture quality (no face / too small / more than one face) — the
      // server message tells the employee exactly what to fix before retaking.
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not submit your face. Please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  ({IconData icon, Color color, String title, String body}) get _stateView {
    switch (_status) {
      case 'ACTIVE':
        return (
          icon: Icons.verified_user_outlined,
          color: BrandColors.success,
          title: 'Face approved',
          body:
              'Your reference photo is approved${_enrolledAt != null ? ' (since ${_enrolledAt!.toLocal().toString().split(' ').first})' : ''} — face check-in is active. Retaking it pauses face check-in until HR approves the new photo.',
        );
      case 'PENDING':
        return (
          icon: Icons.hourglass_top_outlined,
          color: BrandColors.teal,
          title: 'Awaiting HR approval',
          body:
              'Your photo has been submitted. Face check-in activates as soon as HR approves it — no further action needed.',
        );
      case 'REJECTED':
        return (
          icon: Icons.error_outline,
          color: BrandColors.danger,
          title: 'Registration declined',
          body: _decisionNote == null || _decisionNote!.isEmpty
              ? 'HR declined your photo. Retake it in good light, face centred, alone in the frame.'
              : 'HR declined your photo: "$_decisionNote". Retake and resubmit.',
        );
      case 'REVOKED':
        return (
          icon: Icons.remove_moderator_outlined,
          color: BrandColors.danger,
          title: 'Registration revoked',
          body: _decisionNote == null || _decisionNote!.isEmpty
              ? 'HR revoked your face registration. Submit a new photo to use face check-in again.'
              : 'HR revoked your face registration: "$_decisionNote". Submit a new photo.',
        );
      default:
        return (
          icon: Icons.face_retouching_natural,
          color: BrandColors.teal,
          title: 'Set up face check-in',
          body:
              'Capture a clear, front-facing selfie once — alone, good lighting, no mask, face centred. HR approves it, then every punch is matched against it.',
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final view = _stateView;
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
                      Icon(view.icon, size: 56, color: view.color),
                      const SizedBox(height: 12),
                      Text(
                        view.title,
                        style: const TextStyle(
                            fontSize: 18, fontWeight: FontWeight.w800, color: BrandColors.text),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        view.body,
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
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                    strokeWidth: 2, color: Colors.white))
                            : const Icon(Icons.camera_alt_outlined),
                        label: Text(switch (_status) {
                          'NONE' => 'Take selfie',
                          'PENDING' => 'Retake & resubmit',
                          _ => 'Retake selfie',
                        }),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                const Text(
                  'Your selfie is stored securely and matched on DriftHR servers only — it is never shared with third parties. Liveness detection is not used in this version.',
                  style: TextStyle(color: BrandColors.muted, fontSize: 11),
                ),
              ],
            ),
    );
  }
}
