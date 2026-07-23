// My HR documents (SELF-scope /api/hr/me/documents). A single live FutureProvider
// backs the list; each row carries a `fileUrl` (S3 URL or base64 data URL) plus the
// server-computed `expired` / `expiringSoon` flags. Only EMPLOYEE_VISIBLE rows (plus
// anything the employee signed) are ever returned — HR_ONLY documents never appear.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/endpoints.dart';
import '../../core/providers.dart';
import '../../widgets/common.dart';

final documentsProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final res = await ref.watch(apiClientProvider).get(Api.documents);
  return asList(res);
});
