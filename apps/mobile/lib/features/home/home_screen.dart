// Home / Dashboard — greeting, today's attendance status, at-a-glance stat cards
// (leave balance, latest payslip, pending tasks), a manager pending-approvals
// badge, quick-action tiles, pending-task list, and upcoming holidays. Mirrors
// apps/ess/app/page.js, plus the live clock status the mobile app uniquely has.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../attendance/attendance_providers.dart';
import '../attendance/punch_logic.dart';
import '../leave/leave_providers.dart';
import '../notifications/notifications_providers.dart';
import '../pay/pay_providers.dart';
import 'country_provider.dart';
import 'home_providers.dart';

String _greeting() {
  final h = DateTime.now().hour;
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

String _firstName(Map<String, dynamic>? me) {
  if (me == null) return 'there';
  final profile = me['profile'];
  final customer = me['customer'];
  final fn = (profile is Map ? profile['firstName'] : null) ??
      (customer is Map ? customer['name'] : null) ??
      me['firstName'];
  if (fn == null) return 'there';
  return fn.toString().split(' ').first;
}

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  Future<void> _refresh(WidgetRef ref) async {
    ref.invalidate(punchesProvider);
    ref.invalidate(leaveBalancesProvider);
    ref.invalidate(tasksProvider);
    ref.invalidate(pendingApprovalsCountProvider);
    ref.invalidate(upcomingHolidaysProvider);
    ref.invalidate(notificationsUnreadProvider);
    await ref.read(payslipsProvider((page: 1, pageSize: 1)).future);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(authControllerProvider).customer;
    final punches = ref.watch(punchesProvider).valueOrNull ?? const [];
    final balances = ref.watch(leaveBalancesProvider).valueOrNull;
    final latest = ref.watch(payslipsProvider((page: 1, pageSize: 1))).valueOrNull?.items;
    final tasks = ref.watch(tasksProvider).valueOrNull ?? const [];
    final approvalCount = ref.watch(pendingApprovalsCountProvider).valueOrNull ?? 0;
    final holidays = ref.watch(upcomingHolidaysProvider).valueOrNull ?? const [];
    final notifUnread = ref.watch(notificationsUnreadProvider).valueOrNull ?? 0;

    final clockedIn = isClockedIn(punches);
    final totalLeave = balances == null
        ? null
        : balances.fold<double>(
            0,
            (acc, b) => acc + Fmt.numOr0(b['available'] ?? b['balance'] ?? b['remaining']),
          );
    final latestSlip = (latest != null && latest.isNotEmpty) ? latest.first : null;

    return Scaffold(
      appBar: AppBar(
        title: const Text('DriftHR'),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 4),
            child: _NotificationsBell(count: notifUnread, onTap: () => context.push('/notifications')),
          ),
          if (approvalCount > 0)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: _ApprovalsBadge(count: approvalCount, onTap: () => context.push('/approvals')),
            ),
        ],
      ),
      body: RefreshIndicator(
        color: BrandColors.teal,
        onRefresh: () => _refresh(ref),
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text(_greeting(), style: const TextStyle(color: BrandColors.muted, fontSize: 14)),
            Text(_firstName(me),
                style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: BrandColors.text)),
            const SizedBox(height: 16),

            // Today's attendance status
            _AttendanceStatusCard(clockedIn: clockedIn, onTap: () => context.go('/attendance')),
            const SizedBox(height: 12),

            // Stat row
            Row(
              children: [
                Expanded(
                  child: _Stat(
                    label: 'Leave balance',
                    value: totalLeave != null ? Fmt.qty(totalLeave) : '—',
                    sub: 'days available',
                    onTap: () => context.go('/leave'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _Stat(
                    label: 'Latest payslip',
                    value: latestSlip != null
                        ? Fmt.money(latestSlip['net'] ?? latestSlip['netPay'] ?? latestSlip['netPayable'],
                            fallbackCurrency: (latestSlip['currency'] ?? 'INR').toString())
                        : '—',
                    sub: latestSlip != null ? Fmt.period(latestSlip['period'] ?? latestSlip) : 'No payslips yet',
                    onTap: () => latestSlip != null
                        ? context.push('/payslips/${latestSlip['id']}')
                        : context.go('/pay'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: _Stat(
                    label: 'Pending tasks',
                    value: '${tasks.length}',
                    sub: tasks.isEmpty ? 'all caught up' : 'need your action',
                  ),
                ),
                if (approvalCount > 0) ...[
                  const SizedBox(width: 12),
                  Expanded(
                    child: _Stat(
                      label: 'Approvals',
                      value: '$approvalCount',
                      sub: 'waiting for you',
                      onTap: () => context.push('/approvals'),
                    ),
                  ),
                ],
              ],
            ),

            // Pending tasks list
            if (tasks.isNotEmpty) ...[
              const SizedBox(height: 22),
              const SectionHeading(text: 'Needs your attention'),
              const SizedBox(height: 8),
              SectionCard(
                padding: EdgeInsets.zero,
                child: Column(
                  children: [
                    for (var i = 0; i < tasks.length; i++) ...[
                      if (i > 0) const Divider(height: 1),
                      ListTile(
                        title: Text((tasks[i]['title'] ?? 'Task').toString(),
                            style: const TextStyle(fontWeight: FontWeight.w600, color: BrandColors.text)),
                        subtitle: tasks[i]['sub'] != null
                            ? Text(tasks[i]['sub'].toString(),
                                style: const TextStyle(color: BrandColors.muted, fontSize: 12))
                            : null,
                        trailing: const Icon(Icons.chevron_right, color: BrandColors.teal),
                        onTap: () {}, // deep-link handled per-task type in a fuller build
                      ),
                    ],
                  ],
                ),
              ),
            ],

            // Quick actions
            const SizedBox(height: 22),
            const SectionHeading(text: 'Quick links'),
            const SizedBox(height: 10),
            const _QuickLinks(),

            // Upcoming holidays
            if (holidays.isNotEmpty) ...[
              const SizedBox(height: 22),
              const SectionHeading(text: 'Upcoming holidays'),
              const SizedBox(height: 8),
              SectionCard(
                padding: EdgeInsets.zero,
                child: Column(
                  children: [
                    for (var i = 0; i < holidays.length; i++) ...[
                      if (i > 0) const Divider(height: 1),
                      ListTile(
                        dense: true,
                        title: Text((holidays[i]['name'] ?? 'Holiday').toString(),
                            style: const TextStyle(color: BrandColors.text, fontWeight: FontWeight.w600)),
                        trailing: Text(
                          Fmt.date(holidays[i]['observedDate'] ?? holidays[i]['date']),
                          style: const TextStyle(color: BrandColors.muted, fontWeight: FontWeight.w600),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }
}

class _AttendanceStatusCard extends StatelessWidget {
  const _AttendanceStatusCard({required this.clockedIn, required this.onTap});

  final bool clockedIn;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(BrandRadii.lg),
      onTap: onTap,
      child: SectionCard(
        child: Row(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: clockedIn ? BrandColors.successSoft : BrandColors.tealSoft,
                borderRadius: BorderRadius.circular(BrandRadii.md),
              ),
              child: Icon(
                clockedIn ? Icons.work_history : Icons.access_time,
                color: clockedIn ? BrandColors.success : BrandColors.tealDark,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(clockedIn ? 'You are clocked in' : 'You are clocked out',
                      style: const TextStyle(fontWeight: FontWeight.w700, color: BrandColors.text)),
                  const Text('Tap to manage your attendance',
                      style: TextStyle(color: BrandColors.muted, fontSize: 12)),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, color: BrandColors.teal),
          ],
        ),
      ),
    );
  }
}

class _NotificationsBell extends StatelessWidget {
  const _NotificationsBell({required this.count, required this.onTap});

  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final bell = IconButton(
      onPressed: onTap,
      icon: const Icon(Icons.notifications_outlined, color: BrandColors.text),
      tooltip: 'Notifications',
    );
    if (count <= 0) return bell;
    return Badge.count(count: count, child: bell);
  }
}

class _ApprovalsBadge extends StatelessWidget {
  const _ApprovalsBadge({required this.count, required this.onTap});

  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Badge.count(
        count: count,
        child: const Icon(Icons.fact_check_outlined, color: BrandColors.text),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value, this.sub, this.onTap});

  final String label;
  final String value;
  final String? sub;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final card = SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(color: BrandColors.muted, fontSize: 12)),
          const SizedBox(height: 4),
          Text(value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: BrandColors.text)),
          if (sub != null)
            Text(sub!,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: BrandColors.muted, fontSize: 11)),
        ],
      ),
    );
    if (onTap == null) return card;
    return InkWell(borderRadius: BorderRadius.circular(BrandRadii.lg), onTap: onTap, child: card);
  }
}

