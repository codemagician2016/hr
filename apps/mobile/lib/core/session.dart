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

  final FlutterSecureStorage _storage;

  String? _cookie;
  String? _token;

  String? get cookie => _cookie;
  String? get token => _token;

  bool get hasSession => (_cookie?.isNotEmpty ?? false) || (_token?.isNotEmpty ?? false);

  /// Hydrate from secure storage at app boot.
  Future<void> load() async {
    try {
      _cookie = await _storage.read(key: _cookieKey);
      _token = await _storage.read(key: _tokenKey);
    } catch (_) {
      _cookie = null;
      _token = null;
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
