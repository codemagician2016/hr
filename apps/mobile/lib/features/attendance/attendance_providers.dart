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

/// Feature 2 — the multi-mode capture policy that applies to ME. Tells the punch
/// flow which methods are required (so it knows to capture a selfie when FACE is on)
/// and whether my face is already enrolled. A failed fetch degrades to "no policy"
/// so the punch button never gets stuck behind a transient error.
final capturePolicyProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  final api = ref.watch(apiClientProvider);
  try {
    final res = await api.get(Api.capturePolicy);
    if (res is Map<String, dynamic>) return res;
  } catch (_) {/* degrade to empty policy */}
  return const {
    'requireGeo': false,
    'requireIp': false,
    'requireFace': false,
    'faceEnrolled': false,
  };
});
