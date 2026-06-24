// Dashboard data providers: pending self-service tasks, pending-approvals count
// (manager badge), and upcoming holidays.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/endpoints.dart';
import '../../core/providers.dart';
import '../../widgets/common.dart';

/// Pending self-service tasks (onboarding / unsigned e-sign / asset acks).
final tasksProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final api = ref.watch(apiClientProvider);
  try {
    final res = await api.get(Api.meTasks);
    return asList(res, keys: const ['items', 'tasks']);
  } catch (_) {
    return const [];
  }
});

/// Count of approvals awaiting me — drives the manager badge on the dashboard.
final pendingApprovalsCountProvider = FutureProvider<int>((ref) async {
  final api = ref.watch(apiClientProvider);
  try {
    final res = await api.get(Api.approvals);
    return asList(res).length;
  } catch (_) {
    return 0;
  }
});

/// Upcoming holidays (next few) for the current year.
final upcomingHolidaysProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final api = ref.watch(apiClientProvider);
  try {
    final res = await api.get(Api.holidays, query: {'year': DateTime.now().year});
    final list = asList(res, keys: const ['items', 'holidays']);
    final today = DateTime.now();
    final cutoff = DateTime(today.year, today.month, today.day);
    final upcoming = list.where((h) {
      final d = DateTime.tryParse((h['observedDate'] ?? h['date'] ?? '').toString());
      return d != null && !d.isBefore(cutoff);
    }).toList()
      ..sort((a, b) {
        final da = DateTime.tryParse((a['observedDate'] ?? a['date'] ?? '').toString());
        final db = DateTime.tryParse((b['observedDate'] ?? b['date'] ?? '').toString());
        return (da?.millisecondsSinceEpoch ?? 0).compareTo(db?.millisecondsSinceEpoch ?? 0);
      });
    return upcoming.take(5).toList();
  } catch (_) {
    return const [];
  }
});
