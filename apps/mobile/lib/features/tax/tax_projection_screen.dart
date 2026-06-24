// Tax projection (India only) — the IT computation statement: gross breakup →
// HRA exemption → Chapter VI-A → taxable income → tax/surcharge/cess → TDS →
// monthly recoverable, + a PDF download. Mirrors apps/ess/app/tax/projection/page.js.
// Country-gated client-side (fail-closed) AND the backend 422s a non-IN request.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/endpoints.dart';
import '../../core/format.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';
import '../home/country_provider.dart';

final taxProjectionProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final res = await api.get(Api.taxProjection);
  return res is Map<String, dynamic> ? res : <String, dynamic>{};
});

String _inr(Object? v) => Fmt.money(v, fallbackCurrency: 'INR');

class TaxProjectionScreen extends ConsumerWidget {
  const TaxProjectionScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final country = ref.watch(countryContextProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Tax projection')),
      body: country.when(
        loading: () => const LoadingView(),
        error: (_, __) => const EmptyView(text: 'Tax projection is available for India only.'),
        data: (ctx) {
          if (!ctx.isIndia) {
            return const EmptyView(text: 'Tax projection is available for India only.');
          }
          final async = ref.watch(taxProjectionProvider);
          return AsyncView<Map<String, dynamic>>(
            value: async,
            treat404AsEmpty: true,
            emptyText: "We'll show your projection once your salary is set up.",
            onRefresh: () => ref.refresh(taxProjectionProvider.future),
            data: (s) => _Body(s: s),
          );
        },
      ),
    );
  }
}

class _Body extends ConsumerStatefulWidget {
  const _Body({required this.s});

  final Map<String, dynamic> s;

  @override
  ConsumerState<_Body> createState() => _BodyState();
}

class _BodyState extends ConsumerState<_Body> {
  bool _downloading = false;

