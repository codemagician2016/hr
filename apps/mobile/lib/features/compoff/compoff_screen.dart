// Comp-off — my balance + earned credit lots. Read-only: availing a comp-off is an
// ordinary leave application on the COMP_OFF leave type, so this screen links to
// Leave rather than availing here. SELF-only /api/hr/me/comp-off.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';
import 'compoff_providers.dart';

String _prettyStatus(String raw) => raw
    .split('_')
    .where((s) => s.isNotEmpty)
    .map((s) => s[0].toUpperCase() + s.substring(1).toLowerCase())
    .join(' ');

StatusPill _creditPill(String status) {
  final s = status.toUpperCase();
  Color fg;
  Color bg;
  switch (s) {
    case 'ACTIVE':
      fg = const Color(0xFF047857);
      bg = const Color(0xFFECFDF5);
      break;
    case 'PENDING':
      fg = const Color(0xFFB45309);
      bg = const Color(0xFFFFFBEB);
      break;
    case 'VOIDED':
      fg = const Color(0xFFB91C1C);
      bg = const Color(0xFFFEF2F2);
      break;
    default: // EXPIRED / CONSUMED / unknown
      fg = BrandColors.muted;
      bg = const Color(0xFFF1F5F9);
  }
  return StatusPill(label: _prettyStatus(s.isEmpty ? '—' : s), fg: fg, bg: bg);
}

class CompOffScreen extends ConsumerWidget {
  const CompOffScreen({super.key});

  Future<void> _refresh(WidgetRef ref) async {
    ref.invalidate(compOffBalanceProvider);
    ref.invalidate(compOffCreditsProvider);
    await ref.read(compOffCreditsProvider.future);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final creditsAsync = ref.watch(compOffCreditsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Comp-off')),
      body: AsyncView<List<Map<String, dynamic>>>(
        value: creditsAsync,
        treat404AsEmpty: true,
        emptyText: 'No comp-off credits yet.',
        onRefresh: () => _refresh(ref),
        data: (credits) {
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              const _BalanceCard(),
              const SizedBox(height: 18),
              const _AvailNote(),
              const SizedBox(height: 22),
              const SectionHeading(text: 'Credit lots'),
              const SizedBox(height: 8),
              if (credits.isEmpty)
                const EmptyView(
                  icon: Icons.beach_access_outlined,
                  text: 'No comp-off credits yet.\nCredits you earn will show here with their expiry.',
                )
              else
                ...credits.map((c) => _CreditTile(credit: c)),
              const SizedBox(height: 24),
            ],
          );
        },
      ),
    );
  }
}

class _BalanceCard extends ConsumerWidget {
  const _BalanceCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(compOffBalanceProvider);
    return async.maybeWhen(
      orElse: () => const SectionCard(
        child: SizedBox(height: 64, child: Center(child: CircularProgressIndicator(strokeWidth: 2.4))),
      ),
      data: (b) {
        final available = Fmt.qty(b['available']);
        final lots = (b['lotCount'] as num?)?.toInt() ?? 0;
        final soonest = b['soonestExpiry'];
        return SectionCard(
          child: Row(
            children: [
              Container(
                width: 52,
                height: 52,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: BrandColors.tealSoft,
                  borderRadius: BorderRadius.circular(BrandRadii.md),
                ),
                child: const Icon(Icons.beach_access, color: BrandColors.tealDark),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.baseline,
                      textBaseline: TextBaseline.alphabetic,
                      children: [
                        Text(available,
                            style: const TextStyle(
                                fontSize: 28, fontWeight: FontWeight.w800, color: BrandColors.teal)),
                        const SizedBox(width: 6),
                        const Text('days available',
                            style: TextStyle(color: BrandColors.muted, fontSize: 13)),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(
                      [
                        '$lots active ${lots == 1 ? 'lot' : 'lots'}',
                        if (soonest != null) 'soonest expiry ${Fmt.date(soonest)}',
                      ].join(' · '),
                      style: const TextStyle(color: BrandColors.muted, fontSize: 12),
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _AvailNote extends StatelessWidget {
  const _AvailNote();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: BrandColors.infoSoft,
        borderRadius: BorderRadius.circular(BrandRadii.md),
        border: Border.all(color: BrandColors.info.withValues(alpha: 0.25)),
      ),
      child: Row(
        children: [
          const Icon(Icons.info_outline, size: 18, color: BrandColors.info),
          const SizedBox(width: 10),
          const Expanded(
            child: Text(
              'To take comp-off, apply for leave using the Comp-off leave type.',
              style: TextStyle(color: BrandColors.text, fontSize: 12.5),
            ),
          ),
          TextButton(
            onPressed: () => context.go('/leave'),
            child: const Text('Apply'),
          ),
        ],
      ),
    );
  }
}

class _CreditTile extends StatelessWidget {
  const _CreditTile({required this.credit});

  final Map<String, dynamic> credit;

  @override
  Widget build(BuildContext context) {
    final c = credit;
    final qty = Fmt.qty(c['quantity']);
    final remaining = Fmt.qty(c['remaining'] ?? c['quantity']);
    final consumed = Fmt.numOr0(c['consumed']);
    final status = (c['status'] ?? '').toString();
    final source = _prettyStatus((c['sourceKind'] ?? '').toString());
    final reason = (c['reason'] ?? '').toString();

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: SectionCard(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text('$remaining of $qty ${qty == '1' ? 'day' : 'days'} left',
                      style: const TextStyle(fontWeight: FontWeight.w700, color: BrandColors.text)),
                ),
                _creditPill(status),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              [
                if (source.isNotEmpty) source,
                'Earned ${Fmt.date(c['earnedOn'])}',
                if (c['expiresOn'] != null) 'Expires ${Fmt.date(c['expiresOn'])}',
                if (consumed > 0) 'Used ${Fmt.qty(consumed)}',
              ].where((s) => s.isNotEmpty).join(' · '),
              style: const TextStyle(color: BrandColors.muted, fontSize: 12),
            ),
            if (reason.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(reason, style: const TextStyle(color: BrandColors.muted, fontSize: 12, fontStyle: FontStyle.italic)),
            ],
          ],
        ),
      ),
    );
  }
}
