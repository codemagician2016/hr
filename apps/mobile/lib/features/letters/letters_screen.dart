// My Letters — own ISSUED letters (with an integrity badge from fileHash + a
// self-only download) and a request-a-letter form. Mirrors
// apps/ess/app/letters/page.js. GET /api/hr/me/letters, GET .../:id/download,
// GET/POST /api/hr/me/letters/requests.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/format.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';

final lettersProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final res = await api.get(Api.letters);
  return asList(res, keys: const ['items', 'letters']);
});

final letterRequestsProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final api = ref.watch(apiClientProvider);
  try {
    final res = await api.get(Api.letterRequests);
    return asList(res);
  } catch (_) {
    return const [];
  }
});

const _requestTypes = [
  ('SALARY_CERTIFICATE', 'Salary Certificate'),
  ('EXPERIENCE_LETTER', 'Experience Certificate'),
  ('RELIEVING_LETTER', 'Relieving Letter'),
  ('APPOINTMENT_LETTER', 'Appointment Letter'),
  ('CONFIRMATION_LETTER', 'Confirmation Letter'),
  ('OTHER', 'Other'),
];

const _categoryLabels = {
  'EXPERIENCE': 'Experience',
  'BONAFIDE': 'Bonafide',
  'EMPLOYMENT_PROOF': 'Employment Proof',
  'SALARY_PROOF': 'Salary Proof',
  'BANK': 'Bank',
  'CONTRACT': 'Contract',
  'CUSTOM': 'Letter',
};

class LettersScreen extends ConsumerWidget {
  const LettersScreen({super.key});

  Future<void> _refresh(WidgetRef ref) async {
    await Future.wait([
      ref.refresh(lettersProvider.future),
      ref.refresh(letterRequestsProvider.future),
    ]);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(lettersProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('My Letters')),
      body: AsyncView<List<Map<String, dynamic>>>(
        value: async,
        treat404AsEmpty: true,
        emptyText: 'No letters have been issued to you yet.',
        onRefresh: () => _refresh(ref),
        data: (letters) {
          final requests = ref.watch(letterRequestsProvider).valueOrNull ?? const [];
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              const SectionHeading(text: 'Issued letters'),
              const SizedBox(height: 8),
              if (letters.isEmpty)
                const EmptyView(text: 'No letters have been issued to you yet.')
              else
                ...letters.map((l) => _LetterTile(letter: l)),
              if (requests.isNotEmpty) ...[
                const SizedBox(height: 22),
                const SectionHeading(text: 'My requests'),
                const SizedBox(height: 8),
                ...requests.map((r) => _RequestTile(request: r)),
              ],
              const SizedBox(height: 22),
              const SectionHeading(text: 'Request a letter'),
              const SizedBox(height: 8),
              _RequestForm(onSubmitted: () => ref.invalidate(letterRequestsProvider)),
              const SizedBox(height: 24),
            ],
          );
        },
      ),
    );
  }
}

class _LetterTile extends ConsumerStatefulWidget {
  const _LetterTile({required this.letter});

  final Map<String, dynamic> letter;

  @override
  ConsumerState<_LetterTile> createState() => _LetterTileState();
}

class _LetterTileState extends ConsumerState<_LetterTile> {
  bool _busy = false;

  Future<void> _download() async {
    setState(() => _busy = true);
    final id = widget.letter['id'].toString();
    final err = await ref
        .read(fileDownloaderProvider)
        .openPdf(Api.letterDownload(id), filename: 'letter-$id.pdf');
    if (!mounted) return;
    setState(() => _busy = false);
    if (err != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = widget.letter;
    final title = l['subject']?.toString() ?? _categoryLabels[l['category']] ?? 'Letter';
    final hasHash = l['fileHash'] != null;
    final voided = l['voided'] == true || l['status'] == 'VOIDED';

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: SectionCard(
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      style: TextStyle(
                        fontWeight: FontWeight.w700,
                        color: BrandColors.text,
                        decoration: voided ? TextDecoration.lineThrough : null,
                      )),
                  Text(
                    '${_categoryLabels[l['category']] ?? l['category'] ?? 'Letter'}'
                    '${l['referenceNo'] != null ? ' · ${l['referenceNo']}' : ''}'
                    '${l['issuedAt'] != null ? ' · ${Fmt.date(l['issuedAt'])}' : ''}',
                    style: const TextStyle(color: BrandColors.muted, fontSize: 12),
                  ),
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      if (hasHash)
                        StatusPill(label: 'Integrity verified', fg: const Color(0xFF059669), bg: const Color(0x1F10B981))
                      else
                        StatusPill(label: 'Unverified', fg: BrandColors.warning, bg: BrandColors.warningSoft),
                      if (voided) ...[
                        const SizedBox(width: 6),
                        StatusPill(label: 'Voided', fg: BrandColors.danger, bg: BrandColors.dangerSoft),
                      ],
                    ],
                  ),
                ],
              ),
            ),
            if (!voided)
              IconButton(
                icon: _busy
                    ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.download_outlined, color: BrandColors.teal),
                onPressed: _busy ? null : _download,
              ),
          ],
        ),
      ),
    );
  }
}

