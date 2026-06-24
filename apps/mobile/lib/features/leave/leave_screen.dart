// Leave — balances (with a plain-English breakdown), an apply form (type / dates
// / half-day / reason, incl. LWP banner), and my requests with withdraw. Mirrors
// apps/ess/app/leave/page.js. Every call hits the SELF_ONLY /api/hr/me/leave/*.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/format.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';
import 'leave_providers.dart';

double _available(Map<String, dynamic> b) {
  if (b['available'] != null) return Fmt.numOr0(b['available']);
  return Fmt.numOr0(b['closing']) - Fmt.numOr0(b['pendingApproval']);
}

String _typeName(Map<String, dynamic> b) {
  final lt = b['leaveType'];
  return (lt is Map ? lt['name'] : null)?.toString() ??
      b['leaveTypeName']?.toString() ??
      b['name']?.toString() ??
      'Leave';
}

String _unit(Map<String, dynamic> b) {
  final lt = b['leaveType'];
  final raw = (lt is Map ? lt['unit'] : null) ?? b['unit'] ?? 'DAYS';
  final x = raw.toString().toLowerCase();
  if (x == 'weeks') return 'weeks';
  if (x == 'hours') return 'hours';
  return 'days';
}

class LeaveScreen extends ConsumerStatefulWidget {
  const LeaveScreen({super.key});

  @override
  ConsumerState<LeaveScreen> createState() => _LeaveScreenState();
}

class _LeaveScreenState extends ConsumerState<LeaveScreen> {
  Future<void> _refreshAll() async {
    await Future.wait([
      ref.refresh(leaveBalancesProvider.future),
      ref.refresh(leaveRequestsProvider.future),
      ref.refresh(leaveTypesProvider.future),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final balances = ref.watch(leaveBalancesProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Leave')),
      body: AsyncView<List<Map<String, dynamic>>>(
        value: balances,
        treat404AsEmpty: true,
        emptyText: 'No leave balances to show.',
        onRefresh: _refreshAll,
        data: (bals) => ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const SectionHeading(text: 'Your balances'),
            const SizedBox(height: 8),
            if (bals.isEmpty)
              const EmptyView(text: 'No leave balances to show.')
            else
              GridView.count(
                crossAxisCount: 2,
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                childAspectRatio: 1.5,
                mainAxisSpacing: 10,
                crossAxisSpacing: 10,
                children: bals.map(_BalanceCard.new).toList(),
              ),
            const SizedBox(height: 22),
            const SectionHeading(text: 'Apply for leave'),
            const SizedBox(height: 8),
            _ApplyForm(onApplied: _refreshAll),
            const SizedBox(height: 22),
            const SectionHeading(text: 'My requests'),
            const SizedBox(height: 8),
            const _MyRequests(),
            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }
}

class _BalanceCard extends StatelessWidget {
  const _BalanceCard(this.b);

  final Map<String, dynamic> b;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(_typeName(b),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: BrandColors.muted, fontSize: 12)),
          const SizedBox(height: 4),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(Fmt.qty(_available(b)),
                  style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: BrandColors.teal)),
              const SizedBox(width: 4),
              Flexible(
                child: Text('${_unit(b)} available',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: BrandColors.muted, fontSize: 11)),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            'Opening ${Fmt.qty(b['opening'])} · Taken ${Fmt.qty(b['taken'])}',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(color: BrandColors.muted, fontSize: 10.5),
          ),
        ],
      ),
    );
  }
}

class _ApplyForm extends ConsumerStatefulWidget {
  const _ApplyForm({required this.onApplied});

  final Future<void> Function() onApplied;

  @override
  ConsumerState<_ApplyForm> createState() => _ApplyFormState();
}

class _ApplyFormState extends ConsumerState<_ApplyForm> {
  String? _typeId;
  DateTime? _start;
  DateTime? _end;
  String _startHalf = '';
  String _endHalf = '';
  final _reason = TextEditingController();
  bool _submitting = false;
  String? _error;
  bool _success = false;

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  bool _isLwp(Map<String, dynamic>? t) {
    if (t == null) return false;
    return t['category'] == 'UNPAID' || t['affectsLOP'] == true || t['isPaid'] == false;
  }

