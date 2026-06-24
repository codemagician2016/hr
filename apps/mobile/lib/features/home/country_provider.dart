// The AUTHORITATIVE country/currency/capability matrix for the signed-in
// employee's tenant (GET /api/hr/me/country-context → { country, currency,
// capabilities }). India-first: screens gate India-only surfaces (tax projection)
// off `country == 'IN'`. FAIL-CLOSED — a 409 (pre-setup / ambiguous) or any error
// resolves to a null country so we render NEITHER market's blocks.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/providers.dart';

class CountryContext {
  const CountryContext({this.country, this.currency, this.capabilities = const {}});

  final String? country; // 'IN' | 'NZ' | null (fail-closed)
  final String? currency; // 'INR' | 'NZD' | null
  final Map<String, dynamic> capabilities;

  bool get isIndia => country == 'IN';
  bool get isNz => country == 'NZ';
}

final countryContextProvider = FutureProvider<CountryContext>((ref) async {
  final api = ref.watch(apiClientProvider);
  try {
    final res = await api.get(Api.meCountryContext);
    final map = res is Map<String, dynamic> ? res : <String, dynamic>{};
    return CountryContext(
      country: (map['country'] as String?)?.toUpperCase(),
      currency: map['currency'] as String?,
      capabilities: (map['capabilities'] as Map?)?.cast<String, dynamic>() ?? const {},
    );
  } on ApiException {
    // 409 (HR_NOT_SET_UP / HR_COUNTRY_AMBIGUOUS) or any error → fail closed.
    return const CountryContext();
  }
});
