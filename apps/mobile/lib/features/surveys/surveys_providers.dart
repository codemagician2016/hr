// Survey data (SELF-only /api/hr/me/engagement/surveys/*). The open-occurrence
// list is a live FutureProvider; the fill view (questions for one occurrence) is a
// family keyed by occurrenceId.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/providers.dart';
import '../../widgets/common.dart';

/// My open occurrences with a PENDING / SUBMITTED / DISMISSED state each.
final surveysProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final res = await ref.watch(apiClientProvider).get(Api.surveys);
  return asList(res);
});

/// The fill view for one occurrence: the occurrence + survey + questions[].
final surveyDetailProvider =
    FutureProvider.family<Map<String, dynamic>, String>((ref, occurrenceId) async {
  final res = await ref.watch(apiClientProvider).get(Api.survey(occurrenceId));
  if (res is Map) return res.cast<String, dynamic>();
  throw ApiException('Survey not found', status: 404);
});
