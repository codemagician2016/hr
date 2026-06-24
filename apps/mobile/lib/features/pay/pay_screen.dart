// Pay tab — the employee's own payslips (paginated) + quick links to the CTC
// statement and (India) tax projection. Mirrors apps/ess/app/payslips/page.js.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';
import '../home/country_provider.dart';
import 'pay_providers.dart';

class PayScreen extends ConsumerStatefulWidget {
  const PayScreen({super.key});

  @override
  ConsumerState<PayScreen> createState() => _PayScreenState();
}

class _PayScreenState extends ConsumerState<PayScreen> {
  int _page = 1;
  static const _pageSize = 10;

  @override
  Widget build(BuildContext context) {
    final args = (page: _page, pageSize: _pageSize);
    final async = ref.watch(payslipsProvider(args));
    final isIndia = ref.watch(countryContextProvider).valueOrNull?.isIndia ?? false;

    return Scaffold(
      appBar: AppBar(title: const Text('Pay')),
      body: AsyncView<({List<Map<String, dynamic>> items, int total})>(
        value: async,
        treat404AsEmpty: true,
        emptyText: 'No payslips available yet.',
        onRefresh: () => ref.refresh(payslipsProvider(args).future),
        data: (data) {
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              // Quick links
              Row(
                children: [
                  Expanded(
                    child: _LinkCard(
                      icon: Icons.account_balance_wallet_outlined,
                      title: 'My CTC',
                      subtitle: 'Cost-to-company breakup',
                      onTap: () => context.push('/compensation'),
                    ),
                  ),
                  if (isIndia) ...[
                    const SizedBox(width: 12),
                    Expanded(
                      child: _LinkCard(
                        icon: Icons.calculate_outlined,
                        title: 'Tax',
                        subtitle: 'IT projection & TDS',
                        onTap: () => context.push('/tax'),
                      ),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 20),
              const SectionHeading(text: 'Payslips'),
              const SizedBox(height: 8),
              if (data.items.isEmpty)
                const Padding(
                  padding: EdgeInsets.only(top: 40),
                  child: EmptyView(text: 'No payslips available yet.'),
                )
              else
                ...data.items.map(_PayslipTile.new),
              if (data.total > _pageSize) ...[
                const SizedBox(height: 12),
                _Pager(
                  page: _page,
                  pageSize: _pageSize,
                  total: data.total,
                  onPage: (p) => setState(() => _page = p),
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _PayslipTile extends StatelessWidget {
  const _PayslipTile(this.slip);

  final Map<String, dynamic> slip;

  @override
  Widget build(BuildContext context) {
    final net = slip['net'] ?? slip['netPay'] ?? slip['netPayable'];
    final currency = (slip['currency'] ?? slip['currencyCode'] ?? 'INR').toString();
    final id = slip['id']?.toString();
    final status = slip['status']?.toString();

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: SectionCard(
        padding: EdgeInsets.zero,
        child: ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          title: Text(
            Fmt.period(slip['period'] ?? slip),
            style: const TextStyle(fontWeight: FontWeight.w600, color: BrandColors.text),
          ),
          subtitle: status == null
              ? null
              : Text(status.toLowerCase(), style: const TextStyle(color: BrandColors.muted, fontSize: 12)),
          trailing: Text(
            Fmt.money(net, fallbackCurrency: currency),
            style: const TextStyle(fontWeight: FontWeight.w700, color: BrandColors.teal),
          ),
          onTap: id == null ? null : () => context.push('/payslips/$id'),
        ),
      ),
    );
  }
}

class _LinkCard extends StatelessWidget {
  const _LinkCard({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(BrandRadii.lg),
      onTap: onTap,
      child: SectionCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: BrandColors.teal,
                borderRadius: BorderRadius.circular(BrandRadii.md),
              ),
              child: Icon(icon, color: Colors.white, size: 20),
            ),
            const SizedBox(height: 10),
            Text(title, style: const TextStyle(fontWeight: FontWeight.w700, color: BrandColors.text)),
            Text(subtitle, style: const TextStyle(color: BrandColors.muted, fontSize: 12)),
          ],
        ),
      ),
    );
  }
}

/// Simple page navigator (Prev / "page x of y" / Next) for server pagination.
class _Pager extends StatelessWidget {
  const _Pager({
    required this.page,
    required this.pageSize,
    required this.total,
    required this.onPage,
  });

  final int page;
  final int pageSize;
  final int total;
  final ValueChanged<int> onPage;

  @override
  Widget build(BuildContext context) {
    final pages = (total / pageSize).ceil().clamp(1, 1 << 30);
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        TextButton.icon(
          onPressed: page > 1 ? () => onPage(page - 1) : null,
          icon: const Icon(Icons.chevron_left, size: 18),
          label: const Text('Prev'),
        ),
        Text('Page $page of $pages',
            style: const TextStyle(color: BrandColors.muted, fontSize: 13)),
        TextButton(
          onPressed: page < pages ? () => onPage(page + 1) : null,
          child: const Row(
            mainAxisSize: MainAxisSize.min,
            children: [Text('Next'), Icon(Icons.chevron_right, size: 18)],
          ),
        ),
      ],
    );
  }
}
