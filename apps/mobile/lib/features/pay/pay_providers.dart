// Pay data providers — payslips list (paginated), one payslip detail, and the
// CTC/compensation waterfall. All read the SELF_ONLY /api/hr/me/* surface.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/endpoints.dart';
import '../../core/providers.dart';
import '../../widgets/common.dart';

/// First page of payslips for the dashboard "latest payslip" + the Pay tab.
final payslipsProvider =
    FutureProvider.family<({List<Map<String, dynamic>> items, int total}), ({int page, int pageSize})>(
        (ref, args) async {
  final api = ref.watch(apiClientProvider);
  final res = await api.get(Api.payslips, query: {'page': args.page, 'pageSize': args.pageSize});
  return asPage(res, keys: const ['items', 'payslips']);
});

final payslipDetailProvider =
    FutureProvider.family<Map<String, dynamic>, String>((ref, id) async {
  final api = ref.watch(apiClientProvider);
  final res = await api.get(Api.payslip(id));
  if (res is Map<String, dynamic>) {
    final slip = res['payslip'];
    return slip is Map<String, dynamic> ? slip : res;
  }
  return <String, dynamic>{};
});

final compensationProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final res = await api.get(Api.compensation);
  return res is Map<String, dynamic> ? res : <String, dynamic>{};
});
