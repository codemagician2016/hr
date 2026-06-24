// Payslip detail — earnings / deductions / employer contributions split, net,
// LOP block, YTD strip, and the employee's OWN payslip PDF download
// (GET /api/hr/me/payslips/:id/pdf). Mirrors apps/ess/app/payslips/[id]/page.js.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/endpoints.dart';
import '../../core/format.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';
import 'pay_providers.dart';

class PayslipDetailScreen extends ConsumerWidget {
  const PayslipDetailScreen({super.key, required this.payslipId});

  final String payslipId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(payslipDetailProvider(payslipId));
    return Scaffold(
      appBar: AppBar(title: const Text('Payslip')),
      body: AsyncView<Map<String, dynamic>>(
        value: async,
        onRefresh: () => ref.refresh(payslipDetailProvider(payslipId).future),
        data: (slip) => _Body(slip: slip, payslipId: payslipId),
      ),
    );
  }
}

class _Body extends ConsumerStatefulWidget {
  const _Body({required this.slip, required this.payslipId});

  final Map<String, dynamic> slip;
  final String payslipId;

  @override
  ConsumerState<_Body> createState() => _BodyState();
}

class _BodyState extends ConsumerState<_Body> {
  bool _downloading = false;

  Map<String, dynamic> get _snap {
    final s = widget.slip['snapshotJson'];
    return s is Map<String, dynamic> ? s : <String, dynamic>{};
  }

  String get _currency =>
      (widget.slip['currency'] ?? widget.slip['currencyCode'] ?? _snap['currencyCode'] ?? 'INR').toString();

  List<Map<String, dynamic>> _linesFrom(List<String> keys) {
    for (final src in [_snap, widget.slip]) {
      for (final k in keys) {
        final v = src[k];
        if (v is List) {
          return v.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
        }
      }
    }
    return const [];
  }

  ({List<Map<String, dynamic>> earnings, List<Map<String, dynamic>> deductions, List<Map<String, dynamic>> employer})
      _split() {
    final earnings = <Map<String, dynamic>>[
      ..._linesFrom(['earnings']),
    ];
    final deductions = <Map<String, dynamic>>[
      ..._linesFrom(['employeeDeductions', 'deductions']),
    ];
    final employer = <Map<String, dynamic>>[
      ..._linesFrom(['employerContributions', 'employerContrib']),
    ];

    // Flat lines[] with a category/type field.
    final flat = (widget.slip['lines'] ?? widget.slip['components']);
    if (flat is List) {
      for (final raw in flat.whereType<Map>()) {
        final l = raw.cast<String, dynamic>();
        final cat = (l['category'] ?? l['type'] ?? l['kind'] ?? '').toString().toUpperCase();
        if (cat.contains('EARN') || cat == 'ALLOWANCE') {
          earnings.add(l);
        } else if (cat.contains('EMPLOYER') || cat.contains('CONTRIB')) {
          employer.add(l);
        } else if (cat.contains('DEDUC') || cat.contains('TAX') || cat.contains('STATUTORY')) {
          deductions.add(l);
        } else {
          earnings.add(l);
        }
      }
    }
    return (earnings: earnings, deductions: deductions, employer: employer);
  }

  double _sum(List<Map<String, dynamic>> lines) {
    var t = 0.0;
    for (final l in lines) {
      final a = l['amount'];
      if (a is Map) {
        t += Fmt.numOr0(a['amount'] ?? a['value']);
      } else {
        t += Fmt.numOr0(a);
      }
    }
    return t;
  }

  Future<void> _download() async {
    setState(() => _downloading = true);
    final err = await ref
        .read(fileDownloaderProvider)
        .openPdf(Api.payslipPdf(widget.payslipId), filename: 'payslip-${widget.payslipId}.pdf');
    if (!mounted) return;
    setState(() => _downloading = false);
    if (err != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final slip = widget.slip;
    final split = _split();
    final snap = _snap;
    final currency = _currency;
    final gross = snap['gross'] ?? slip['gross'] ?? slip['grossPay'] ?? slip['grossEarnings'];
    final net = snap['net'] ?? slip['net'] ?? slip['netPay'] ?? slip['netPayable'];

    final attendance = snap['attendance'];
    final hasLop = attendance is Map && Fmt.numOr0(attendance['lopDays']) > 0;

    final ytd = slip['yptdJson'] ?? snap['ytd'];

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(
          Fmt.period(slip['period'] ?? slip),
          style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: BrandColors.text),
        ),
        if (slip['payDate'] != null || slip['paidOn'] != null)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text('Paid on ${Fmt.date(slip['payDate'] ?? slip['paidOn'])}',
                style: const TextStyle(color: BrandColors.muted, fontSize: 12)),
          ),
        const SizedBox(height: 16),

