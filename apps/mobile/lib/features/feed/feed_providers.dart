// Engagement feed data layer (SELF-scope /api/hr/me/engagement/*).
//
// The wall is paginated with load-more, so it is driven by a small StateNotifier
// (FeedController) that accumulates pages and lets the screen patch a single row
// in place after a reaction/read/comment mutation — no full refetch for a tap.
// Celebrations + a post's comment thread are plain live FutureProviders.

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/endpoints.dart';
import '../../core/providers.dart';
import '../../widgets/common.dart';

const int kFeedPageSize = 10;

@immutable
class FeedState {
  const FeedState({
    this.items = const [],
    this.total = 0,
    this.page = 0,
    this.loading = true,
    this.loadingMore = false,
    this.error,
  });

  final List<Map<String, dynamic>> items;
  final int total;
  final int page;
  final bool loading;
  final bool loadingMore;
  final Object? error;

  bool get hasMore => items.length < total;

  FeedState copyWith({
    List<Map<String, dynamic>>? items,
    int? total,
    int? page,
    bool? loading,
    bool? loadingMore,
    Object? error,
    bool clearError = false,
  }) =>
      FeedState(
        items: items ?? this.items,
        total: total ?? this.total,
        page: page ?? this.page,
        loading: loading ?? this.loading,
        loadingMore: loadingMore ?? this.loadingMore,
        error: clearError ? null : (error ?? this.error),
      );
}

class FeedController extends StateNotifier<FeedState> {
  FeedController(this._ref) : super(const FeedState()) {
    refresh();
  }

  final Ref _ref;

  Future<void> refresh() async {
    try {
      final res = await _ref.read(apiClientProvider).get(
        Api.feed,
        query: {'page': 1, 'pageSize': kFeedPageSize},
      );
      final page = asPage(res);
      state = FeedState(
        items: page.items,
        total: page.total,
        page: 1,
        loading: false,
      );
    } catch (e) {
      state = state.copyWith(loading: false, error: e);
    }
  }

  Future<void> loadMore() async {
    if (state.loadingMore || !state.hasMore) return;
    state = state.copyWith(loadingMore: true, clearError: true);
    try {
      final next = state.page + 1;
      final res = await _ref.read(apiClientProvider).get(
        Api.feed,
        query: {'page': next, 'pageSize': kFeedPageSize},
      );
      final page = asPage(res);
      // De-dup by id in case a new pinned post shifted the window between pages.
      final seen = state.items.map((e) => e['id']).toSet();
      final merged = [
        ...state.items,
        ...page.items.where((e) => !seen.contains(e['id'])),
      ];
      state = state.copyWith(
        items: merged,
        total: page.total,
        page: next,
        loadingMore: false,
      );
    } catch (e) {
      state = state.copyWith(loadingMore: false, error: e);
    }
  }

  /// Patch one row in place (reaction summary / read flag / comment count) so a
  /// tap does not blow away the accumulated pages.
  void patch(String id, Map<String, dynamic> changes) {
    final items = state.items
        .map((e) => e['id'].toString() == id ? {...e, ...changes} : e)
        .toList();
    state = state.copyWith(items: items);
  }
}

final feedControllerProvider =
    StateNotifierProvider<FeedController, FeedState>((ref) => FeedController(ref));

/// Celebrations strip — { birthdays:[...], anniversaries:[...] } flattened, sorted
/// by how soon they land. Best-effort (an empty strip is fine).
final celebrationsProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  try {
    final res = await ref.watch(apiClientProvider).get(Api.celebrations);
    final map = res is Map ? res.cast<String, dynamic>() : const <String, dynamic>{};
    final birthdays = asList(map, keys: const ['birthdays']);
    final anniversaries = asList(map, keys: const ['anniversaries']);
    final all = [...birthdays, ...anniversaries]
      ..sort((a, b) => celebrationInDays(a).compareTo(celebrationInDays(b)));
    return all;
  } catch (_) {
    return const [];
  }
});

int celebrationInDays(Map<String, dynamic> c) {
  final v = c['inDays'];
  if (v is num) return v.toInt();
  return int.tryParse('${v ?? ''}') ?? 9999;
}

/// The threaded comments for one post: { items:[{…, replies:[…]}], total }.
final feedCommentsProvider =
    FutureProvider.family<List<Map<String, dynamic>>, String>((ref, id) async {
  final res = await ref.watch(apiClientProvider).get(Api.feedComments(id));
  return asList(res);
});
