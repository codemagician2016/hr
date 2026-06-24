// Leave data providers (SELF_ONLY /api/hr/me/leave/*): types, balances, my
// requests, history. The apply/cancel mutations live in the screen via the API
// client directly so they can refresh these.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/endpoints.dart';
import '../../core/providers.dart';
import '../../widgets/common.dart';

final leaveTypesProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final res = await api.get(Api.leaveTypes);
  return asList(res);
});

final leaveBalancesProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final res = await api.get(Api.leaveBalances);
  return asList(res, keys: const ['items', 'balances']);
});

final leaveRequestsProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final res = await api.get(Api.leaveRequests);
  return asList(res);
});
