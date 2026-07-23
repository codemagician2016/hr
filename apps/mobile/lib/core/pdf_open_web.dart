// Web PDF open (Feature 41b — the m-<tenant> browser build): the bytes were
// fetched through the AUTHENTICATED dio client, so hand them to the browser as
// a Blob download. An anchor with the `download` attribute works inside the
// async gap without tripping popup blockers; mobile browsers route the file to
// the viewer/Files. Selected by the conditional import in file_download.dart.

// ignore: avoid_web_libraries_in_flutter
import 'dart:html' as html;

Future<String?> openPdfBytes(List<int> bytes, String safeFilename,
    {String mime = 'application/pdf'}) async {
  final blob = html.Blob([bytes], mime);
  final url = html.Url.createObjectUrlFromBlob(blob);
  final anchor = html.AnchorElement(href: url)
    ..download = safeFilename
    ..style.display = 'none';
  html.document.body?.append(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a beat to start the download before revoking.
  Future<void>.delayed(const Duration(seconds: 30), () => html.Url.revokeObjectUrl(url));
  return null;
}