class _RequestTile extends ConsumerWidget {
  const _RequestTile({required this.request});

  final Map<String, dynamic> request;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final r = request;
    final status = r['status']?.toString() ?? 'PENDING';
    final canDownload = status == 'FULFILLED' && r['letterId'] != null;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: SectionCard(
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text((r['subject'] ?? r['templateKindLabel'] ?? r['templateKind'] ?? 'Request').toString(),
                      style: const TextStyle(fontWeight: FontWeight.w600, color: BrandColors.text)),
                  if (r['createdAt'] != null)
                    Text('Requested ${Fmt.date(r['createdAt'])}',
                        style: const TextStyle(color: BrandColors.muted, fontSize: 12)),
                  const SizedBox(height: 6),
                  StatusPill.forStatus(status),
                ],
              ),
            ),
            if (canDownload)
              TextButton(
                onPressed: () async {
                  final err = await ref.read(fileDownloaderProvider).openPdf(
                        Api.letterDownload(r['letterId'].toString()),
                        filename: 'letter-${r['letterId']}.pdf',
                      );
                  if (err != null && context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
                  }
                },
                child: const Text('Download'),
              ),
          ],
        ),
      ),
    );
  }
}

class _RequestForm extends ConsumerStatefulWidget {
  const _RequestForm({required this.onSubmitted});

  final VoidCallback onSubmitted;

  @override
  ConsumerState<_RequestForm> createState() => _RequestFormState();
}

class _RequestFormState extends ConsumerState<_RequestForm> {
  String _type = 'SALARY_CERTIFICATE';
  final _purpose = TextEditingController();
  bool _submitting = false;
  bool _success = false;
  String? _error;

  @override
  void dispose() {
    _purpose.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _submitting = true;
      _error = null;
      _success = false;
    });
    try {
      await ref.read(apiClientProvider).post(Api.letterRequests, {
        'templateKind': _type,
        if (_purpose.text.trim().isNotEmpty) 'purpose': _purpose.text.trim(),
      });
      setState(() {
        _success = true;
        _purpose.clear();
      });
      widget.onSubmitted();
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not submit your request.');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Ask HR to issue a letter. It lands in the HR queue and appears above once issued.',
              style: TextStyle(color: BrandColors.muted, fontSize: 12)),
          const SizedBox(height: 12),
          if (_error != null) ...[ErrorBanner(message: _error!), const SizedBox(height: 12)],
          if (_success) ...[
            const SuccessBanner(message: 'Request submitted. HR will action it shortly.'),
            const SizedBox(height: 12),
          ],
          DropdownButtonFormField<String>(
            value: _type,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Letter type'),
            items: _requestTypes
                .map((t) => DropdownMenuItem(value: t.$1, child: Text(t.$2)))
                .toList(),
            onChanged: (v) => setState(() => _type = v ?? 'SALARY_CERTIFICATE'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _purpose,
            maxLines: 2,
            maxLength: 2000,
            decoration: const InputDecoration(
              labelText: 'Purpose (optional)',
              hintText: 'e.g. for a visa application / bank loan',
            ),
          ),
          const SizedBox(height: 4),
          FilledButton(
            onPressed: _submitting ? null : _submit,
            child: _submitting
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Text('Submit request'),
          ),
        ],
      ),
    );
  }
}
