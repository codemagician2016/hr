// Session store. Flutter has no browser cookie jar, so we mirror the React
// Native client's approach exactly:
//
//   • POST /api/customer/login sets httpOnly cookies (`token`, `token_refresh`).
//     We capture the raw `Set-Cookie` header, reduce it to the `name=value`
//     pairs the server needs back (dropping Path/HttpOnly/Expires/…), and replay
//     them verbatim as a `Cookie` header on every subsequent request.
//   • The backend's readCustomerToken ALSO accepts `Authorization: Bearer`, so
//     if the login body carries a JSON `token` we keep it as a Bearer fallback.
//
// Both are persisted in flutter_secure_storage so the session survives an app
// restart, and held in memory to avoid a secure-storage read on every request.

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class Session {
  Session(this._storage);

  static const _cookieKey = 'drifthr.session.cookie';
  static const _tokenKey = 'drifthr.session.token';
  // Feature 40 — the signed-in organization (tenant). orgSlug is what the
  // employee typed; tenantHost is the `<slug>.<platformDomain>` value replayed
  // as X-Tenant-Host on EVERY request (login + session guard both key off it).
  static const _orgSlugKey = 'drifthr.org.slug';
  static const _tenantHostKey = 'drifthr.org.tenantHost';
  static const _orgNameKey = 'drifthr.org.name';

  final FlutterSecureStorage _storage;

  String? _cookie;
  String? _token;
  String? _orgSlug;
  String? _tenantHost;
  String? _orgName;

  String? get cookie => _cookie;
  String? get token => _token;
  String? get orgSlug => _orgSlug;
  String? get tenantHost => _tenantHost;
  String? get orgName => _orgName;

  bool get hasSession => (_cookie?.isNotEmpty ?? false) || (_token?.isNotEmpty ?? false);

  /// Hydrate from secure storage at app boot.
  Future<void> load() async {
    try {
      _cookie = await _storage.read(key: _cookieKey);
      _token = await _storage.read(key: _tokenKey);
      _orgSlug = await _storage.read(key: _orgSlugKey);
      _tenantHost = await _storage.read(key: _tenantHostKey);
      _orgName = await _storage.read(key: _orgNameKey);
    } catch (_) {
      _cookie = null;
      _token = null;
      _orgSlug = null;
      _tenantHost = null;
      _orgName = null;
    }
  }

  Future<void> save({String? cookie, String? token}) async {
    if (cookie != null && cookie.isNotEmpty) {
      _cookie = cookie;
      await _storage.write(key: _cookieKey, value: cookie);
    }
    if (token != null && token.isNotEmpty) {
      _token = token;
      await _storage.write(key: _tokenKey, value: token);
    }
  }

  /// Persist the resolved organization. Called BEFORE login so the login
  /// request itself already carries the right X-Tenant-Host.
  Future<void> saveOrg({required String slug, required String tenantHost, String? name}) async {
    _orgSlug = slug;
    _tenantHost = tenantHost;
    _orgName = name;
    try {
      await _storage.write(key: _orgSlugKey, value: slug);
      await _storage.write(key: _tenantHostKey, value: tenantHost);
      if (name != null && name.isNotEmpty) {
        await _storage.write(key: _orgNameKey, value: name);
      }
    } catch (_) {
      // In-memory values are what the interceptor reads; storage is best-effort.
    }
  }

  /// Clears the AUTH session only. The organization is deliberately kept so the
  /// next login pre-fills the org ID (an employee signs into the same company).
  Future<void> clear() async {
    _cookie = null;
    _token = null;
    try {
      await _storage.delete(key: _cookieKey);
      await _storage.delete(key: _tokenKey);
    } catch (_) {
      // Best-effort: the in-memory clear above is what matters.
    }
  }

  /// Full reset including the remembered organization ("switch company").
  Future<void> clearAll() async {
    await clear();
    _orgSlug = null;
    _tenantHost = null;
    _orgName = null;
    try {
      await _storage.delete(key: _orgSlugKey);
      await _storage.delete(key: _tenantHostKey);
      await _storage.delete(key: _orgNameKey);
    } catch (_) {}
  }

  /// Reduce a possibly multi-cookie `Set-Cookie` header (dio returns each cookie
  /// as a separate list entry) to the `name=value; name=value` string the server
  /// needs replayed. Drops attributes (Path, HttpOnly, Expires, SameSite, …).
  ///
  /// Handles both the list-of-strings shape (dio/`HttpHeaders`) and a single
  /// comma-joined string, splitting only on commas that precede a `name=` token
  /// so an `Expires=Wed, 09 ...` comma is never mistaken for a separator.
  static String? extractCookiePairs(List<String>? setCookieValues) {
    if (setCookieValues == null || setCookieValues.isEmpty) return null;

    final raw = setCookieValues.length == 1
        ? _splitJoinedCookies(setCookieValues.first)
        : setCookieValues;

    final pairs = <String>[];
    for (final entry in raw) {
      final first = entry.split(';').first.trim();
      if (first.contains('=')) pairs.add(first);
    }
    return pairs.isEmpty ? null : pairs.join('; ');
  }

  static List<String> _splitJoinedCookies(String header) {
    // Split on commas that are immediately followed by a `name=` token.
    final parts = header.split(RegExp(r',(?=\s*[^=;,\s]+=)'));
    return parts.map((p) => p.trim()).where((p) => p.isNotEmpty).toList();
  }
}
