// Comp-off data (SELF-scope /api/hr/me/comp-off/*). Two live FutureProviders: my
// aggregate balance ({ available, lotCount, soonestExpiry }) and my credit lots
// ({ credits:[…] }). This surface is READ-ONLY — availing a comp-off is an ordinary
// leave application on the COMP_OFF leave type, so there is no apply endpoint here.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/endpoints.dart';
import '../../core/providers.dart';
import '../../widgets/common.dart';

Map<String, dynamic> _asMap(dynamic v, [Map<String, dynamic> fallback = const {}]) =>
    v is Map ? v.cast<String, dynamic>() : fallback;

/// My aggregate comp-off balance.
final compOffBalanceProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  final res = await ref.watch(apiClientProvider).get(Api.compOffBalance);
  return _asMap(res, const {'available': 0, 'lotCount': 0, 'soonestExpiry': null});
});

/// My comp-off credit lots (earned lots with expiry), soonest-expiry first.
final compOffCreditsProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final res = await ref.watch(apiClientProvider).get(Api.compOffCredits);
  return asList(res, keys: const ['credits']);
});
