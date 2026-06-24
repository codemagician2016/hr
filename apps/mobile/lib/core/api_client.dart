// DriftHR mobile API client (dio).
//
// AUTH CONTRACT (mirrors apps/hr-mobile/src/lib/api.js exactly):
//   • Base origin from --dart-define=API_URL.
//   • POST {BASE}/api/customer/login {email,password} → the backend sets
//     httpOnly cookies (`token`, `token_refresh`). We capture the raw Set-Cookie
//     from the response, reduce it to name=value pairs, persist them, and replay
//     them as a `Cookie` header on every subsequent request (the interceptor).
//   • We ALSO accept a JSON `token` in the login body as an Authorization:
//     Bearer fallback (the backend's readCustomerToken accepts Bearer).
//   • Any 401 → clear the session and notify (router redirects to Login).
//
// Non-2xx responses throw an [ApiException] carrying `.status` and `.errors`,
// mirroring the JS jsonOrThrow contract so callers can branch on them.

import 'package:dio/dio.dart';

import 'config.dart';
import 'session.dart';

/// Thrown for any non-2xx response (or transport failure). Carries the HTTP
/// status and any structured validation errors the backend returned.
class ApiException implements Exception {
  ApiException(this.message, {this.status, this.errors = const [], this.body});

  final String message;
  final int? status;
  final List<dynamic> errors;
  final Map<String, dynamic>? body;

  bool get isUnauthorized => status == 401;
  bool get isNotFound => status == 404;

  @override
  String toString() => 'ApiException($status): $message';
}

class ApiClient {
  ApiClient(this.session, {this.onUnauthorized}) {
    _dio = Dio(
      BaseOptions(
        baseUrl: AppConfig.apiBaseUrl,
        connectTimeout: AppConfig.connectTimeout,
        receiveTimeout: AppConfig.receiveTimeout,
        // We validate status ourselves so we can build a rich ApiException.
        validateStatus: (_) => true,
        headers: const {'Accept': 'application/json'},
      ),
    );

    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          // Replay the captured session on every request.
          final cookie = session.cookie;
          final token = session.token;
          if (cookie != null && cookie.isNotEmpty) {
            options.headers['Cookie'] = cookie;
          }
          if (token != null && token.isNotEmpty) {
            options.headers['Authorization'] = 'Bearer $token';
          }
          handler.next(options);
        },
      ),
    );
  }

  final Session session;

  /// Invoked whenever any request returns 401. The app clears the session and
  /// routes back to Login. Set by the composition root.
  final void Function()? onUnauthorized;

  late final Dio _dio;

  /// Low-level raw access (used by the PDF downloader for byte streams).
  Dio get raw => _dio;

  // ── core verbs ──────────────────────────────────────────────────────────────

  Future<dynamic> get(String path, {Map<String, dynamic>? query}) =>
      _send('GET', path, query: query);

  Future<dynamic> post(String path, [Object? body]) =>
      _send('POST', path, body: body);

  Future<dynamic> patch(String path, [Object? body]) =>
      _send('PATCH', path, body: body);

  Future<dynamic> put(String path, [Object? body]) =>
      _send('PUT', path, body: body);

  Future<dynamic> delete(String path, [Object? body]) =>
      _send('DELETE', path, body: body);

  Future<dynamic> _send(
    String method,
    String path, {
    Object? body,
    Map<String, dynamic>? query,
  }) async {
    Response<dynamic> res;
    try {
      res = await _dio.request<dynamic>(
        path,
        queryParameters: query,
        data: body,
        options: Options(
          method: method,
          contentType: body == null ? null : Headers.jsonContentType,
        ),
      );
    } on DioException catch (e) {
      // Transport-level failure (timeout, no network, DNS, …).
      throw ApiException(
        e.message ?? 'Network request failed. Check your connection.',
        status: e.response?.statusCode,
      );
    }
    return _unwrap(res);
  }

  dynamic _unwrap(Response<dynamic> res) {
    final status = res.statusCode ?? 0;
    final data = res.data;
    final Map<String, dynamic> bodyMap =
        data is Map<String, dynamic> ? data : <String, dynamic>{};

    if (status >= 200 && status < 300) {
      return data;
    }

    if (status == 401) {
      onUnauthorized?.call();
    }

    final message = (bodyMap['message'] as String?) ??
        'Request failed (${status == 0 ? 'no response' : status}).';
    throw ApiException(
      message,
      status: status,
      errors: (bodyMap['errors'] as List<dynamic>?) ??
          (bodyMap['issues'] as List<dynamic>?) ??
          const [],
      body: bodyMap,
    );
  }

  // ── auth ────────────────────────────────────────────────────────────────────

  /// POST /api/customer/login. Captures the session cookie (and/or a Bearer
  /// token from the body), persists it, and returns the `customer` object.
  Future<Map<String, dynamic>> login(String email, String password) async {
    final res = await _dio.post<dynamic>(
      '/api/customer/login',
      data: {'email': email, 'password': password},
      options: Options(contentType: Headers.jsonContentType),
    );

    final status = res.statusCode ?? 0;
    final Map<String, dynamic> body =
        res.data is Map<String, dynamic> ? res.data as Map<String, dynamic> : {};

    if (status < 200 || status >= 300) {
      throw ApiException(
        (body['message'] as String?) ?? 'Login failed. Check your email and password.',
        status: status,
        body: body,
      );
    }

    // dio exposes each Set-Cookie line as a separate header value.
    final setCookie = res.headers.map['set-cookie'];
    final cookie = Session.extractCookiePairs(setCookie);
    final token = (body['token'] ?? body['accessToken']) as String?;

    if ((cookie != null && cookie.isNotEmpty) || (token != null && token.isNotEmpty)) {
      await session.save(cookie: cookie, token: token);
    }

    final customer = body['customer'];
    return customer is Map<String, dynamic> ? customer : body;
  }

  /// Clears the local session (and best-effort POSTs logout, like the RN client).
  Future<void> logout() async {
    try {
      await post('/api/customer/logout');
    } catch (_) {
      // Clearing the local session is what matters even if the call fails.
    }
    await session.clear();
  }
}
