// App configuration. The backend origin is injected at build time via
// --dart-define=API_URL=... so the same binary can target staging / prod /
// a white-label tenant domain without a rebuild of the Dart source.
//
//   flutter run --dart-define=API_URL=https://demo-staging.drifthr.com
//
// Mirrors the React Native client's EXPO_PUBLIC_API_URL behaviour: a single
// origin that every request is concatenated onto.

class AppConfig {
  AppConfig._();

  /// Backend origin. Defaults to the DriftHR staging box. A trailing slash is
  /// trimmed so path concatenation (`$base$path`) is always predictable.
  static String get apiBaseUrl {
    const raw = String.fromEnvironment(
      'API_URL',
      defaultValue: 'https://demo-staging.drifthr.com',
    );
    return raw.replaceFirst(RegExp(r'/+$'), '');
  }

  static const String appName = 'DriftHR';
  static const String tagline = 'Effortless HR & payroll.';

  /// Request timeout. Generous enough for a cold backend, short enough that a
  /// dead network surfaces a real error instead of an indefinite spinner.
  static const Duration connectTimeout = Duration(seconds: 20);
  static const Duration receiveTimeout = Duration(seconds: 30);
}