  Future<void> _pick(bool isStart) async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: (isStart ? _start : _end) ?? now,
      firstDate: DateTime(now.year - 1),
      lastDate: DateTime(now.year + 2),
    );
    if (picked != null) {
      setState(() {
        if (isStart) {
          _start = picked;
          if (_end != null && _end!.isBefore(picked)) _end = picked;
        } else {
          _end = picked;
        }
      });
    }
  }

  Future<void> _submit(List<Map<String, dynamic>> types) async {
    final t = types.where((e) => e['id'] == _typeId).firstOrNull;
    final reasonRequired = t?['requiresReason'] == true;
    if (_typeId == null || _start == null || _end == null) {
      setState(() => _error = 'Pick a leave type and your dates.');
      return;
    }
    if (reasonRequired && _reason.text.trim().isEmpty) {
      setState(() => _error = 'This leave type needs a reason.');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
      _success = false;
    });
    try {
      await ref.read(apiClientProvider).post(Api.leaveRequests, {
        'leaveTypeId': _typeId,
        'startDate': Fmt.dayKey(_start!),
        'endDate': Fmt.dayKey(_end!),
        if (_startHalf.isNotEmpty) 'startHalf': _startHalf,
        if (_endHalf.isNotEmpty) 'endHalf': _endHalf,
        'reason': _reason.text.trim(),
      });
      setState(() {
        _success = true;
        _reason.clear();
        _start = null;
        _end = null;
        _typeId = null;
        _startHalf = '';
        _endHalf = '';
      });
      await widget.onApplied();
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not submit your leave request.');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final typesAsync = ref.watch(leaveTypesProvider);
    return SectionCard(
      child: typesAsync.when(
        loading: () => const Padding(
            padding: EdgeInsets.symmetric(vertical: 16), child: Center(child: CircularProgressIndicator())),
        error: (_, __) => const Text('Could not load leave types.', style: TextStyle(color: BrandColors.danger)),
        data: (types) {
          final selected = types.where((e) => e['id'] == _typeId).firstOrNull;
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (_error != null) ...[ErrorBanner(message: _error!), const SizedBox(height: 12)],
              if (_success) ...[const SuccessBanner(message: 'Leave request submitted.'), const SizedBox(height: 12)],
              DropdownButtonFormField<String>(
                value: _typeId,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Leave type'),
                hint: const Text('Select a type'),
                items: types
                    .map((t) => DropdownMenuItem(
                          value: t['id'].toString(),
                          child: Text((t['name'] ?? t['label'] ?? 'Leave').toString()),
                        ))
                    .toList(),
                onChanged: (v) => setState(() => _typeId = v),
              ),
              if (_isLwp(selected)) ...[
                const SizedBox(height: 10),
                const _LwpBanner(),
              ],
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(child: _DateField(label: 'From', value: _start, onTap: () => _pick(true))),
                  const SizedBox(width: 10),
                  Expanded(child: _DateField(label: 'To', value: _end, onTap: () => _pick(false))),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: DropdownButtonFormField<String>(
                      value: _startHalf.isEmpty ? '' : _startHalf,
                      isExpanded: true,
                      decoration: const InputDecoration(labelText: 'Start', isDense: true),
                      items: const [
                        DropdownMenuItem(value: '', child: Text('Full day')),
                        DropdownMenuItem(value: 'SECOND_HALF', child: Text('2nd half only')),
                      ],
                      onChanged: (v) => setState(() => _startHalf = v ?? ''),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: DropdownButtonFormField<String>(
                      value: _endHalf.isEmpty ? '' : _endHalf,
                      isExpanded: true,
                      decoration: const InputDecoration(labelText: 'End', isDense: true),
                      items: const [
                        DropdownMenuItem(value: '', child: Text('Full day')),
                        DropdownMenuItem(value: 'FIRST_HALF', child: Text('1st half only')),
                      ],
                      onChanged: (v) => setState(() => _endHalf = v ?? ''),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _reason,
                maxLines: 3,
                decoration: InputDecoration(
                  labelText: selected?['requiresReason'] == true ? 'Reason (required)' : 'Reason',
                  alignLabelWithHint: true,
                ),
              ),
              const SizedBox(height: 14),
              FilledButton(
                onPressed: _submitting ? null : () => _submit(types),
                child: _submitting
                    ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : const Text('Submit request'),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _LwpBanner extends StatelessWidget {
  const _LwpBanner();

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: BrandColors.warningSoft,
          borderRadius: BorderRadius.circular(BrandRadii.sm),
          border: Border.all(color: BrandColors.border),
        ),
        child: const Text(
          'Leave Without Pay. This reduces your salary for the days taken. You do not need a leave balance.',
          style: TextStyle(fontSize: 12, color: BrandColors.text),
        ),
      );
}

class _DateField extends StatelessWidget {
  const _DateField({required this.label, required this.value, required this.onTap});

  final String label;
  final DateTime? value;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => InkWell(
        onTap: onTap,
        child: InputDecorator(
          decoration: InputDecoration(labelText: label, isDense: true),
          child: Text(
            value == null ? 'Select' : Fmt.date(value),
            style: TextStyle(
              color: value == null ? BrandColors.muted : BrandColors.text,
              fontSize: 14,
            ),
          ),
        ),
      );
}

class _MyRequests extends ConsumerWidget {
  const _MyRequests();

  Future<void> _withdraw(WidgetRef ref, BuildContext context, String id) async {
    try {
      await ref.read(apiClientProvider).post(Api.leaveCancel(id), {});
      ref.invalidate(leaveRequestsProvider);
      ref.invalidate(leaveBalancesProvider);
    } on ApiException catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(leaveRequestsProvider);
    return async.when(
      loading: () => const LoadingView(),
      error: (_, __) => const EmptyView(text: 'You have no leave requests yet.'),
      data: (reqs) {
        if (reqs.isEmpty) return const EmptyView(text: 'You have no leave requests yet.');
        return Column(
          children: reqs.map((r) {
            final lt = r['leaveType'];
            final name = (lt is Map ? lt['name'] : null)?.toString() ?? 'Leave';
            final status = r['status']?.toString() ?? '';
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
                          Text('$name · ${Fmt.qty(r['quantity'])} ${_unit(r.cast<String, dynamic>())}',
                              style: const TextStyle(fontWeight: FontWeight.w600, color: BrandColors.text)),
                          const SizedBox(height: 2),
                          Text(
                            '${r['startDate'].toString().substring(0, 10)} → ${r['endDate'].toString().substring(0, 10)}',
                            style: const TextStyle(color: BrandColors.muted, fontSize: 12),
                          ),
                        ],
                      ),
                    ),
                    StatusPill.forStatus(status),
                    if (status == 'PENDING')
                      TextButton(
                        onPressed: () => _withdraw(ref, context, r['id'].toString()),
                        child: const Text('Withdraw'),
                      ),
                  ],
                ),
              ),
            );
          }).toList(),
        );
      },
    );
  }
}
