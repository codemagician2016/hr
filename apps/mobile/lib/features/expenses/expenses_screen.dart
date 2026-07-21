// Reimbursement claims (Feature 45) — Employee Self-Service. Mirrors
// apps/ess/app/reimbursements/page.js (the claims flow):
//   • My claims list (status chip, amount, claim number) with pull-to-refresh.
//   • New claim: category (from /me/expenses/reference) + description → DRAFT.
//   • Claim detail: add bill lines (amount, description, optional receipt as a
//     base64 data URL — the exact attendance-selfie pattern), each line's live
//     policy verdict, remove line, submit (server blocks on AUTO_REJECTED
//     lines), cancel/withdraw.
// All calls hit /api/hr/me/expenses/* — SELF_ONLY, no employeeId ever sent.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/format.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';

// ── providers ─────────────────────────────────────────────────────────────────

/// Reference data for the claim forms: `{ categories: [...], policy: {...}? }`.
final expenseReferenceProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final res = await api.get(Api.expenseReference);
  if (res is Map) return res.cast<String, dynamic>();
  return const {'categories': [], 'policy': null};
});

/// My claims, newest first.
final expenseClaimsProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final res = await api.get(Api.expenseClaims);
  return asList(res);
});

/// One claim with its bill lines.
final expenseClaimProvider =
    FutureProvider.family<Map<String, dynamic>, String>((ref, id) async {
  final api = ref.watch(apiClientProvider);
  final res = await api.get(Api.expenseClaim(id));
  if (res is Map) return res.cast<String, dynamic>();
  throw ApiException('Expense claim not found', status: 404);
});

// ── shared pills ──────────────────────────────────────────────────────────────

Widget _statusPill(String? status) {
  final s = (status ?? '').toUpperCase();
  if (s == 'REIMBURSED') {
    return const StatusPill(
        label: 'REIMBURSED', fg: Color(0xFF047857), bg: Color(0xFFECFDF5));
  }
  return StatusPill.forStatus(status);
}

/// Policy verdict pill — the ESS "Within budget / Over budget / Not allowed" badge.
Widget _verdictPill(String? verdict) {
  switch ((verdict ?? '').toUpperCase()) {
    case 'OK':
      return const StatusPill(
          label: 'Within budget', fg: Color(0xFF047857), bg: Color(0xFFECFDF5));
    case 'FLAGGED':
      return const StatusPill(
          label: 'Over budget — flagged', fg: Color(0xFFB45309), bg: Color(0xFFFFFBEB));
    case 'AUTO_REJECTED':
      return const StatusPill(
          label: 'Not allowed — hard cap', fg: Color(0xFFB91C1C), bg: Color(0xFFFEF2F2));
    default:
      return const StatusPill(
          label: 'No policy — advisory', fg: BrandColors.muted, bg: Color(0xFFF1F5F9));
  }
}

List<Map<String, dynamic>> _categoriesOf(Map<String, dynamic>? reference) =>
    reference == null ? const [] : asList(reference, keys: const ['categories']);

// ── list screen ───────────────────────────────────────────────────────────────

class ExpensesScreen extends ConsumerWidget {
  const ExpensesScreen({super.key});

  Future<void> _refresh(WidgetRef ref) async {
    await Future.wait([
      ref.refresh(expenseClaimsProvider.future),
      ref.refresh(expenseReferenceProvider.future),
    ]);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(expenseClaimsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Reimbursements')),
      body: AsyncView<List<Map<String, dynamic>>>(
        value: async,
        treat404AsEmpty: true,
        emptyText: 'No claims yet.',
        onRefresh: () => _refresh(ref),
        data: (claims) {
          final reference = ref.watch(expenseReferenceProvider).valueOrNull;
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              const SectionHeading(text: 'New reimbursement'),
              const SizedBox(height: 8),
              _NewClaimForm(
                reference: reference,
                onCreated: (id) {
                  ref.invalidate(expenseClaimsProvider);
                  context.push('/expenses/$id');
                },
              ),
              const SizedBox(height: 22),
              const SectionHeading(
                text: 'Your claims',
                tip: 'Every bill is checked against your company policy as you add it. '
                    'Tap a claim to add bills or track its approval.',
              ),
              const SizedBox(height: 8),
              if (claims.isEmpty)
                const EmptyView(text: 'No claims yet — create one above.')
              else
                ...claims.map((c) => _ClaimTile(claim: c)),
              const SizedBox(height: 24),
            ],
          );
        },
      ),
    );
  }
}

