// Attendance — clock IN/OUT/break capturing geolocation, today's status &
// punches, this-period stats, and a regularization (correction) request.
// Mirrors apps/ess/app/attendance/page.js (Clock + Corrections sections),
// adding the mobile-native geolocation the web cannot do. The punch body carries
// `{ type }` plus best-effort lat/long (the server accepts + ignores extras).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/format.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';
import 'attendance_providers.dart';
import 'geo.dart';
import 'punch_logic.dart';
import 'selfie.dart';

const _correctionKinds = [
  ('MISSED_PUNCH', 'Missed punch'),
  ('WFH', 'Work from home'),
  ('ON_DUTY', 'On duty'),
  ('LATE_WAIVER', 'Late waiver'),
  ('EARLY_OUT_WAIVER', 'Early-out waiver'),
];

class AttendanceScreen extends ConsumerStatefulWidget {
  const AttendanceScreen({super.key});

  @override
  ConsumerState<AttendanceScreen> createState() => _AttendanceScreenState();
}

class _AttendanceScreenState extends ConsumerState<AttendanceScreen> {
  bool _busy = false;

  Future<void> _refresh() => ref.refresh(punchesProvider.future);

  Future<void> _punch(String type) async {
    // Resolve the capture policy first so we know whether to prompt for a selfie.
    final policy = ref.read(capturePolicyProvider).asData?.value ?? const {};
    final requireFace = policy['requireFace'] == true;
    // Feature 39 — faceEnrolled means an HR-APPROVED reference; faceStatus
    // carries the lifecycle so a pending/rejected registration gets the right
    // message instead of a generic "set up face" loop.
    final faceEnrolled = policy['faceEnrolled'] == true;
    final faceStatus = (policy['faceStatus'] as String?) ?? (faceEnrolled ? 'ACTIVE' : 'NONE');

    // FACE required but no approved reference → route/inform per lifecycle state.
    if (requireFace && !faceEnrolled) {
      if (mounted) {
        final msg = switch (faceStatus) {
          'PENDING' => 'Your face registration is awaiting HR approval — face check-in activates once approved.',
          'REJECTED' => 'HR declined your face registration — retake your photo to punch with face.',
          'REVOKED' => 'Your face registration was revoked — submit a new photo.',
          _ => 'Set up face recognition before punching.',
        };
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
        context.push('/face-enrollment');
      }
      return;
    }

    setState(() => _busy = true);
    final geo = await Geo.currentPosition();

    // Capture a selfie when FACE is required (front camera → base64 data URL).
    String? selfieDataUrl;
    if (requireFace) {
      final shot = await Selfie.capture();
      if (!shot.ok) {
        // No selfie captured. When FACE is enforced the server will reject; surface
        // the camera error and abort rather than silently punch.
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(shot.error ?? 'A selfie is required to punch.')),
          );
          setState(() => _busy = false);
        }
        return;
      }
      selfieDataUrl = shot.dataUrl;
    }

    try {
      final body = <String, dynamic>{
        'type': type,
        // Backend reads geoLat/geoLng (the geofence + IP_RESTRICTED policy keys off
        // the server-side req.ip, so no IP is sent from the app).
        if (geo.position != null) 'geoLat': geo.position!.latitude,
        if (geo.position != null) 'geoLng': geo.position!.longitude,
        if (selfieDataUrl != null) 'selfieDataUrl': selfieDataUrl,
      };
      final res = await ref.read(apiClientProvider).post(Api.punch, body);
      ref.invalidate(punchesProvider);
      if (!mounted) return;
      // A flagged-but-accepted punch (warn mode) → tell the user it's pending review.
      final flagged = res is Map && res['captureFlagged'] == true;
      if (flagged) {
        final reasons = (res['captureFlagReasons'] as List?)?.join(', ') ?? '';
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Punch recorded but flagged for review${reasons.isNotEmpty ? ' ($reasons)' : ''}.')),
        );
      } else if (geo.error != null) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(geo.error!)));
      }
    } on ApiException catch (e) {
      if (mounted) {
        // A 403 CAPTURE_POLICY rejection (enforce mode) carries a clear message.
        final reason = e.body?['reason'];
        final msg = reason == 'CAPTURE_POLICY'
            ? 'Punch blocked: ${e.message}'
            : e.message;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(punchesProvider);
    final policy = ref.watch(capturePolicyProvider).asData?.value ?? const {};
    return Scaffold(
      appBar: AppBar(
        title: const Text('Attendance'),
        actions: [
          IconButton(
            tooltip: 'Request a correction',
            icon: const Icon(Icons.edit_calendar_outlined),
            onPressed: () => _openRegularization(context),
          ),
        ],
      ),
      body: AsyncView<List<Map<String, dynamic>>>(
        value: async,
        treat404AsEmpty: true,
        emptyText: 'No attendance recorded yet.',
        onRefresh: _refresh,
        data: (all) {
          final clockedIn = isClockedIn(all);
          final lastType = lastPunchTypeToday(all);
          final today = todaysPunches(all);
          final todayWorked = fmtWorked(workedFromPairs(pairsForDay(today)));
          final periodWorked = fmtWorked(workedFromPairs(pairsForDay(all)));
          final daysPresent = all
              .map((p) {
                final at = DateTime.tryParse((p['punchAt'] ?? '').toString());
                return at == null ? '' : Fmt.dayKey(at);
              })
              .where((k) => k.isNotEmpty)
              .toSet()
              .length;

          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              _ClockCard(
                clockedIn: clockedIn,
                lastType: lastType,
                todayWorked: todayWorked,
                busy: _busy,
                onPunch: _punch,
                requireGeo: policy['requireGeo'] == true,
                requireIp: policy['requireIp'] == true,
                requireFace: policy['requireFace'] == true,
                faceEnrolled: policy['faceEnrolled'] == true,
                faceStatus: (policy['faceStatus'] as String?) ?? 'NONE',
                onSetupFace: () => context.push('/face-enrollment'),
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(child: _StatTile(label: 'This period worked', value: periodWorked)),
                  const SizedBox(width: 12),
                  Expanded(child: _StatTile(label: 'Days present', value: '$daysPresent')),
                ],
              ),
              const SizedBox(height: 8),
              const Text(
                'These figures are indicative. Your payable days are confirmed when the period is locked.',
                style: TextStyle(color: BrandColors.muted, fontSize: 11),
              ),
              const SizedBox(height: 20),
              const SectionHeading(text: "Today's punches"),
              const SizedBox(height: 8),
              if (today.isEmpty)
                const EmptyView(text: 'No punches recorded today.')
              else
                SectionCard(
                  padding: EdgeInsets.zero,
                  child: Column(
                    children: [
                      for (var i = 0; i < today.length; i++) ...[
                        if (i > 0) const Divider(height: 1),
                        ListTile(
                          dense: true,
                          title: Text(
                            punchLabels[today[i]['punchType']] ?? today[i]['punchType'].toString(),
                            style: const TextStyle(color: BrandColors.text, fontSize: 14),
                          ),
                          trailing: Text(
                            Fmt.time(today[i]['punchAt']),
                            style: const TextStyle(color: BrandColors.muted, fontWeight: FontWeight.w600),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              const SizedBox(height: 20),
              const _CorrectionsList(),
              const SizedBox(height: 24),
            ],
          );
        },
      ),
    );
  }

  void _openRegularization(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: BrandColors.card,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: _RegularizationSheet(
          onSubmitted: () => ref.invalidate(regularizationsProvider),
        ),
      ),
    );
  }
}

class _ClockCard extends StatelessWidget {
  const _ClockCard({
    required this.clockedIn,
    required this.lastType,
    required this.todayWorked,
    required this.busy,
    required this.onPunch,
    required this.requireGeo,
    required this.requireIp,
    required this.requireFace,
    required this.faceEnrolled,
    required this.faceStatus,
    required this.onSetupFace,
  });

  final bool clockedIn;
  final String? lastType;
  final String todayWorked;
  final bool busy;
  final Future<void> Function(String) onPunch;
  final bool requireGeo;
  final bool requireIp;
  final bool requireFace;
  final bool faceEnrolled;
  final String faceStatus; // Feature 39 lifecycle: NONE|PENDING|ACTIVE|REJECTED|REVOKED
  final VoidCallback onSetupFace;

  @override
  Widget build(BuildContext context) {
    final methods = <String>[
      if (requireGeo) 'Geo-fence',
      if (requireIp) 'Office network',
      if (requireFace) 'Face match',
    ];
    return SectionCard(
      child: Column(
        children: [
          if (methods.isNotEmpty) ...[
            Wrap(
              spacing: 6,
              runSpacing: 6,
              alignment: WrapAlignment.center,
              children: methods
                  .map((m) => Chip(
                        label: Text(m, style: const TextStyle(fontSize: 11)),
                        visualDensity: VisualDensity.compact,
                        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        backgroundColor: BrandColors.tealSoft,
                        side: BorderSide.none,
                      ))
                  .toList(),
            ),
            const SizedBox(height: 4),
            const Text('Required to punch', style: TextStyle(color: BrandColors.muted, fontSize: 10)),
            const SizedBox(height: 10),
          ],
          if (requireFace && !faceEnrolled) ...[
            InkWell(
              onTap: onSetupFace,
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: BrandColors.warning.withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(BrandRadii.md),
                  border: Border.all(color: BrandColors.warning.withValues(alpha: 0.3)),
                ),
                child: Row(
                  children: [
                    Icon(
                      faceStatus == 'PENDING'
                          ? Icons.hourglass_top_outlined
                          : Icons.face_retouching_natural,
                      size: 18,
                      color: BrandColors.warning,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        switch (faceStatus) {
                          'PENDING' => 'Face registration awaiting HR approval',
                          'REJECTED' => 'Face registration declined — retake your photo',
                          'REVOKED' => 'Face registration revoked — submit a new photo',
                          _ => 'Set up face recognition to punch',
                        },
                        style: const TextStyle(fontSize: 12, color: BrandColors.text),
                      ),
                    ),
                    const Icon(Icons.chevron_right, size: 18, color: BrandColors.muted),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 12),
          ],
          Text(
            clockedIn ? 'You are clocked in' : 'You are clocked out',
            style: const TextStyle(color: BrandColors.muted, fontSize: 12, letterSpacing: 0.5),
          ),
          const SizedBox(height: 4),
          Text(todayWorked,
              style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800, color: BrandColors.text)),
          const Text('worked today', style: TextStyle(color: BrandColors.muted, fontSize: 12)),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: FilledButton(
                  onPressed: (busy || clockedIn) ? null : () => onPunch('IN'),
                  child: busy
                      ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : const Text('Clock in'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: OutlinedButton(
                  onPressed: (busy || !clockedIn) ? null : () => onPunch('OUT'),
                  child: const Text('Clock out'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: TextButton(
                  onPressed: (busy || !clockedIn) ? null : () => onPunch('BREAK_START'),
                  child: const Text('Start break'),
                ),
              ),
              Expanded(
                child: TextButton(
                  onPressed: (busy || lastType != 'BREAK_START') ? null : () => onPunch('BREAK_END'),
                  child: const Text('End break'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.location_on_outlined, size: 13, color: BrandColors.muted),
              const SizedBox(width: 4),
              Text(
                requireFace
                    ? 'Location + a selfie are captured with each punch.'
                    : 'Your location is captured with each punch.',
                style: const TextStyle(color: BrandColors.muted, fontSize: 11),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _StatTile extends StatelessWidget {
  const _StatTile({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => SectionCard(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: const TextStyle(color: BrandColors.muted, fontSize: 12)),
            const SizedBox(height: 2),
            Text(value, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: BrandColors.teal)),
          ],
        ),
      );
}

class _CorrectionsList extends ConsumerWidget {
  const _CorrectionsList();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(regularizationsProvider);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SectionHeading(text: 'My corrections'),
        const SizedBox(height: 8),
        async.when(
          loading: () => const LoadingView(),
          error: (_, __) => const EmptyView(text: "You haven't raised any corrections yet."),
          data: (list) {
            if (list.isEmpty) return const EmptyView(text: "You haven't raised any corrections yet.");
            return Column(
              children: list.map((r) {
                final kind = _correctionKinds
                        .where((k) => k.$1 == r['kind'])
                        .map((k) => k.$2)
                        .firstOrNull ??
                    (r['kind'] ?? 'Correction').toString();
                return Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: SectionCard(
                    padding: const EdgeInsets.all(12),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('${Fmt.date(r['date'] ?? r['forDate'] ?? r['createdAt'])} · $kind',
                                  style: const TextStyle(fontWeight: FontWeight.w600, color: BrandColors.text)),
                              if (r['reason'] != null)
                                Padding(
                                  padding: const EdgeInsets.only(top: 2),
                                  child: Text(r['reason'].toString(),
                                      style: const TextStyle(color: BrandColors.muted, fontSize: 12)),
                                ),
                            ],
                          ),
                        ),
                        StatusPill.forStatus(r['status']?.toString()),
                      ],
                    ),
                  ),
                );
              }).toList(),
            );
          },
        ),
      ],
    );
  }
}

