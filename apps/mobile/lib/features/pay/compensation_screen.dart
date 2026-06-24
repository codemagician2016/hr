// My CTC — the employee's own compensation breakup (earnings / deductions /
// employer cost) with a monthly/annual toggle, revision history, and a PDF
// download. Mirrors apps/ess/app/compensation/page.js. SELF_ONLY (no :id).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/endpoints.dart';
import '../../core/format.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';
import 'pay_providers.dart';

class CompensationScreen extends ConsumerWidget {
  const CompensationScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(compensationProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('My CTC')),
      body: AsyncView<Map<String, dynamic>>(
        value: async,
        treat404AsEmpty: true,
        emptyText: 'No compensation on record yet — please contact HR.',
        onRefresh: () => ref.refresh(compensationProvider.future),
        data: (data) {
          final current = data['current'];
          if (current is! Map || current['absolute'] is! Map) {
            return const EmptyView(text: 'No compensation on record yet — please contact HR.');
          }
          return _Body(
            current: current.cast<String, dynamic>(),
            history: (data['history'] as List?)
                    ?.whereType<Map>()
                    .map((e) => e.cast<String, dynamic>())
                    .toList() ??
                const [],
          );
        },
      ),
    );
  }
}

class _Body extends ConsumerStatefulWidget {
  const _Body({required this.current, required this.history});

  final Map<String, dynamic> current;
  final List<Map<String, dynamic>> history;

  @override
  ConsumerState<_Body> createState() => _BodyState();
}

class _BodyState extends ConsumerState<_Body> {
  bool _annual = false;
  bool _downloading = false;

  double _lineAmount(Map<String, dynamic> l) {
    final mo = Fmt.numOr0(l['amountMonthly']);
    if (_annual) {
      final an = Fmt.numOr0(l['amountAnnual']);
      return an != 0 ? an : mo * 12;
    }
    return mo;
  }

  ({List<Map<String, dynamic>> earnings, List<Map<String, dynamic>> deductions, List<Map<String, dynamic>> employer})
      _split() {
    final earnings = <Map<String, dynamic>>[];
    final deductions = <Map<String, dynamic>>[];
    final employer = <Map<String, dynamic>>[];
    final lines = widget.current['lines'];
    if (lines is List) {
      for (final raw in lines.whereType<Map>()) {
        final l = raw.cast<String, dynamic>();
        final comp = l['component'];
        final cat = (comp is Map ? comp['category'] : l['category'])?.toString() ?? 'EARNING';
        if (cat == 'EARNING') {
          earnings.add(l);
        } else if (cat == 'EMPLOYER_COST') {
          employer.add(l);
        } else {
          deductions.add(l);
        }
      }
    }
    return (earnings: earnings, deductions: deductions, employer: employer);
  }

  double _sum(List<Map<String, dynamic>> lines) =>
      lines.fold(0.0, (s, l) => s + _lineAmount(l));