class _ClaimTile extends StatelessWidget {
  const _ClaimTile({required this.claim});

  final Map<String, dynamic> claim;

  @override
  Widget build(BuildContext context) {
    final c = claim;
    final number = (c['claimNumber'] ?? c['id'].toString().substring(0, 8)).toString();
    final travel = c['travelRequest'];
    final category = c['category'];
    final currency = (c['currencyCode'] ?? 'INR').toString();
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        borderRadius: BorderRadius.circular(BrandRadii.lg),
        onTap: () => context.push('/expenses/${c['id']}'),
        child: SectionCard(
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(number,
                        style: const TextStyle(
                            fontWeight: FontWeight.w700, color: BrandColors.text)),
                    Text(
                      '${category is Map ? (category['name'] ?? 'Reimbursement') : 'Reimbursement'}'
                      ' · ${Fmt.money(c['amount'], fallbackCurrency: currency)}'
                      '${travel is Map ? ' · trip ${travel['travelNumber']}' : ''}',
                      style: const TextStyle(color: BrandColors.muted, fontSize: 12),
                    ),
                    const SizedBox(height: 6),
                    _statusPill(c['status']?.toString()),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right, color: BrandColors.teal),
            ],
          ),
        ),
      ),
    );
  }
}

class _NewClaimForm extends ConsumerStatefulWidget {
  const _NewClaimForm({required this.reference, required this.onCreated});

  final Map<String, dynamic>? reference;
  final void Function(String claimId) onCreated;

  @override
  ConsumerState<_NewClaimForm> createState() => _NewClaimFormState();
}

class _NewClaimFormState extends ConsumerState<_NewClaimForm> {
  String? _categoryId;
  final _description = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _description.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final policy = widget.reference?['policy'];
      final res = await ref.read(apiClientProvider).post(Api.expenseClaims, {
        if (_categoryId != null && _categoryId!.isNotEmpty) 'categoryId': _categoryId,
        if (_description.text.trim().isNotEmpty) 'description': _description.text.trim(),
        'currencyCode':
            (policy is Map ? policy['currencyCode'] : null)?.toString() ?? 'INR',
      });
      final id = res is Map ? res['id']?.toString() : null;
      _description.clear();
      setState(() => _categoryId = null);
      if (id != null) widget.onCreated(id);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not create the claim.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final categories = _categoriesOf(widget.reference);
    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text(
            'Claim out-of-pocket expenses. Pick a category, create a draft, then add your bills.',
            style: TextStyle(color: BrandColors.muted, fontSize: 12),
          ),
          const SizedBox(height: 12),
          if (_error != null) ...[ErrorBanner(message: _error!), const SizedBox(height: 12)],
          DropdownButtonFormField<String>(
            value: _categoryId,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Category (optional)'),
            items: [
              const DropdownMenuItem(value: '', child: Text('— choose —')),
              for (final c in categories)
                DropdownMenuItem(
                    value: c['id'].toString(),
                    child: Text((c['name'] ?? c['code'] ?? 'Category').toString())),
            ],
            onChanged: (v) => setState(() => _categoryId = v),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _description,
            decoration: const InputDecoration(
              labelText: 'Description',
              hintText: 'e.g. Client meeting expenses',
            ),
          ),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: _busy ? null : _create,
            child: _busy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Text('Create draft'),
          ),
        ],
      ),
    );
  }
}

// ── detail screen ─────────────────────────────────────────────────────────────

class ExpenseClaimDetailScreen extends ConsumerWidget {
  const ExpenseClaimDetailScreen({super.key, required this.claimId});

  final String claimId;

  Future<void> _refresh(WidgetRef ref) async {
    ref.invalidate(expenseClaimsProvider);
    ref.invalidate(expenseClaimProvider(claimId));
    await ref.read(expenseClaimProvider(claimId).future);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(expenseClaimProvider(claimId));
    return Scaffold(
      appBar: AppBar(title: const Text('Claim')),
      body: AsyncView<Map<String, dynamic>>(
        value: async,
        onRefresh: () => _refresh(ref),
        data: (claim) => _ClaimDetailBody(claim: claim, onChanged: () => _refresh(ref)),
      ),
    );
  }
}

