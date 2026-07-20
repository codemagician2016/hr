// Riverpod composition root. Wires the session store and the API client, and
// exposes the auth controller that the router's redirect guard reads.
//
// The session/storage/client are created once at boot (overridden in main.dart
// after the session is hydrated) so the very first frame already has a warm,
// authenticated client.

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api_client.dart';
import 'config.dart';
import 'file_download.dart';
import 'session.dart';

/// Secure storage singleton.
final secureStorageProvider = Provider<FlutterSecureStorage>((ref) {
  return const FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
});

/// The session store. Overridden in main() with an already-hydrated instance.
final sessionProvider = Provider<Session>((ref) {
  return Session(ref.watch(secureStorageProvider));
});

/// The dio-backed API client. A 401 anywhere clears the session and flips the
/// auth controller to signed-out, which the router redirect picks up.
final apiClientProvider = Provider<ApiClient>((ref) {
  final session = ref.watch(sessionProvider);
  return ApiClient(
    session,
    onUnauthorized: () {
      // Defer to a microtask so we never mutate provider state mid-build.
      Future.microtask(() => ref.read(authControllerProvider.notifier).onUnauthorized());
    },
  );
});

/// PDF downloader (authenticated byte fetch → temp file → OS viewer).
final fileDownloaderProvider = Provider<FileDownloader>((ref) {
  return FileDownloader(ref.watch(apiClientProvider));
});

// ── Auth state ────────────────────────────────────────────────────────────────

enum AuthStatus { unknown, authenticated, unauthenticated }

@immutable
class AuthState {
  const AuthState({required this.status, this.customer});

  final AuthStatus status;
  final Map<String, dynamic>? customer;

  AuthState copyWith({AuthStatus? status, Map<String, dynamic>? customer}) =>
      AuthState(status: status ?? this.status, customer: customer ?? this.customer);

  static const unknown = AuthState(status: AuthStatus.unknown);
}

/// Owns the signed-in customer + the login/logout/bootstrap flow.
class AuthController extends StateNotifier<AuthState> {
  AuthController(this._ref) : super(AuthState.unknown);

  final Ref _ref;

  ApiClient get _api => _ref.read(apiClientProvider);
  Session get _session => _ref.read(sessionProvider);

  /// Called at app boot AFTER the session has been hydrated. If we hold a
  /// session, validate it against /api/hr/me/profile; otherwise go to Login.
  Future<void> bootstrap() async {
    if (!_session.hasSession) {
      state = const AuthState(status: AuthStatus.unauthenticated);
      return;
    }
    await _refreshMe();
  }

  Future<void> _refreshMe() async {
    try {
      // The rich ESS "me" check — resolves the employee + profile server-side.
      final res = await _api.get('/api/hr/me/profile');
      final me = res is Map<String, dynamic> ? res : <String, dynamic>{};
      state = AuthState(status: AuthStatus.authenticated, customer: me);
    } catch (_) {
      // A bad/expired session: clear it and fall back to Login.
      await _session.clear();
      state = const AuthState(status: AuthStatus.unauthenticated);
    }
  }

  /// Feature 40 — multi-tenant sign-in: Organization ID (Business.slug) +
  /// email + password. The org resolves FIRST via the public tenant endpoint
  /// (clear "unknown org" error, and the org brand name for the UI); then the
  /// org is persisted so the login request itself carries X-Tenant-Host.
  Future<void> signIn(String orgId, String email, String password) async {
    final slug = orgId.toLowerCase().trim();
    if (slug.isEmpty || !RegExp(r'^[a-z0-9-]+$').hasMatch(slug)) {
      throw ApiException(
        'Organization ID can only contain letters, numbers and dashes.',
        status: 400,
      );
    }
    final tenant = await _api.resolveTenant(slug);
    final business = tenant['business'];
    final orgName = business is Map<String, dynamic> ? business['name'] as String? : null;
    await _session.saveOrg(
      slug: slug,
      tenantHost: AppConfig.tenantHostForSlug(slug),
      name: orgName,
    );

    final customer = await _api.login(email, password);
    // Prefer the rich profile; if it 401s/errors, keep the bare customer.
    try {
      final res = await _api.get('/api/hr/me/profile');
      final me = res is Map<String, dynamic> ? res : {'customer': customer};
      state = AuthState(status: AuthStatus.authenticated, customer: me);
    } catch (_) {
      state = AuthState(status: AuthStatus.authenticated, customer: {'customer': customer});
    }
  }

  Future<void> signOut() async {
    await _api.logout();
    state = const AuthState(status: AuthStatus.unauthenticated);
  }

  /// Triggered by the API client's 401 hook.
  void onUnauthorized() {
    if (state.status == AuthStatus.unauthenticated) return;
    _session.clear();
    state = const AuthState(status: AuthStatus.unauthenticated);
  }
}

final authControllerProvider =
    StateNotifierProvider<AuthController, AuthState>((ref) => AuthController(ref));
