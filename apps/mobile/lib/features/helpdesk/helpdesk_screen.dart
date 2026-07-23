// Helpdesk — my tickets. A list of raised tickets with a status chip, priority,
// category, an SLA-breach flag, and the public-reply count. A "Raise" FAB opens the
// create flow; tapping a row opens the ticket thread. SELF-only /api/hr/me/helpdesk.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';
import 'helpdesk_common.dart';
import 'helpdesk_providers.dart';

class HelpdeskScreen extends ConsumerWidget {
  const HelpdeskScreen({super.key});

  Future<void> _refresh(WidgetRef ref) async {
    ref.invalidate(helpdeskTicketsProvider);
    await ref.read(helpdeskTicketsProvider.future);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(helpdeskTicketsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Helpdesk')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => context.push('/helpdesk/new'),
        backgroundColor: BrandColors.teal,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.add),
        label: const Text('Raise'),
      ),
      body: AsyncView<List<Map<String, dynamic>>>(
        value: async,
        treat404AsEmpty: true,
        emptyText: 'You have not raised any tickets yet.',
        onRefresh: () => _refresh(ref),
        data: (items) {
          if (items.isEmpty) {
            return ListView(
              children: const [
                SizedBox(height: 80),
                EmptyView(
                  icon: Icons.support_agent_outlined,
                  text: 'No tickets yet.\nTap Raise to ask HR or IT for help.',
                ),
              ],
            );
          }
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              ...items.map((t) => _TicketTile(ticket: t)),
              const SizedBox(height: 88),
            ],
          );
        },
      ),
    );
  }
}

class _TicketTile extends StatelessWidget {
  const _TicketTile({required this.ticket});

  final Map<String, dynamic> ticket;

  @override
  Widget build(BuildContext context) {
    final t = ticket;
    final id = t['id'].toString();
    final code = (t['code'] ?? '').toString();
    final subject = (t['subject'] ?? 'Ticket').toString();
    final status = (t['status'] ?? '').toString();
    final priority = (t['priority'] ?? '').toString();
    final breached = t['breached'] == true;
    final category = t['category'] is Map ? (t['category'] as Map)['name']?.toString() : null;
    final count = t['_count'] is Map ? (t['_count'] as Map)['messages'] : null;

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        borderRadius: BorderRadius.circular(BrandRadii.lg),
        onTap: () => context.push('/helpdesk/$id'),
        child: SectionCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Text(subject,
                        style: const TextStyle(
                            fontSize: 15, fontWeight: FontWeight.w800, color: BrandColors.text)),
                  ),
                  const SizedBox(width: 8),
                  helpdeskStatusPill(status),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                [
                  if (code.isNotEmpty) code,
                  if (category != null && category.isNotEmpty) category,
                  'Updated ${Fmt.date(t['updatedAt'] ?? t['createdAt'])}',
                ].where((s) => s.isNotEmpty).join(' · '),
                style: const TextStyle(color: BrandColors.muted, fontSize: 12),
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  PriorityChip(priority: priority),
                  const SizedBox(width: 8),
                  if (breached) ...[
                    const _BreachBadge(),
                    const SizedBox(width: 8),
                  ],
                  const Spacer(),
                  if (count != null) ...[
                    const Icon(Icons.forum_outlined, size: 15, color: BrandColors.muted),
                    const SizedBox(width: 4),
                    Text('$count',
                        style: const TextStyle(color: BrandColors.muted, fontSize: 12.5)),
                  ],
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _BreachBadge extends StatelessWidget {
  const _BreachBadge();

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        decoration: BoxDecoration(
          color: BrandColors.dangerSoft,
          borderRadius: BorderRadius.circular(BrandRadii.pill),
        ),
        child: const Row(
          children: [
            Icon(Icons.timer_outlined, size: 12, color: BrandColors.danger),
            SizedBox(width: 3),
            Text('SLA breached',
                style: TextStyle(color: BrandColors.danger, fontSize: 11, fontWeight: FontWeight.w700)),
          ],
        ),
      );
}
