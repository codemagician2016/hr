// Notification inbox data (SELF-only /api/hr/me/notifications/*). The list is a
// live FutureProvider; the unread count drives the home bell badge and is kept
// small/best-effort so it can be watched from the dashboard without failing it.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/endpoints.dart';
import '../../core/providers.dart';
import '../../widgets/common.dart';

/// The inbox: `{ items, total, unlinked? }`. We keep the whole envelope so the UI
/// can render the graceful `unlinked:true` empty state (no linked user → no inbox).
final notificationsProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  final res = await ref.watch(apiClientProvider).get(
    Api.notifications,
    query: {'page': 1, 'pageSize': 50},
  );
  final map = res is Map ? res.cast<String, dynamic>() : const <String, dynamic>{};
  return {
    'items': asList(map),
    'total': (map['total'] as num?)?.toInt() ?? 0,
    'unlinked': map['unlinked'] == true,
  };
});

/// Unread badge number for the home bell. Best-effort (0 on any failure) so it
/// never breaks the dashboard.
final notificationsUnreadProvider = FutureProvider<int>((ref) async {
  try {
    final res = await ref.watch(apiClientProvider).get(Api.notificationsUnreadCount);
    final n = res is Map ? res['unread'] : null;
    return n is num ? n.toInt() : 0;
  } catch (_) {
    return 0;
  }
});
