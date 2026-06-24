// Attendance — clock IN/OUT/break capturing geolocation, today's status &
// punches, this-period stats, and a regularization (correction) request.
// Mirrors apps/ess/app/attendance/page.js (Clock + Corrections sections),
// adding the mobile-native geolocation the web cannot do. The punch body carries
// `{ type }` plus best-effort lat/long (the server accepts + ignores extras).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

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
    setState(() => _busy = true);
    final geo = await Geo.currentPosition();
    try {
      await ref.read(apiClientProvider).post(Api.punch, {
        'type': type,
        ...geo.coords, // best-effort lat/long; server tolerates extras
      });
      ref.invalidate(punchesProvider);
      if (mounted && geo.error != null) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(geo.error!)));
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(punchesProvider);
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
  });

  final bool clockedIn;
  final String? lastType;
  final String todayWorked;
  final bool busy;
  final Future<void> Function(String) onPunch;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      child: Column(
        children: [
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
          const Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.location_on_outlined, size: 13, color: BrandColors.muted),
              SizedBox(width: 4),
              Text('Your location is captured with each punch.',
                  style: TextStyle(color: BrandColors.muted, fontSize: 11)),
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