  Future<void> _download() async {
    setState(() => _downloading = true);
    final err = await ref
        .read(fileDownloaderProvider)
        .openPdf(Api.compensationPdf, filename: 'compensation-statement.pdf');
    if (!mounted) return;
    setState(() => _downloading = false);
    if (err != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final current = widget.current;
    final abs = (current['absolute'] as Map).cast<String, dynamic>();
    final currency = current['currencyCode']?.toString() ?? 'INR';
    final split = _split();
    final periodWord = _annual ? 'annual' : 'monthly';

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Row(
          children: [
            const Expanded(
              child: Text('My CTC',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: BrandColors.text)),
            ),
            _Toggle(annual: _annual, onChanged: (v) => setState(() => _annual = v)),
          ],
        ),
        const SizedBox(height: 14),
        SectionCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Cost to company (annual)',
                  style: TextStyle(color: BrandColors.muted, fontSize: 12)),
              const SizedBox(height: 2),
              Text(
                Fmt.money(Fmt.numOr0(abs['ctcAnnual']), fallbackCurrency: currency),
                style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: BrandColors.text),
              ),
              const SizedBox(height: 6),
              Text(
                'Gross ($periodWord): ${Fmt.money(_annual ? Fmt.numOr0(abs['grossMonthly']) * 12 : Fmt.numOr0(abs['grossMonthly']), fallbackCurrency: currency)}',
                style: const TextStyle(color: BrandColors.muted, fontSize: 13),
              ),
              if (current['effectiveFrom'] != null)
                Text('Effective ${Fmt.date(current['effectiveFrom'])}',
                    style: const TextStyle(color: BrandColors.muted, fontSize: 12)),
            ],
          ),
        ),
        const SizedBox(height: 12),
        _Group(title: 'Earnings', lines: split.earnings, amountOf: _lineAmount, total: _sum(split.earnings), currency: currency, period: periodWord),
        if (split.deductions.isNotEmpty) ...[
          const SizedBox(height: 12),
          _Group(title: 'My deductions', lines: split.deductions, amountOf: _lineAmount, total: _sum(split.deductions), currency: currency, period: periodWord),
        ],
        if (split.employer.isNotEmpty) ...[
          const SizedBox(height: 12),
          _Group(title: 'Company contributions', note: 'Cost to company — not paid to you', lines: split.employer, amountOf: _lineAmount, total: _sum(split.employer), currency: currency, period: periodWord),
        ],
        if (widget.history.length > 1) ...[
          const SizedBox(height: 12),
          SectionCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeading(text: 'Revision history'),
                const SizedBox(height: 6),
                ...widget.history.map((h) {
                  final hAbs = h['absolute'];
                  final pct = (h['delta'] is Map) ? (h['delta'] as Map)['pct'] : null;
                  return KvRow(
                    label:
                        '${h['effectiveFrom'] != null ? Fmt.date(h['effectiveFrom']) : '—'}${h['revisionReason'] != null ? ' · ${h['revisionReason']}' : ''}',
                    value: hAbs is Map
                        ? '${Fmt.money(Fmt.numOr0(hAbs['ctcAnnual']), fallbackCurrency: currency)}${pct != null ? '  (${(pct as num) > 0 ? '+' : ''}$pct%)' : ''}'
                        : '•••',
                  );
                }),
              ],
            ),
          ),
        ],
        const SizedBox(height: 16),
        FilledButton.icon(
          onPressed: _downloading ? null : _download,
          icon: _downloading
              ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : const Icon(Icons.download_outlined, size: 18),
          label: Text(_downloading ? 'Preparing…' : 'Download CTC (PDF)'),
        ),
        const SizedBox(height: 24),
      ],
    );
  }
}

class _Toggle extends StatelessWidget {
  const _Toggle({required this.annual, required this.onChanged});

  final bool annual;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: BrandColors.border),
        borderRadius: BorderRadius.circular(BrandRadii.md),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _seg('Monthly', !annual, () => onChanged(false)),
          _seg('Annual', annual, () => onChanged(true)),
        ],
      ),
    );
  }

  Widget _seg(String label, bool active, VoidCallback onTap) => GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          decoration: BoxDecoration(
            color: active ? BrandColors.teal : Colors.transparent,
            borderRadius: BorderRadius.circular(BrandRadii.sm),
          ),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w700,
              color: active ? Colors.white : BrandColors.muted,
            ),
          ),
        ),
      );
}

class _Group extends StatelessWidget {
  const _Group({
    required this.title,
    required this.lines,
    required this.amountOf,
    required this.total,
    required this.currency,
    required this.period,
    this.note,
  });

  final String title;
  final String? note;
  final List<Map<String, dynamic>> lines;
  final double Function(Map<String, dynamic>) amountOf;
  final double total;
  final String currency;
  final String period;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SectionHeading(text: title),
          if (note != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(note!, style: const TextStyle(color: BrandColors.muted, fontSize: 12)),
            ),
          const SizedBox(height: 4),
          ...lines.map((l) {
            final comp = l['component'];
            final name = (comp is Map ? comp['name'] : null) ?? l['name'] ?? l['code'] ?? '—';
            return KvRow(label: name.toString(), value: Fmt.money(amountOf(l), fallbackCurrency: currency));
          }),
          const Divider(height: 16),
          KvRow(label: 'Total ($period)', value: Fmt.money(total, fallbackCurrency: currency), strong: true),
        ],
      ),
    );
  }
}
