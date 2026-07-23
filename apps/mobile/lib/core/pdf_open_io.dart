// Native (Android/iOS) PDF open: temp file + OS viewer. Selected by the
// conditional import in file_download.dart; never compiled into the web build.

import 'dart:io';

import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';

Future<String?> openPdfBytes(List<int> bytes, String safeFilename,
    {String mime = 'application/pdf'}) async {
  final dir = await getTemporaryDirectory();
  final file = File('${dir.path}/$safeFilename');
  await file.writeAsBytes(bytes, flush: true);
  final result = await OpenFilex.open(file.path, type: mime);
  if (result.type != ResultType.done) {
    return 'Saved, but no app could open the file (${result.message}).';
  }
  return null;
}