class _RegularizationSheet extends ConsumerStatefulWidget {
  const _RegularizationSheet({required this.onSubmitted});

  final VoidCallback onSubmitted;

  @override
  ConsumerState<_RegularizationSheet> createState() => _RegularizationSheetState();
}

class _RegularizationSheetState extends ConsumerState<_RegularizationSheet> {
  DateTime _date = DateTime.now();
  TimeOfDay? _inAt;
  TimeOfDay? _outAt;
  String _kind = 'MISSED_PUNCH';
  final _reason = TextEditingController();
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  String? _instant(TimeOfDay? t) {
    if (t == null) return null;
    final dt = DateTime(_date.year, _date.month, _date.day, t.hour, t.minute);
    return dt.toUtc().toIso8601String();
  }

  Future<void> _submit() async {
    if (_reason.text.trim().isEmpty) {
      setState(() => _error = 'Please give a reason for this request.');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await ref.read(apiClientProvider).post(Api.regularizations, {
        'date': Fmt.dayKey(_date),
        'requestedInAt': _instant(_inAt),
        'requestedOutAt': _instant(_outAt),
        'kind': _kind,
        'reason': _reason.text.trim(),
      });
      widget.onSubmitted();
      if (mounted) {
        Navigator.of(context).pop();
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Request sent to your manager for approval.')),
        );
      }
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not submit your request.');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Regularization request',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: BrandColors.text)),
          const SizedBox(height: 14),
          if (_error != null) ...[ErrorBanner(message: _error!), const SizedBox(height: 12)],
          InkWell(
            onTap: () async {
              final picked = await showDatePicker(
                context: context,
                initialDate: _date,
                firstDate: DateTime(_date.year - 1),
                lastDate: DateTime.now(),
              );
              if (picked != null) setState(() => _date = picked);
            },
            child: InputDecorator(
              decoration: const InputDecoration(labelText: 'Date'),
              child: Text(Fmt.date(_date)),
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(child: _TimePick(label: 'Corrected in-time', value: _inAt, onPick: (t) => setState(() => _inAt = t))),
              const SizedBox(width: 10),
              Expanded(child: _TimePick(label: 'Corrected out-time', value: _outAt, onPick: (t) => setState(() => _outAt = t))),
            ],
          ),
          const SizedBox(height: 10),
          DropdownButtonFormField<String>(
            value: _kind,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Reason type'),
            items: _correctionKinds
                .map((k) => DropdownMenuItem(value: k.$1, child: Text(k.$2)))
                .toList(),
            onChanged: (v) => setState(() => _kind = v ?? 'MISSED_PUNCH'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _reason,
            maxLines: 2,
            decoration: const InputDecoration(
              labelText: 'Reason',
              hintText: 'Why is this correction needed?',
            ),
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _submitting ? null : _submit,
            child: _submitting
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Text('Send request'),
          ),
        ],
      ),
    );
  }
}

class _TimePick extends StatelessWidget {
  const _TimePick({required this.label, required this.value, required this.onPick});

  final String label;
  final TimeOfDay? value;
  final ValueChanged<TimeOfDay> onPick;

  @override
  Widget build(BuildContext context) => InkWell(
        onTap: () async {
          final t = await showTimePicker(context: context, initialTime: value ?? TimeOfDay.now());
          if (t != null) onPick(t);
        },
        child: InputDecorator(
          decoration: InputDecoration(labelText: label, isDense: true),
          child: Text(
            value == null ? '—' : value!.format(context),
            style: TextStyle(color: value == null ? BrandColors.muted : BrandColors.text),
          ),
        ),
      );
}
