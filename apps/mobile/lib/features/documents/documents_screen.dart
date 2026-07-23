// Documents — my HR documents. Each row shows the category, name, size, an expiry
// state (expired / expiring-soon), and a verified/signed badge. Tapping opens the
// file: the /me/documents surface has NO dedicated download route, so we open the
// row's `fileUrl` directly (a base64 data URL is decoded locally; an S3 URL is
// fetched). SELF-only /api/hr/me/documents.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';
import 'documents_providers.dart';

String _prettyCategory(String raw) => raw
    .split('_')
    .where((s) => s.isNotEmpty)
    .map((s) => s[0].toUpperCase() + s.substring(1).toLowerCase())
    .join(' ');

String _humanSize(Object? bytes) {
  final n = Fmt.numOr0(bytes);
  if (n <= 0) return '';
  if (n < 1024) return '${n.toInt()} B';
  if (n < 1024 * 1024) return '${(n / 1024).toStringAsFixed(0)} KB';
  return '${(n / (1024 * 1024)).toStringAsFixed(1)} MB';
}

IconData _iconForMime(String mime) {
  if (mime.contains('pdf')) return Icons.picture_as_pdf_outlined;
  if (mime.startsWith('image/')) return Icons.image_outlined;
  return Icons.insert_drive_file_outlined;
}

class DocumentsScreen extends ConsumerStatefulWidget {
  const DocumentsScreen({super.key});

  @override
  ConsumerState<DocumentsScreen> createState() => _DocumentsScreenState();
}

class _DocumentsScreenState extends ConsumerState<DocumentsScreen> {
  String? _openingId;

  Future<void> _refresh() async {
    ref.invalidate(documentsProvider);
    await ref.read(documentsProvider.future);
  }

  Future<void> _open(Map<String, dynamic> doc) async {
    final fileUrl = (doc['fileUrl'] ?? '').toString();
    final id = doc['id'].toString();
    if (fileUrl.isEmpty) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('This document has no file to open.')));
      return;
    }
    setState(() => _openingId = id);
    final err = await ref.read(fileDownloaderProvider).openFileUrl(
          fileUrl,
          filename: (doc['name'] ?? 'document').toString(),
          mimeType: (doc['mimeType'] ?? '').toString().isEmpty ? null : doc['mimeType'].toString(),
        );
    if (!mounted) return;
    setState(() => _openingId = null);
    if (err != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(documentsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Documents')),
      body: AsyncView<List<Map<String, dynamic>>>(
        value: async,
        treat404AsEmpty: true,
        emptyText: 'No documents shared with you yet.',
        onRefresh: _refresh,
        data: (items) {
          if (items.isEmpty) {
            return ListView(
              children: const [
                SizedBox(height: 80),
                EmptyView(
                  icon: Icons.folder_outlined,
                  text: 'No documents yet.\nDocuments HR shares with you will appear here.',
                ),
              ],
            );
          }
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              ...items.map((d) => _DocTile(
                    doc: d,
                    opening: _openingId == d['id'].toString(),
                    onOpen: () => _open(d),
                  )),
              const SizedBox(height: 24),
            ],
          );
        },
      ),
    );
  }
}

class _DocTile extends StatelessWidget {
  const _DocTile({required this.doc, required this.opening, required this.onOpen});

  final Map<String, dynamic> doc;
  final bool opening;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final name = (doc['name'] ?? 'Document').toString();
    final category = _prettyCategory((doc['category'] ?? '').toString());
    final mime = (doc['mimeType'] ?? '').toString();
    final size = _humanSize(doc['sizeBytes']);
    final expired = doc['expired'] == true;
    final expiringSoon = doc['expiringSoon'] == true;
    final verified = doc['verifiedAt'] != null;
    final signed = (doc['signatureStatus'] ?? '').toString().toUpperCase() == 'SIGNED';
    final awaiting = doc['isEmployeeUploaded'] == true && !verified;

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        borderRadius: BorderRadius.circular(BrandRadii.lg),
        onTap: opening ? null : onOpen,
        child: SectionCard(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 42,
                height: 42,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: BrandColors.tealSoft,
                  borderRadius: BorderRadius.circular(BrandRadii.md),
                ),
                child: Icon(_iconForMime(mime), color: BrandColors.tealDark, size: 22),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(name,
                        style: const TextStyle(
                            fontSize: 14.5, fontWeight: FontWeight.w700, color: BrandColors.text)),
                    const SizedBox(height: 3),
                    Text(
                      [if (category.isNotEmpty) category, if (size.isNotEmpty) size].join(' · '),
                      style: const TextStyle(color: BrandColors.muted, fontSize: 12),
                    ),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        if (verified)
                          const StatusPill(label: 'Verified', fg: Color(0xFF047857), bg: Color(0xFFECFDF5)),
                        if (signed)
                          const StatusPill(label: 'Signed', fg: Color(0xFF1D4ED8), bg: Color(0xFFEFF6FF)),
                        if (awaiting)
                          const StatusPill(label: 'Awaiting verification', fg: Color(0xFFB45309), bg: Color(0xFFFFFBEB)),
                        if (expired)
                          const StatusPill(label: 'Expired', fg: Color(0xFFB91C1C), bg: Color(0xFFFEF2F2))
                        else if (expiringSoon)
                          const StatusPill(label: 'Expiring soon', fg: Color(0xFFB45309), bg: Color(0xFFFFFBEB))
                        else if (doc['expiresAt'] != null)
                          StatusPill(
                            label: 'Expires ${Fmt.date(doc['expiresAt'])}',
                            fg: BrandColors.muted,
                            bg: const Color(0xFFF1F5F9),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              opening
                  ? const SizedBox(
                      width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.2))
                  : const Icon(Icons.download_outlined, color: BrandColors.teal, size: 22),
            ],
          ),
        ),
      ),
    );
  }
}