class _ClaimDetailBody extends ConsumerStatefulWidget {
  const _ClaimDetailBody({required this.claim, required this.onChanged});

  final Map<String, dynamic> claim;
  final Future<void> Function() onChanged;

  @override
  ConsumerState<_ClaimDetailBody> createState() => _ClaimDetailBodyState();
}

class _ClaimDetailBodyState extends ConsumerState<_ClaimDetailBody> {
  bool _busy = false;
  String? _error;

  Map<String, dynamic> get claim => widget.claim;
  String get id => claim['id'].toString();
  String get status => (claim['status'] ?? '').toString().toUpperCase();
  bool get isDraft => status == 'DRAFT';

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
      await widget.onChanged();
    } on ApiException catch (e) {
      // The submit hard-block carries per-line reasons under `blockers`.
      final blockers = e.body?['blockers'];
      final reasons = blockers is List
          ? blockers
              .whereType<Map<dynamic, dynamic>>()
              .map((b) => b['reason'])
              .whereType<Object>()
              .map((r) => r.toString())
              .toList()
          : const <String>[];
      setState(() => _error =
          reasons.isEmpty ? e.message : '${e.message}\n• ${reasons.join('\n• ')}');
    } catch (_) {
      setState(() => _error = 'Something went wrong. Please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _submit() =>
      _run(() => ref.read(apiClientProvider).post(Api.expenseClaimSubmit(id)));

  Future<void> _cancel() async {
    final withdraw = status == 'SUBMITTED';
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(withdraw ? 'Withdraw claim?' : 'Cancel claim?'),
        content: Text(withdraw
            ? 'This takes the claim out of the approval queue.'
            : 'This cancels the draft claim.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep it')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: Text(withdraw ? 'Withdraw' : 'Cancel claim')),
        ],
      ),
    );
    if (ok != true) return;
    await _run(() => ref.read(apiClientProvider).post(Api.expenseClaimCancel(id)));
  }

  Future<void> _removeLine(String lineId) =>
      _run(() => ref.read(apiClientProvider).delete(Api.expenseClaimLine(id, lineId)));

  @override
  Widget build(BuildContext context) {
    final lines = asList(claim, keys: const ['lines']);
    final currency = (claim['currencyCode'] ?? 'INR').toString();
    final number = (claim['claimNumber'] ?? id.substring(0, 8)).toString();
    final travel = claim['travelRequest'];
    final rejectReason = claim['rejectReason']?.toString();
    // A returned-for-changes claim comes back as DRAFT with the approver's note
    // on rejectReason (same convention as the ESS web).
    final returnedNote = isDraft && rejectReason != null && rejectReason.isNotEmpty
        ? rejectReason
        : null;
    final verdict = claim['policyVerdict']?.toString();

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        SectionCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(number,
                        style: const TextStyle(
                            fontSize: 18, fontWeight: FontWeight.w800, color: BrandColors.text)),
                  ),
                  _statusPill(claim['status']?.toString()),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                '${(claim['description'] ?? 'Reimbursement')}'
                ' · ${Fmt.money(claim['amount'], fallbackCurrency: currency)}'
                '${travel is Map ? ' · trip ${travel['travelNumber']}' : ''}',
                style: const TextStyle(color: BrandColors.muted, fontSize: 12),
              ),
              if (verdict != null && verdict.isNotEmpty && verdict != 'NO_POLICY') ...[
                const SizedBox(height: 8),
                _verdictPill(verdict),
              ],
              if (!isDraft && rejectReason != null && rejectReason.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text('— $rejectReason',
                    style: const TextStyle(color: BrandColors.danger, fontSize: 12)),
              ],
            ],
          ),
        ),
        if (returnedNote != null) ...[
          const SizedBox(height: 10),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: BrandColors.warningSoft,
              borderRadius: BorderRadius.circular(BrandRadii.md),
              border: Border.all(color: BrandColors.warning.withValues(alpha: 0.4)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Returned for changes',
                    style: TextStyle(fontWeight: FontWeight.w700, color: BrandColors.text)),
                const SizedBox(height: 2),
                Text(returnedNote, style: const TextStyle(color: BrandColors.text, fontSize: 13)),
                const SizedBox(height: 2),
                const Text('Update the bills below and submit again for approval.',
                    style: TextStyle(color: BrandColors.muted, fontSize: 12)),
              ],
            ),
          ),
        ],
        if (_error != null) ...[
          const SizedBox(height: 10),
          ErrorBanner(message: _error!),
        ],
        const SizedBox(height: 18),
        const SectionHeading(
          text: 'Bills',
          tip: 'Each bill is checked against your company policy — the badge shows '
              'whether it is within budget, will be flagged, or is over a hard cap.',
        ),
        const SizedBox(height: 8),
        if (lines.isEmpty)
          const SectionCard(
            child: Text('No bills yet — add the first one below.',
                style: TextStyle(color: BrandColors.muted, fontSize: 13)),
          )
        else
          ...lines.map((l) => _LineTile(
                line: l,
                currency: currency,
                canRemove: isDraft && !_busy,
                onRemove: () => _removeLine(l['id'].toString()),
              )),
        if (isDraft) ...[
          const SizedBox(height: 18),
          const SectionHeading(text: 'Add a bill'),
          const SizedBox(height: 8),
          _AddBillForm(claimId: id, onAdded: widget.onChanged),
        ],
        const SizedBox(height: 18),
        if (isDraft)
          Row(
            children: [
              Expanded(
                child: FilledButton(
                  onPressed: _busy ? null : _submit,
                  child: _busy
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : const Text('Submit for approval'),
                ),
              ),
              const SizedBox(width: 10),
              OutlinedButton(onPressed: _busy ? null : _cancel, child: const Text('Cancel claim')),
            ],
          )
        else if (status == 'SUBMITTED')
          OutlinedButton(onPressed: _busy ? null : _cancel, child: const Text('Withdraw')),
        const SizedBox(height: 24),
      ],
    );
  }
}