  Future<void> _download() async {
    setState(() => _downloading = true);
    final err = await ref
        .read(fileDownloaderProvider)
        .openPdf(Api.taxProjectionPdf, filename: 'it-computation.pdf');
    if (!mounted) return;
    setState(() => _downloading = false);
    if (err != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.s;
    if (s.isEmpty) {
      return const EmptyView(text: "We'll show your projection once your salary is set up.");
    }
    final isOld = s['regime'] == 'OLD';
    final earnings = (s['annualEarnings'] as Map?)?.cast<String, dynamic>() ?? const {};
    final hra = (s['hraExemption'] as Map?)?.cast<String, dynamic>();
    final viaLines = ((s['chapterVIA'] as Map?)?['lines'] as List?)
            ?.whereType<Map>()
            .map((e) => e.cast<String, dynamic>())
            .toList() ??
        const [];

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('FY ${s['taxYear']} · ${isOld ? 'Old' : 'New'} regime',
            style: const TextStyle(color: BrandColors.muted, fontSize: 13)),
        const SizedBox(height: 12),

        _Card(
          title: 'Gross salary breakup',
          tip: 'Your annual earnings, projected from your current salary structure.',
          children: [
            KvRow(label: 'Basic + DA', value: _inr(earnings['basicDa'])),
            KvRow(label: 'House Rent Allowance (HRA)', value: _inr(earnings['hra'])),
            KvRow(label: 'Other allowances', value: _inr(earnings['otherAllowances'])),
            KvRow(label: 'Residual / choice pay', value: _inr(earnings['residualChoicePay'])),
            const Divider(height: 16),
            KvRow(label: 'Gross salary', value: _inr(earnings['grossSalary']), strong: true),
          ],
        ),

        if (isOld && hra != null) ...[
          const SizedBox(height: 12),
          _Card(
            title: 'HRA exemption (Section 10(13A))',
            tip: 'The least of: HRA received, rent paid minus 10% of salary, and 50%/40% of salary.',
            children: [
              KvRow(label: 'Exemption (least of three)', value: _inr(hra['exempt']), strong: true),
              KvRow(label: 'Gross earning after exemption', value: _inr(s['grossEarningAfterExemption']), strong: true),
            ],
          ),
        ],

        if (isOld && viaLines.isNotEmpty) ...[
          const SizedBox(height: 12),
          _Card(
            title: 'Deductions under Chapter VI-A',
            tip: 'Each section is capped: deductible = lower of qualifying and the legal limit.',
            children: [
              ...viaLines.map((l) => KvRow(
                    label: '${l['section']}${l['label'] != null ? ' · ${l['label']}' : ''}',
                    value: _inr(l['deductible']),
                  )),
              const Divider(height: 16),
              KvRow(
                  label: 'Total deductible (Chapter VI-A)',
                  value: _inr((s['chapterVIA'] as Map?)?['totalDeductible']),
                  strong: true),
            ],
          ),
        ],

        const SizedBox(height: 12),
        _Card(
          title: 'Taxable income',
          children: [
            KvRow(label: 'Standard deduction', value: _inr(s['standardDeduction'])),
            const Divider(height: 16),
            KvRow(label: 'Total taxable income', value: _inr(s['totalTaxableIncome']), strong: true),
          ],
        ),

        const SizedBox(height: 12),
        _Card(
          title: 'Tax payable',
          children: [
            KvRow(label: 'Tax (before surcharge/cess)', value: _inr(s['taxPayable'])),
            KvRow(label: 'Surcharge', value: _inr(s['surcharge'])),
            KvRow(
                label: 'Health & Education cess (4%)',
                value: _inr(s['cess']),
                tip: 'A 4% cess applies on tax plus surcharge.'),
            const Divider(height: 16),
            KvRow(label: 'Total tax', value: _inr(s['totalTax']), strong: true),
          ],
        ),

        const SizedBox(height: 12),
        _Card(
          title: 'Tax already accounted',
          children: [
            KvRow(
                label: 'Tax deducted this year',
                value: _inr(s['tdsDeductedThisFY']),
                tip: 'Sum of the TDS line across your published payslips this FY.'),
            KvRow(label: 'Tax deducted by previous employer', value: _inr(s['previousEmployerTds'])),
            const Divider(height: 16),
            KvRow(label: 'Balance tax remaining', value: _inr(s['remainingTax']), strong: true),
          ],
        ),

        const SizedBox(height: 12),
        Container(
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(
            color: BrandColors.teal,
            borderRadius: BorderRadius.circular(BrandRadii.lg),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Monthly tax recoverable',
                  style: TextStyle(color: Colors.white70, fontSize: 12, letterSpacing: 0.5)),
              const SizedBox(height: 4),
              Text('${_inr(s['monthlyRecoverable'])} / month',
                  style: const TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.w800)),
              const SizedBox(height: 4),
              Text(
                'across your remaining ${s['monthsRemaining']} month${s['monthsRemaining'] == 1 ? '' : 's'}.',
                style: const TextStyle(color: Colors.white70, fontSize: 13),
              ),
            ],
          ),
        ),

        const SizedBox(height: 16),
        OutlinedButton.icon(
          onPressed: _downloading ? null : _download,
          icon: _downloading
              ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
              : const Icon(Icons.download_outlined, size: 18),
          label: Text(_downloading ? 'Preparing…' : 'Download IT computation (PDF)'),
        ),
        const SizedBox(height: 10),
        const Text(
          'Projected from your current salary and declaration — this is not a Form 16.',
          textAlign: TextAlign.center,
          style: TextStyle(color: BrandColors.muted, fontSize: 11),
        ),
        const SizedBox(height: 24),
      ],
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.title, required this.children, this.tip});

  final String title;
  final String? tip;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SectionHeading(text: title, tip: tip),
          const SizedBox(height: 6),
          ...children,
        ],
      ),
    );
  }
}
