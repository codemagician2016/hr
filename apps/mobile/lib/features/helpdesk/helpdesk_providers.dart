// HR Helpdesk data layer (SELF-scope /api/hr/me/helpdesk/*). The reference data
// (categories + priorities) and my ticket list are live FutureProviders; a single
// ticket's thread is a family keyed by ticket id. The raise / reply / reopen / rate
// MUTATIONS live in the screens (they invalidate the affected providers on success).

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/providers.dart';
import '../../widgets/common.dart';

Map<String, dynamic> _asMap(dynamic v, [Map<String, dynamic> fallback = const {}]) =>
    v is Map ? v.cast<String, dynamic>() : fallback;

/// The raise-form reference: { categories:[{id,name,slaHours}], priorities:[…] }.
final helpdeskReferenceProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  final res = await ref.watch(apiClientProvider).get(Api.helpdeskReference);
  return _asMap(res, const {'categories': [], 'priorities': []});
});

/// My tickets, newest first. Each row carries category, a public-message count,
/// and a `breached` SLA flag (computed server-side).
final helpdeskTicketsProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final res = await ref.watch(apiClientProvider).get(Api.helpdeskTickets);
  return asList(res);
});

/// One ticket's full detail + its public thread ({ …ticket, messages:[…] }).
final helpdeskTicketProvider =
    FutureProvider.family<Map<String, dynamic>, String>((ref, id) async {
  final res = await ref.watch(apiClientProvider).get(Api.helpdeskTicket(id));
  if (res is Map) return res.cast<String, dynamic>();
  throw ApiException('Ticket not found', status: 404);
});