class _LineTile extends StatelessWidget {
  const _LineTile({
    required this.line,
    required this.currency,
    required this.canRemove,
    required this.onRemove,
  });

  final Map<String, dynamic> line;
  final String currency;
  final bool canRemove;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final l = line;
    final category = l['category'];
    final label = (l['description'] ??
            (category is Map ? category['name'] : null) ??
            l['transportMode'] ??
            'Bill')
        .toString();
    final reason = l['policyReason']?.toString();
    final hasReceipt = l['receiptUrl'] != null;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: SectionCard(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(label,
                            style: const TextStyle(
                                fontWeight: FontWeight.w600, color: BrandColors.text)),
                      ),
                      if (hasReceipt)
                        const Padding(
                          padding: EdgeInsets.only(left: 4),
                          child:
                              Icon(Icons.attach_file, size: 14, color: BrandColors.teal),
                        ),
                    ],
                  ),
                  Text(Fmt.money(l['amount'], fallbackCurrency: currency),
                      style: const TextStyle(color: BrandColors.muted, fontSize: 12)),
                  const SizedBox(height: 6),
                  _verdictPill(l['policyStatus']?.toString()),
                  if (reason != null && reason.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(reason,
                          style: const TextStyle(color: BrandColors.muted, fontSize: 11)),
                    ),
                ],
              ),
            ),
            if (canRemove)
              IconButton(
                icon: const Icon(Icons.delete_outline, color: BrandColors.danger, size: 20),
                onPressed: onRemove,
              ),
          ],
        ),
      ),
    );
  }
}

class _AddBillForm extends ConsumerStatefulWidget {
  const _AddBillForm({required this.claimId, required this.onAdded});

  final String claimId;
  final Future<void> Function() onAdded;

  @override
  ConsumerState<_AddBillForm> createState() => _AddBillFormState();
}

class _AddBillFormState extends ConsumerState<_AddBillForm> {
  final _amount = TextEditingController();
  final _description = TextEditingController();
  String? _categoryId;
  String? _receiptName;
  String? _receiptDataUrl;
  bool _busy = false;
  String? _error;

  static final ImagePicker _picker = ImagePicker();

  @override
  void dispose() {
    _amount.dispose();
    _description.dispose();
    super.dispose();
  }

