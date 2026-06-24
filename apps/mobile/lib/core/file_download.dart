// PDF download + open. The customer session lives in our dio interceptor (Cookie
// + Bearer), so we fetch the protected PDF as bytes through the SAME client,
// write it to a temp file, and hand it to the OS viewer (open_filex). A plain
// url_launcher would open an UNAUTHENTICATED browser tab and 401, so we never
// use it for protected files.

import 'dart:io';

import 'package:dio/dio.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';

import 'api_client.dart';

class FileDownloader {
  FileDownloader(this._api);

  final ApiClient _api;

  /// Downloads the protected PDF at [path] (an /api/... path) and opens it in the
  /// platform viewer. Returns null on success, or a human error message.
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

      final dir = await getTemporaryDirectory();
      final safe = filename.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
      final file = File('${dir.path}/$safe');
      await file.writeAsBytes(bytes, flush: true);

      final result = await OpenFilex.open(file.path, type: 'application/pdf');
      if (result.type != ResultType.done) {
        return 'Saved, but no app could open the PDF (${result.message}).';
      }
      return null;
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
