// Rewards & Recognition data layer (SELF-scope /api/hr/me/*). Every surface is a
// live FutureProvider so a pull-to-refresh (invalidate) re-fetches — no offline
// cache, no accumulation. The give / redeem / nominate / cancel MUTATIONS live in
// the screens (they invalidate the affected providers on success).

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/providers.dart';
import '../../widgets/common.dart';

Map<String, dynamic> _asMap(dynamic v, [Map<String, dynamic> fallback = const {}]) =>
    v is Map ? v.cast<String, dynamic>() : fallback;

/// The kudos wall — my given + received recognitions, newest first. A giver sees
/// their own PENDING/REJECTED gives; a recipient only sees POSTED ones.
final recognitionWallProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final res = await ref.watch(apiClientProvider).get(
    Api.recognitions,
    query: {'direction': 'all', 'page': 1, 'pageSize': 30},
  );
  return asList(res);
});

/// The Give picker options — { values:[{id,name,icon,colorHex}], badges:[{id,name,icon,defaultPoints}] }.
/// Lazy-seeded server-side so a fresh tenant still gets the India-first defaults.
final giveOptionsProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  final res = await ref.watch(apiClientProvider).get(Api.recognitionValues);
  return _asMap(res, const {'values': [], 'badges': []});
});

/// My points wallet — { pointsEnabled, balance, lifetimeEarned, inrPerPoint, inrValue }.
final walletProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  final res = await ref.watch(apiClientProvider).get(Api.wallet);
  return _asMap(res);
});

/// The wallet ledger — signed earn/spend timeline.
final walletLedgerProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final res = await ref.watch(apiClientProvider).get(
    Api.walletLedger,
    query: {'page': 1, 'pageSize': 50},
  );
  return asList(res);
});

/// The rewards catalog — { pointsEnabled, balance, inrPerPoint, items:[…] }. Each
/// item carries `affordable` (vs my balance) + `inStock`, computed server-side.
final catalogProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  final res = await ref.watch(apiClientProvider).get(Api.catalog);
  return _asMap(res, const {'pointsEnabled': true, 'balance': 0, 'items': []});
});

/// My redemptions tracker (cancellable while PENDING).
final myRedemptionsProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final res = await ref.watch(apiClientProvider).get(Api.redemptions);
  return asList(res);
});

/// Award cycles currently open for nominations.
final awardCyclesProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final res = await ref.watch(apiClientProvider).get(Api.awardCycles);
  return asList(res);
});

/// My nominations — { made:[…], won:[…] }.
final myNominationsProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  final res = await ref.watch(apiClientProvider).get(Api.awardNominations);
  return _asMap(res, const {'made': [], 'won': []});
});

/// Leaderboard query key — a value-type record so Riverpod caches per (period, board).
typedef LeaderboardArgs = ({String period, String board});

/// The wall leaderboard — { board, period, rows:[{rank, points|count, name, code}], me }.
final leaderboardProvider =
    FutureProvider.family<Map<String, dynamic>, LeaderboardArgs>((ref, args) async {
  final res = await ref.watch(apiClientProvider).get(
    Api.recognitionLeaderboard,
    query: {'period': args.period, 'board': args.board},
  );
  return _asMap(res, const {'rows': [], 'me': null});
});

/// Directory search (the colleague picker). Debounced by the caller; a family keyed
/// on the trimmed query so identical searches share one in-flight request.
final directorySearchProvider =
    FutureProvider.family<List<Map<String, dynamic>>, String>((ref, query) async {
  final q = query.trim();
  if (q.isEmpty) return const [];
  try {
    final res = await ref.watch(apiClientProvider).get(
      Api.directory,
      query: {'q': q, 'pageSize': 8},
    );
    return asList(res);
  } on ApiException {
    return const [];
  }
});
