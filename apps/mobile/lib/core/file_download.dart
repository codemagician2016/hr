// PDF download + open. The customer session lives in our dio interceptor (Cookie
// + Bearer), so we fetch the protected PDF as bytes through the SAME client and
// hand them to the platform opener:
//   • native (pdf_open_io.dart): temp file → OS viewer (open_filex);
//   • web (pdf_open_web.dart, Feature 41b): Blob + anchor download — dart:io /
//     path_provider / open_filex don't exist in the browser, so the old
//     io-only path failed every payslip/letter open on the m-<tenant> hosts.
// A plain url_launcher would open an UNAUTHENTICATED tab and 401, so we never
// use it for protected files.

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
}
