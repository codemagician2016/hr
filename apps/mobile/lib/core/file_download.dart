// PDF download + open. The customer session lives in our dio interceptor (Cookie
// + Bearer), so we fetch the protected PDF as bytes through the SAME client and
// hand them to the platform opener:
//   • native (pdf_open_io.dart): temp file → OS viewer (open_filex);
//   • web (pdf_open_web.dart, Feature 41b): Blob + anchor download — dart:io /
//     path_provider / open_filex don't exist in the browser, so the old
//     io-only path failed every payslip/letter open on the m-<tenant> hosts.
// A plain url_launcher would open an UNAUTHENTICATED tab and 401, so we never
// use it for protected files.

import 'dart:convert';

import 'package:dio/dio.dart';

import 'api_client.dart';
import 'pdf_open_io.dart' if (dart.library.html) 'pdf_open_web.dart' as opener;

class FileDownloader {
  FileDownloader(this._api);

  final ApiClient _api;

  /// Downloads the protected PDF at [path] (an /api/... path) and opens it via
  /// the platform opener. Returns null on success, or a human error message.
  Future<String?> openPdf(String path, {required String filename}) async {
    try {
      final res = await _api.raw.get<List<int>>(
        path,
        options: Options(
          responseType: ResponseType.bytes,
          headers: const {'Accept': 'application/pdf'},
          validateStatus: (s) => s != null && s >= 200 && s < 300,
        ),
      );
      final bytes = res.data;
      if (bytes == null || bytes.isEmpty) {
        return 'The file came back empty. Please try again.';
      }
      final safe = filename.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
      return await opener.openPdfBytes(bytes, safe);
    } on DioException catch (e) {
      final code = e.response?.statusCode;
      if (code == 404) return 'This document is not available.';
      if (code == 401 || code == 403) return 'You are not allowed to view this document.';
      return 'Could not download the document. Check your connection.';
    } catch (_) {
      return 'Could not open the document.';
    }
  }

  /// Opens an HR document whose bytes live at [fileUrl]. The /me/documents surface
  /// has NO dedicated authenticated /download route — the row carries a `fileUrl`
  /// that is either a base64 `data:` URL (decoded + opened locally) or an absolute
  /// http(s) URL (S3; fetched with a plain client so we never leak the session to
  /// the storage host). Returns null on success, or a human error message.
  Future<String?> openFileUrl(
    String fileUrl, {
    required String filename,
    String? mimeType,
  }) async {
    try {
      List<int> bytes;
      var mime = mimeType ?? 'application/octet-stream';

      if (fileUrl.startsWith('data:')) {
        final comma = fileUrl.indexOf(',');
        if (comma < 0) return 'This document could not be read.';
        final header = fileUrl.substring(5, comma); // strip leading 'data:'
        final payload = fileUrl.substring(comma + 1);
        final headerMime = header.split(';').first.trim();
        if (headerMime.isNotEmpty) mime = headerMime;
        bytes = header.contains('base64')
            ? base64.decode(payload)
            : utf8.encode(Uri.decodeComponent(payload));
      } else if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
        // A plain dio (no auth interceptor) — a presigned/public S3 URL is
        // self-authorizing; sending our session cookie to the storage host would
        // be a needless leak.
        final res = await Dio().get<List<int>>(
          fileUrl,
          options: Options(
            responseType: ResponseType.bytes,
            validateStatus: (s) => s != null && s >= 200 && s < 300,
          ),
        );
        bytes = res.data ?? const [];
      } else {
        return 'This document is not available to open on mobile.';
      }

      if (bytes.isEmpty) return 'The file came back empty. Please try again.';
      final ext = _extForMime(mime);
      var safe = filename.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
      if (ext != null && !safe.toLowerCase().endsWith(ext)) safe = '$safe$ext';
      return await opener.openPdfBytes(bytes, safe, mime: mime);
    } on DioException catch (e) {
      final code = e.response?.statusCode;
      if (code == 404) return 'This document is not available.';
      if (code == 401 || code == 403) return 'You are not allowed to view this document.';
      return 'Could not download the document. Check your connection.';
    } catch (_) {
      return 'Could not open the document.';
    }
  }

  static String? _extForMime(String mime) {
    switch (mime.toLowerCase()) {
      case 'application/pdf':
        return '.pdf';
      case 'image/png':
        return '.png';
      case 'image/jpeg':
      case 'image/jpg':
        return '.jpg';
      default:
        return null;
    }
  }
}
