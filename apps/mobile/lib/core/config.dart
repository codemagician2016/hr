// App configuration. ONE binary serves EVERY tenant (Feature 40 — the
// multi-tenant employee app): the app talks to a single fixed backend origin
// and names the signed-in tenant per-request via the `X-Tenant-Host` header
// (see ApiClient). Which tenant that is comes from the Organization ID (the
// Business.slug) the employee types at login, resolved through the public
// GET /api/tenant/resolve?slug=… endpoint.
//
//   flutter run \
//     --dart-define=API_URL=https://demo-staging.drifthr.com \
//     --dart-define=PLATFORM_DOMAIN=staging.drifthr.com
//
// Prod builds:  API_URL=https://drifthr.com  PLATFORM_DOMAIN=drifthr.com

class AppConfig {
  AppConfig._();

  /// Fixed backend origin every request goes to (any host the DriftHR router
  /// serves works — the tenant comes from the X-Tenant-Host header, not from
  /// this origin). A trailing slash is trimmed so `$base$path` is predictable.
  static String get apiBaseUrl {
    const raw = String.fromEnvironment(
      'API_URL',
      defaultValue: 'https://demo-staging.drifthr.com',
    );
    return raw.replaceFirst(RegExp(r'/+$'), '');
  }

  /// The platform domain tenant subdomains hang off. `X-Tenant-Host` is built
  /// as `<slug>.<platformDomain>` — a LOGICAL tenant name the backend parses
  /// (resolveBusinessId / resolveTenantBusinessId); it never needs to resolve
  /// in DNS.
  static String get platformDomain {
    const raw = String.fromEnvironment(
      'PLATFORM_DOMAIN',
      defaultValue: 'staging.drifthr.com',
    );
    return raw.toLowerCase().replaceFirst(RegExp(r'^\.+'), '');
  }

  /// The X-Tenant-Host value for an organization ID (Business.slug).
  static String tenantHostForSlug(String slug) =>
      '${slug.toLowerCase().trim()}.$platformDomain';

  static const String appName = 'DriftHR';
  static const String tagline = 'Effortless HR & payroll.';

  /// Request timeout. Generous enough for a cold backend, short enough that a
  /// dead network surfaces a real error instead of an indefinite spinner.
  static const Duration connectTimeout = Duration(seconds: 20);
  static const Duration receiveTimeout = Duration(seconds: 30);
}