class _QuickLinks extends ConsumerWidget {
  const _QuickLinks();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isIndia = ref.watch(countryContextProvider).valueOrNull?.isIndia ?? false;
    final tiles = <(IconData, String, String)>[
      (Icons.dynamic_feed_outlined, 'Feed', '/feed'),
      (Icons.payments_outlined, 'Payslips', '/pay'),
      (Icons.account_balance_wallet_outlined, 'My CTC', '/compensation'),
      (Icons.access_time, 'Attendance', '/attendance'),
      (Icons.event_available_outlined, 'Leave', '/leave'),
      if (isIndia) (Icons.calculate_outlined, 'Tax', '/tax'),
      (Icons.receipt_long_outlined, 'Expenses', '/expenses'),
      (Icons.description_outlined, 'Letters', '/letters'),
      (Icons.person_outline, 'Profile', '/profile'),
    ];
    return GridView.count(
      crossAxisCount: 3,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: 10,
      crossAxisSpacing: 10,
      childAspectRatio: 1.05,
      children: tiles.map((t) {
        return InkWell(
          borderRadius: BorderRadius.circular(BrandRadii.lg),
          onTap: () {
            // Tabs use go(); pushed routes use push().
            const tabs = {'/attendance', '/leave', '/pay'};
            if (tabs.contains(t.$3)) {
              context.go(t.$3);
            } else {
              context.push(t.$3);
            }
          },
          child: SectionCard(
            padding: const EdgeInsets.all(12),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Container(
                  width: 38,
                  height: 38,
                  decoration: BoxDecoration(
                    color: BrandColors.teal,
                    borderRadius: BorderRadius.circular(BrandRadii.md),
                  ),
                  child: Icon(t.$1, color: Colors.white, size: 20),
                ),
                const SizedBox(height: 8),
                Text(t.$2,
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 12.5, color: BrandColors.text)),
              ],
            ),
          ),
        );
      }).toList(),
    );
  }
}
