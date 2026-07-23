// Company directory data (SELF-scope /api/hr/me/directory/*). A debounced search
// list (family keyed by the trimmed query), a colleague profile (family by id), and
// my own contact-visibility preferences. Every read is tenant-scoped + privacy-gated
// server-side — only safe work fields are ever returned.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/providers.dart';
import '../../widgets/common.dart';

Map<String, dynamic> _asMap(dynamic v, [Map<String, dynamic> fallback = const {}]) =>
    v is Map ? v.cast<String, dynamic>() : fallback;

/// A page of the directory for a (trimmed) query. An empty query browses everyone
/// (page 1). Returns { items, total } so the screen can hint when more exist.
final directoryListProvider =
    FutureProvider.family<({List<Map<String, dynamic>> items, int total}), String>((ref, query) async {
  final q = query.trim();
  final res = await ref.watch(apiClientProvider).get(
    Api.directory,
    query: {if (q.isNotEmpty) 'q': q, 'page': 1, 'pageSize': 30},
  );
  return asPage(res);
});

/// A colleague's safe work profile ({ …card, reportsCount, orgChart }).
final directoryProfileProvider =
    FutureProvider.family<Map<String, dynamic>, String>((ref, id) async {
  final res = await ref.watch(apiClientProvider).get(Api.directoryProfile(id));
  if (res is Map) return res.cast<String, dynamic>();
  throw ApiException('Colleague not found', status: 404);
});

/// My own directory preferences ({ hideWorkPhone, hasWorkPhone, linked }).
final directoryPreferencesProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  final res = await ref.watch(apiClientProvider).get(Api.directoryPreferences);
  return _asMap(res, const {'hideWorkPhone': false, 'hasWorkPhone': false, 'linked': false});
});
