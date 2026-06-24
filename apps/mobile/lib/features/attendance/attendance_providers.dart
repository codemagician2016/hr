// Attendance data providers (SELF_ONLY /api/hr/me/attendance/*): this-period
// punches, schedule, regularizations.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/endpoints.dart';
import '../../core/providers.dart';
import '../../widgets/common.dart';

DateTime _startOfPeriod() {
  final d = DateTime.now();
  return DateTime(d.year, d.month, 1);
}

DateTime _endOfToday() {
  final d = DateTime.now();
  return DateTime(d.year, d.month, d.day, 23, 59, 59, 999);
}

/// Punches from the 1st of the month through end of today — powers the clock
/// state, today's-punches list, and the worked/days-present stats.
final punchesProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final res = await api.get(Api.punches, query: {
    'from': _startOfPeriod().toUtc().toIso8601String(),
    'to': _endOfToday().toUtc().toIso8601String(),
    'pageSize': 200,
  });
  return asList(res, keys: const ['items', 'punches']);
});

final scheduleProvider = FutureProvider<Map<String, dynamic>?>((ref) async {
  final api = ref.watch(apiClientProvider);
  final res = await api.get(Api.schedule);
  if (res is Map<String, dynamic> && res['shift'] != null) return res;
  return null;
});

final regularizationsProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final res = await api.get(Api.regularizations);
  return asList(res, keys: const ['items', 'requests']);
});