        _LinesCard(
          title: 'Earnings',
          lines: split.earnings,
          currency: currency,
          total: gross ?? _sum(split.earnings),
        ),
        if (hasLop) ...[
          const SizedBox(height: 12),
          _LopCard(attendance: (attendance).cast<String, dynamic>(), currency: currency),
        ],
        const SizedBox(height: 12),
        _LinesCard(
          title: 'Deductions',
          lines: split.deductions,
          currency: currency,
          total: _sum(split.deductions),
        ),
        if (split.employer.isNotEmpty) ...[
          const SizedBox(height: 12),
          _LinesCard(
            title: 'Employer contributions',
            lines: split.employer,
            currency: currency,
            total: _sum(split.employer),
          ),
        ],
        const SizedBox(height: 12),

        // Net pay — highlighted brand card.
        Container(
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(
            color: BrandColors.teal,
            borderRadius: BorderRadius.circular(BrandRadii.lg),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text('Net pay',
                  style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
              Text(
                Fmt.money(net, fallbackCurrency: currency),
                style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w800),
              ),
            ],
          ),
        ),

        if (ytd is Map && ytd.isNotEmpty) ...[
          const SizedBox(height: 12),
          SectionCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeading(text: 'Year to date'),
                const SizedBox(height: 6),
                ...ytd.entries.take(6).map((e) => KvRow(
                      label: e.key.toString(),
                      value: e.value is num
                          ? Fmt.money(e.value, fallbackCurrency: currency)
                          : e.value.toString(),
                    )),
              ],
            ),
          ),
        ],

        const SizedBox(height: 16),
        OutlinedButton.icon(
          onPressed: _downloading ? null : _download,
          icon: _downloading
              ? const SizedBox(
                  width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
              : const Icon(Icons.download_outlined, size: 18),
          label: Text(_downloading ? 'Preparing…' : 'Download my payslip'),
        ),
        const SizedBox(height: 24),
      ],
    );
  }
}

class _LinesCard extends StatelessWidget {
  const _LinesCard({
    required this.title,
    required this.lines,
    required this.currency,
    this.total,
  });

  final String title;
  final List<Map<String, dynamic>> lines;
  final String currency;
  final Object? total;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SectionHeading(text: title),
          const SizedBox(height: 4),
          if (lines.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8),
              child: Text('No line items.', style: TextStyle(color: BrandColors.muted)),
            )
          else
            ...lines.map((l) => KvRow(
                  label: (l['label'] ?? l['name'] ?? l['code'] ?? '—').toString(),
                  value: Fmt.money(l['amount'], fallbackCurrency: currency),
                )),
          if (total != null) ...[
            const Divider(height: 16),
            KvRow(label: 'Total', value: Fmt.money(total, fallbackCurrency: currency), strong: true),
          ],
        ],
      ),
    );
  }
}

class _LopCard extends StatelessWidget {
  const _LopCard({required this.attendance, required this.currency});

  final Map<String, dynamic> attendance;
  final String currency;

  @override
  Widget build(BuildContext context) {
    final lop = attendance['lop'];
    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SectionHeading(text: 'Loss of Pay'),
          if (lop is Map)
            KvRow(
              label: (lop['label'] ?? 'Loss of Pay — ${attendance['lopDays']} day(s)').toString(),
              value: '−${Fmt.money(lop['amount'], fallbackCurrency: currency)}',
            ),
          const SizedBox(height: 6),
          Text(
            'Payable days: ${attendance['payableDays']} / ${attendance['standardDays']}  ·  LOP days: ${attendance['lopDays']}',
            style: const TextStyle(color: BrandColors.muted, fontSize: 12),
          ),
          const SizedBox(height: 4),
          const Text(
            'Your net pay already reflects this reduction; this line explains why your pay changed.',
            style: TextStyle(color: BrandColors.muted, fontSize: 11),
          ),
        ],
      ),
    );
  }
}