  /// Pick a receipt photo (camera or gallery) and encode it to a base64 data
  /// URL — the exact pattern the attendance selfie uses (features/attendance/
  /// selfie.dart): JPEG-80 at <=1600px stays well under the backend's 6 MB cap.
  Future<void> _pickReceipt(ImageSource source) async {
    try {
      final shot = await _picker.pickImage(source: source, imageQuality: 80, maxWidth: 1600);
      if (shot == null) return;
      final bytes = await shot.readAsBytes();
      final name = shot.name.toLowerCase();
      final mime = name.endsWith('.png')
          ? 'image/png'
          : name.endsWith('.webp')
              ? 'image/webp'
              : 'image/jpeg';
      setState(() {
        _receiptName = shot.name;
        _receiptDataUrl = 'data:$mime;base64,${base64Encode(bytes)}';
        _error = null;
      });
    } catch (_) {
      setState(() => _error =
          'Could not read that photo — check the camera/photos permission.');
    }
  }

  Future<void> _chooseReceiptSource() async {
    final source = await showModalBottomSheet<ImageSource>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('Take a photo'),
              onTap: () => Navigator.pop(ctx, ImageSource.camera),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('Choose from gallery'),
              onTap: () => Navigator.pop(ctx, ImageSource.gallery),
            ),
          ],
        ),
      ),
    );
    if (source != null) await _pickReceipt(source);
  }

  Future<void> _add() async {
    final amount = double.tryParse(_amount.text.trim());
    if (amount == null || amount <= 0) {
      setState(() => _error = 'Enter the bill amount.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final res =
          await ref.read(apiClientProvider).post(Api.expenseClaimLines(widget.claimId), {
        'amount': amount,
        if (_description.text.trim().isNotEmpty) 'description': _description.text.trim(),
        if (_categoryId != null && _categoryId!.isNotEmpty) 'categoryId': _categoryId,
        if (_receiptDataUrl != null) 'fileBase64': _receiptDataUrl,
      });
      _amount.clear();
      _description.clear();
      setState(() {
        _categoryId = null;
        _receiptName = null;
        _receiptDataUrl = null;
      });
      // Surface the live policy verdict the server returned for this bill.
      final verdict = res is Map ? res['verdict'] : null;
      if (mounted && verdict is Map) {
        final v = (verdict['verdict'] ?? '').toString();
        final reason = verdict['reason']?.toString();
        final label = v == 'OK'
            ? 'Bill added — within budget.'
            : v == 'FLAGGED'
                ? 'Bill added — over budget, it will be flagged for your approver.'
                : v == 'AUTO_REJECTED'
                    ? 'Bill added — over a hard cap, it will block submission.'
                    : 'Bill added.';
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(reason == null || reason.isEmpty ? label : '$label\n$reason'),
        ));
      }
      await widget.onAdded();
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not add the bill.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final reference = ref.watch(expenseReferenceProvider).valueOrNull;
    final categories = _categoriesOf(reference);
    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text(
            'Enter the bill details. It is checked against your company policy the moment you add it.',
            style: TextStyle(color: BrandColors.muted, fontSize: 12),
          ),
          const SizedBox(height: 12),
          if (_error != null) ...[ErrorBanner(message: _error!), const SizedBox(height: 12)],
          TextField(
            controller: _amount,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'Amount'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _description,
            decoration: const InputDecoration(
                labelText: 'Description', hintText: 'e.g. Fuel — client visit'),
          ),
          const SizedBox(height: 10),
          DropdownButtonFormField<String>(
            value: _categoryId,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Category (optional)'),
            items: [
              const DropdownMenuItem(value: '', child: Text('—')),
              for (final c in categories)
                DropdownMenuItem(
                    value: c['id'].toString(),
                    child: Text((c['name'] ?? c['code'] ?? 'Category').toString())),
            ],
            onChanged: (v) => setState(() => _categoryId = v),
          ),
          const SizedBox(height: 10),
          if (_receiptName != null)
            Row(
              children: [
                const Icon(Icons.attach_file, size: 16, color: BrandColors.teal),
                const SizedBox(width: 4),
                Expanded(
                  child: Text(_receiptName!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 12, color: BrandColors.text)),
                ),
                TextButton(
                  onPressed: () => setState(() {
                    _receiptName = null;
                    _receiptDataUrl = null;
                  }),
                  child: const Text('Clear'),
                ),
              ],
            )
          else
            OutlinedButton.icon(
              onPressed: _busy ? null : _chooseReceiptSource,
              icon: const Icon(Icons.receipt_long_outlined, size: 18),
              label: const Text('Attach receipt (optional)'),
            ),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: _busy ? null : _add,
            child: _busy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Text('Add bill'),
          ),
        ],
      ),
    );
  }
}
