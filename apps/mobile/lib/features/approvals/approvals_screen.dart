// Approvals inbox (manager / any approver) — everything awaiting me across all
// modules, with inline Approve / Decline / Ask-for-changes + an optional note.
// Mirrors apps/ess/app/approvals/page.js. Data: GET /api/hr/me/approvals,
// POST /api/hr/me/approvals/:id/decide.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';

final approvalsProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final res = await api.get(Api.approvals);
  return asList(res);
});

const _moduleLabels = {
  'LEAVE': 'Leave request',
  'REIMBURSEMENT': 'Reimbursement',
  'EXPENSE': 'Reimbursement',
  'ATTENDANCE_REGULARIZATION': 'Attendance correction',
  'PROFILE_CHANGE': 'Profile change',
  'TIMESHEET': 'Timesheet',
  'TRIP': 'Travel',
};

String _moduleLabel(String? m) => _moduleLabels[m] ?? (m ?? 'Approval');

String _payloadLine(Map<String, dynamic> item) {
  final p = item['payload'];
  if (p is Map) {
    final who = p['employeeName'] ?? p['subjectName'] ?? p['name'];
    final summary = p['summary'] ?? p['title'];
    if (summary != null) return summary.toString();
    if (who != null) return 'From $who';
  }
  return item['summary']?.toString() ?? 'Awaiting your decision';
}

class ApprovalsScreen extends ConsumerWidget {
  const ApprovalsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(approvalsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Approvals')),
      body: AsyncView<List<Map<String, dynamic>>>(
        value: async,
        treat404AsEmpty: true,
        emptyText: 'Nothing is waiting for your approval right now.',
        onRefresh: () => ref.refresh(approvalsProvider.future),
        data: (items) {
          if (items.isEmpty) {
            return const EmptyView(
              icon: Icons.task_alt,
              text: "You're all caught up. Nothing is waiting for your approval.",
            );
          }
          return ListView.separated(
            padding: const EdgeInsets.all(16),
            itemCount: items.length,
            separatorBuilder: (_, __) => const SizedBox(height: 10),
            itemBuilder: (_, i) => _ApprovalCard(item: items[i]),
          );
        },
      ),
    );
  }
}

class _ApprovalCard extends ConsumerStatefulWidget {
  const _ApprovalCard({required this.item});

  final Map<String, dynamic> item;

  @override
  ConsumerState<_ApprovalCard> createState() => _ApprovalCardState();
}

class _ApprovalCardState extends ConsumerState<_ApprovalCard> {
  bool _acting = false;
  String? _done;
  String? _error;

  Future<void> _decide(String decision, {String? comment}) async {
    setState(() {
      _acting = true;
      _error = null;
    });
    try {
      final res = await ref.read(apiClientProvider).post(
        Api.approvalDecide(widget.item['id'].toString()),
        {'decision': decision, if (comment != null && comment.isNotEmpty) 'comment': comment},
      );
      final terminal = res is Map && res['terminal'] == true;
      setState(() {
        _done = decision == 'APPROVED'
            ? (terminal ? 'Approved' : 'Approved — moved to the next step')
            : decision == 'REJECTED'
                ? 'Declined'
                : 'Sent back for changes';
      });
    } on ApiException catch (e) {
      setState(() => _error = e.isUnauthorized || e.status == 403
          ? 'You are no longer an approver for this step.'
          : e.message);
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _withNote(String decision) async {
    final controller = TextEditingController();
    final note = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(decision == 'REQUESTED_CHANGES' ? 'Ask for changes' : 'Decline'),
        content: TextField(
          controller: controller,
          maxLines: 3,
          autofocus: true,
          decoration: InputDecoration(
            hintText: decision == 'REQUESTED_CHANGES' ? 'What needs changing?' : 'Add a note (optional)…',
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, controller.text), child: const Text('Confirm')),
        ],
      ),
    );
    if (note != null) await _decide(decision, comment: note);
  }

  @override
  Widget build(BuildContext context) {
    if (_done != null) {
      return SectionCard(
        child: Row(
          children: [
            const Icon(Icons.check_circle, color: BrandColors.success, size: 20),
            const SizedBox(width: 8),
            Expanded(
              child: Text('$_done. This request has been updated.',
                  style: const TextStyle(color: BrandColors.text)),
            ),
          ],
        ),
      );
    }

    final item = widget.item;
    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              CircleAvatar(
                radius: 18,
                backgroundColor: BrandColors.teal,
                child: const Icon(Icons.assignment_outlined, color: Colors.white, size: 18),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(_moduleLabel(item['module']?.toString()),
                        style: const TextStyle(fontWeight: FontWeight.w700, color: BrandColors.text)),
                    Text(_payloadLine(item),
                        style: const TextStyle(color: BrandColors.muted, fontSize: 12)),
                  ],
                ),
              ),
            ],
          ),
          if (item['payload'] is Map && (item['payload'] as Map)['reason'] != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text('“${(item['payload'] as Map)['reason']}”',
                  style: const TextStyle(fontStyle: FontStyle.italic, color: BrandColors.muted, fontSize: 12)),
            ),
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!, style: const TextStyle(color: BrandColors.danger, fontSize: 12)),
          ],
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              FilledButton(
                onPressed: _acting ? null : () => _decide('APPROVED'),
                style: FilledButton.styleFrom(
                  backgroundColor: BrandColors.success,
                  minimumSize: const Size(0, 38),
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                ),
                child: const Text('Approve'),
              ),
              OutlinedButton(
                onPressed: _acting ? null : () => _withNote('REQUESTED_CHANGES'),
                style: OutlinedButton.styleFrom(minimumSize: const Size(0, 38), padding: const EdgeInsets.symmetric(horizontal: 14)),
                child: const Text('Ask for changes'),
              ),
              OutlinedButton(
                onPressed: _acting ? null : () => _withNote('REJECTED'),
                style: OutlinedButton.styleFrom(
                  foregroundColor: BrandColors.danger,
                  side: const BorderSide(color: BrandColors.danger),
                  minimumSize: const Size(0, 38),
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                ),
                child: const Text('Decline'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
