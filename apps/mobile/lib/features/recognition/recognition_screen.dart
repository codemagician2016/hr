// Rewards & Recognition — a five-tab parity screen over the SELF-scope
// /api/hr/me/* surface: the kudos Wall, the points Wallet + ledger, the Rewards
// catalog + my redemptions, nomination Awards, and the wall Leaderboard. A "Give"
// FAB opens the pushed give flow. Every tab is a live FutureProvider with
// pull-to-refresh; server 4xx (insufficient points, out of stock, already
// nominated, …) is surfaced verbatim.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/format.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';
import 'recognition_common.dart';
import 'recognition_providers.dart';

class RecognitionScreen extends StatelessWidget {
  const RecognitionScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 5,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Recognition'),
          bottom: const TabBar(
            isScrollable: true,
            tabAlignment: TabAlignment.start,
            labelColor: BrandColors.tealDark,
            unselectedLabelColor: BrandColors.muted,
            indicatorColor: BrandColors.teal,
            tabs: [
              Tab(text: 'Wall'),
              Tab(text: 'Wallet'),
              Tab(text: 'Rewards'),
              Tab(text: 'Awards'),
              Tab(text: 'Leaderboard'),
            ],
          ),
        ),
        floatingActionButton: FloatingActionButton.extended(
          onPressed: () => context.push('/recognition/give'),
          backgroundColor: BrandColors.teal,
          foregroundColor: Colors.white,
          icon: const Icon(Icons.emoji_events_outlined),
          label: const Text('Give'),
        ),
        body: const TabBarView(
          children: [
            _WallTab(),
            _WalletTab(),
            _RewardsTab(),
            _AwardsTab(),
            _LeaderboardTab(),
          ],
        ),
      ),
    );
  }
}

// ── Wall ──────────────────────────────────────────────────────────────────────
class _WallTab extends ConsumerWidget {
  const _WallTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(recognitionWallProvider);
    return AsyncView<List<Map<String, dynamic>>>(
      value: async,
      treat404AsEmpty: true,
      emptyText: 'No recognitions yet.',
      onRefresh: () async {
        ref.invalidate(recognitionWallProvider);
        await ref.read(recognitionWallProvider.future);
      },
      data: (items) {
        if (items.isEmpty) {
          return ListView(
            children: const [
              SizedBox(height: 80),
              EmptyView(
                icon: Icons.emoji_events_outlined,
                text: 'No recognitions yet.\nTap Give to celebrate a colleague.',
              ),
            ],
          );
        }
        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            for (final r in items) _RecognitionCard(r: r),
            const SizedBox(height: 88),
          ],
        );
      },
    );
  }
}

class _RecognitionCard extends StatelessWidget {
  const _RecognitionCard({required this.r});

  final Map<String, dynamic> r;

  @override
  Widget build(BuildContext context) {
    final giver = r['giver'] is Map ? (r['giver'] as Map).cast<String, dynamic>() : null;
    final recipients = asList(r, keys: const ['recipients']);
    final value = r['value'] is Map ? (r['value'] as Map).cast<String, dynamic>() : null;
    final badge = r['badge'] is Map ? (r['badge'] as Map).cast<String, dynamic>() : null;
    final pointsEach = (r['pointsEach'] as num?)?.toInt() ?? 0;
    final message = (r['message'] ?? '').toString();
    final status = (r['status'] ?? 'POSTED').toString().toUpperCase();
    final recipientNames = recipients.map((e) {
      final emp = e['employee'] is Map ? (e['employee'] as Map).cast<String, dynamic>() : e;
      return personName(emp);
    }).toList();

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: SectionCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                PersonAvatar(name: personName(giver), size: 38),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text.rich(
                        TextSpan(
                          style: const TextStyle(fontSize: 13.5, color: BrandColors.text, height: 1.3),
                          children: [
                            TextSpan(
                                text: personName(giver),
                                style: const TextStyle(fontWeight: FontWeight.w800)),
                            const TextSpan(text: '  recognised  ', style: TextStyle(color: BrandColors.muted)),
                            TextSpan(
                                text: recipientNames.isEmpty ? 'a colleague' : recipientNames.join(', '),
                                style: const TextStyle(fontWeight: FontWeight.w800)),
                          ],
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(Fmt.date(r['postedAt'] ?? r['createdAt']),
                          style: const TextStyle(color: BrandColors.muted, fontSize: 11.5)),
                    ],
                  ),
                ),
                if (status != 'POSTED') ...[
                  const SizedBox(width: 8),
                  StatusPill.forStatus(status == 'PENDING_APPROVAL' ? 'PENDING' : status),
                ],
              ],
            ),
            if (message.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(message, style: const TextStyle(color: BrandColors.text, fontSize: 13.5, height: 1.35)),
            ],
            if (value != null || badge != null || pointsEach > 0) ...[
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  if (value != null) ValueChip(value: value),
                  if (badge != null)
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                      decoration: BoxDecoration(
                        color: BrandColors.violetSoft,
                        borderRadius: BorderRadius.circular(BrandRadii.pill),
                        border: Border.all(color: BrandColors.violet.withValues(alpha: 0.3)),
                      ),
                      child: Text(
                        [if ('${badge['icon'] ?? ''}'.isNotEmpty) badge['icon'], badge['name'] ?? 'Badge'].join(' '),
                        style: const TextStyle(color: BrandColors.violet, fontWeight: FontWeight.w700, fontSize: 12),
                      ),
                    ),
                  if (pointsEach > 0) PointsChip(points: pointsEach),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

// ── Wallet ─────────────────────────────────────────────────────────────────────
class _WalletTab extends ConsumerWidget {
  const _WalletTab();

  String _reasonLabel(String reason) {
    switch (reason.toUpperCase()) {
      case 'RECOGNITION':
        return 'Recognition received';
      case 'AWARD':
        return 'Award';
      case 'REDEMPTION':
        return 'Reward redeemed';
      case 'REVERSAL':
        return 'Reversal';
      case 'EXPIRY':
        return 'Points expired';
      case 'ADJUSTMENT':
        return 'Adjustment';
      default:
        final l = reason.toLowerCase().replaceAll('_', ' ');
        return l.isEmpty ? 'Entry' : l[0].toUpperCase() + l.substring(1);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final walletAsync = ref.watch(walletProvider);
    return AsyncView<Map<String, dynamic>>(
      value: walletAsync,
      treat404AsEmpty: true,
      emptyText: 'No wallet yet.',
      onRefresh: () async {
        ref.invalidate(walletProvider);
        ref.invalidate(walletLedgerProvider);
        await ref.read(walletProvider.future);
      },
      data: (wallet) {
        final pointsEnabled = wallet['pointsEnabled'] != false;
        final balance = (wallet['balance'] as num?)?.toInt() ?? 0;
        final lifetime = (wallet['lifetimeEarned'] as num?)?.toInt() ?? 0;
        final inrValue = wallet['inrValue'];
        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (!pointsEnabled)
              const SectionCard(
                child: Text(
                  'The points economy is off for your company. Recognition is still celebrated on the wall.',
                  style: TextStyle(color: BrandColors.muted, fontSize: 13),
                ),
              )
            else ...[
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    colors: [BrandColors.teal, BrandColors.tealDark],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                  borderRadius: BorderRadius.circular(BrandRadii.lg),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Points balance',
                        style: TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 6),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.baseline,
                      textBaseline: TextBaseline.alphabetic,
                      children: [
                        Text('$balance',
                            style: const TextStyle(color: Colors.white, fontSize: 34, fontWeight: FontWeight.w800)),
                        const SizedBox(width: 6),
                        const Text('pts', style: TextStyle(color: Colors.white70, fontSize: 15, fontWeight: FontWeight.w700)),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        if (inrValue != null)
                          Text('≈ ${Fmt.money(inrValue)}',
                              style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w600)),
                        if (inrValue != null) const SizedBox(width: 12),
                        Text('Lifetime earned $lifetime',
                            style: const TextStyle(color: Colors.white70, fontSize: 12)),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 22),
              const SectionHeading(text: 'Points activity'),
              const SizedBox(height: 8),
              _LedgerList(reasonLabel: _reasonLabel),
            ],
            const SizedBox(height: 24),
          ],
        );
      },
    );
  }
}

class _LedgerList extends ConsumerWidget {
  const _LedgerList({required this.reasonLabel});

  final String Function(String) reasonLabel;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(walletLedgerProvider);
    return async.when(
      loading: () => const LoadingView(),
      error: (_, __) => const EmptyView(text: 'No points activity yet.'),
      data: (entries) {
        if (entries.isEmpty) return const EmptyView(icon: Icons.receipt_long_outlined, text: 'No points activity yet.');
        return SectionCard(
          padding: EdgeInsets.zero,
          child: Column(
            children: [
              for (var i = 0; i < entries.length; i++) ...[
                if (i > 0) const Divider(height: 1),
                _LedgerRow(entry: entries[i], label: reasonLabel),
              ],
            ],
          ),
        );
      },
    );
  }
}

class _LedgerRow extends StatelessWidget {
  const _LedgerRow({required this.entry, required this.label});

  final Map<String, dynamic> entry;
  final String Function(String) label;

  @override
  Widget build(BuildContext context) {
    final points = (entry['points'] as num?)?.toInt() ?? 0;
    final reason = (entry['reason'] ?? '').toString();
    final note = (entry['note'] ?? '').toString();
    final expiresAt = entry['expiresAt'];
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label(reason),
                    style: const TextStyle(fontWeight: FontWeight.w700, color: BrandColors.text, fontSize: 13.5)),
                const SizedBox(height: 2),
                Text(
                  [
                    Fmt.date(entry['createdAt']),
                    if (note.isNotEmpty) note,
                    if (expiresAt != null) 'expires ${Fmt.date(expiresAt)}',
                  ].where((s) => s.isNotEmpty).join(' · '),
                  style: const TextStyle(color: BrandColors.muted, fontSize: 11.5),
                ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          PointsChip(points: points, signed: true),
        ],
      ),
    );
  }
}

// ── Rewards ────────────────────────────────────────────────────────────────────
class _RewardsTab extends ConsumerWidget {
  const _RewardsTab();

  Future<void> _redeem(BuildContext context, WidgetRef ref, Map<String, dynamic> item, int balance) async {
    final cost = (item['pointsCost'] as num?)?.toInt() ?? 0;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Redeem reward'),
        content: Text(
          'Redeem “${item['name']}” for $cost points?\n\nYou have $balance points and will have ${balance - cost} left.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Redeem')),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      final res = await ref.read(apiClientProvider).post(Api.redemptions, {'catalogItemId': item['id']});
      final redemption = res is Map ? res['redemption'] : null;
      final status = (redemption is Map ? redemption['status'] : null)?.toString() ?? 'PENDING';
      ref.invalidate(catalogProvider);
      ref.invalidate(walletProvider);
      ref.invalidate(walletLedgerProvider);
      ref.invalidate(myRedemptionsProvider);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(status == 'APPROVED'
              ? 'Redeemed! Check "My redemptions" for fulfilment.'
              : 'Redemption submitted — pending approval.'),
        ));
      }
    } on ApiException catch (e) {
      // Verbatim server message — e.g. "You need 500 points (you have 120)".
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(catalogProvider);
    return AsyncView<Map<String, dynamic>>(
      value: async,
      treat404AsEmpty: true,
      emptyText: 'No rewards catalog yet.',
      onRefresh: () async {
        ref.invalidate(catalogProvider);
        ref.invalidate(myRedemptionsProvider);
        await ref.read(catalogProvider.future);
      },
      data: (catalog) {
        final pointsEnabled = catalog['pointsEnabled'] != false;
        final balance = (catalog['balance'] as num?)?.toInt() ?? 0;
        final items = asList(catalog, keys: const ['items']);
        if (!pointsEnabled) {
          return ListView(
            children: const [
              SizedBox(height: 80),
              EmptyView(
                icon: Icons.card_giftcard_outlined,
                text: 'The rewards store is off for your company.',
              ),
            ],
          );
        }
        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _BalanceStrip(balance: balance),
            const SizedBox(height: 18),
            const SectionHeading(text: 'Rewards store'),
            const SizedBox(height: 10),
            if (items.isEmpty)
              const EmptyView(icon: Icons.card_giftcard_outlined, text: 'No rewards available right now.')
            else
              GridView.count(
                crossAxisCount: 2,
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                mainAxisSpacing: 12,
                crossAxisSpacing: 12,
                childAspectRatio: 0.82,
                children: items
                    .map((i) => _CatalogCard(
                          item: i,
                          balance: balance,
                          onRedeem: () => _redeem(context, ref, i, balance),
                        ))
                    .toList(),
              ),
            const SizedBox(height: 22),
            const SectionHeading(text: 'My redemptions'),
            const SizedBox(height: 8),
            const _MyRedemptions(),
            const SizedBox(height: 88),
          ],
        );
      },
    );
  }
}

class _BalanceStrip extends StatelessWidget {
  const _BalanceStrip({required this.balance});

  final int balance;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      child: Row(
        children: [
          Container(
            width: 42,
            height: 42,
            alignment: Alignment.center,
            decoration: BoxDecoration(color: BrandColors.tealSoft, borderRadius: BorderRadius.circular(BrandRadii.md)),
            child: const Icon(Icons.account_balance_wallet_outlined, color: BrandColors.tealDark, size: 22),
          ),
          const SizedBox(width: 12),
          const Expanded(
            child: Text('Available to spend', style: TextStyle(color: BrandColors.muted, fontSize: 13)),
          ),
          Text('$balance pts',
              style: const TextStyle(color: BrandColors.text, fontWeight: FontWeight.w800, fontSize: 18)),
        ],
      ),
    );
  }
}

class _CatalogCard extends StatelessWidget {
  const _CatalogCard({required this.item, required this.balance, required this.onRedeem});

  final Map<String, dynamic> item;
  final int balance;
  final VoidCallback onRedeem;

  @override
  Widget build(BuildContext context) {
    final name = (item['name'] ?? 'Reward').toString();
    final category = (item['category'] ?? '').toString();
    final cost = (item['pointsCost'] as num?)?.toInt() ?? 0;
    final inStock = item['inStock'] != false;
    final affordable = item['affordable'] == true || balance >= cost;
    final taxable = item['isTaxablePerk'] == true || item['taxablePerk'] == true;
    final canRedeem = inStock && affordable;

    return SectionCard(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (category.isNotEmpty)
            Text(category.replaceAll('_', ' '),
                style: const TextStyle(color: BrandColors.muted, fontSize: 10.5, fontWeight: FontWeight.w700, letterSpacing: 0.4)),
          const SizedBox(height: 4),
          Text(name,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: BrandColors.text, fontWeight: FontWeight.w700, fontSize: 13.5, height: 1.25)),
          const SizedBox(height: 6),
          Row(
            children: [
              PointsChip(points: cost),
              if (taxable) ...[
                const SizedBox(width: 6),
                const Icon(Icons.info_outline, size: 13, color: BrandColors.muted),
              ],
            ],
          ),
          const Spacer(),
          if (!inStock)
            const Text('Out of stock', style: TextStyle(color: BrandColors.danger, fontSize: 11.5, fontWeight: FontWeight.w700))
          else if (!affordable)
            Text('Need ${cost - balance} more', style: const TextStyle(color: BrandColors.muted, fontSize: 11.5)),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              onPressed: canRedeem ? onRedeem : null,
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(38),
                textStyle: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13),
              ),
              child: const Text('Redeem'),
            ),
          ),
        ],
      ),
    );
  }
}

class _MyRedemptions extends ConsumerWidget {
  const _MyRedemptions();

  Future<void> _cancel(BuildContext context, WidgetRef ref, String id) async {
    try {
      await ref.read(apiClientProvider).post(Api.redemptionCancel(id), {});
      ref.invalidate(myRedemptionsProvider);
      ref.invalidate(walletProvider);
      ref.invalidate(catalogProvider);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Redemption cancelled.')));
      }
    } on ApiException catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(myRedemptionsProvider);
    return async.when(
      loading: () => const LoadingView(),
      error: (_, __) => const EmptyView(text: 'You have no redemptions yet.'),
      data: (items) {
        if (items.isEmpty) return const EmptyView(icon: Icons.redeem_outlined, text: 'You have no redemptions yet.');
        return Column(
          children: items.map((r) {
            final ci = r['catalogItem'] is Map ? (r['catalogItem'] as Map).cast<String, dynamic>() : null;
            final name = (ci?['name'] ?? 'Reward').toString();
            final spent = (r['pointsSpent'] as num?)?.toInt() ?? 0;
            final status = (r['status'] ?? '').toString();
            final ref0 = (r['fulfilmentRef'] ?? '').toString();
            return Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: SectionCard(
                padding: const EdgeInsets.all(12),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(name, style: const TextStyle(fontWeight: FontWeight.w700, color: BrandColors.text)),
                          const SizedBox(height: 3),
                          Text(
                            [
                              '$spent pts',
                              Fmt.date(r['createdAt']),
                              if (ref0.isNotEmpty) ref0,
                            ].join(' · '),
                            style: const TextStyle(color: BrandColors.muted, fontSize: 11.5),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    StatusPill.forStatus(status),
                    if (status.toUpperCase() == 'PENDING')
                      TextButton(
                        onPressed: () => _cancel(context, ref, r['id'].toString()),
                        child: const Text('Cancel'),
                      ),
                  ],
                ),
              ),
            );
          }).toList(),
        );
      },
    );
  }
}

// ── Awards ─────────────────────────────────────────────────────────────────────
class _AwardsTab extends ConsumerWidget {
  const _AwardsTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(awardCyclesProvider);
    return AsyncView<List<Map<String, dynamic>>>(
      value: async,
      treat404AsEmpty: true,
      emptyText: 'No open awards right now.',
      onRefresh: () async {
        ref.invalidate(awardCyclesProvider);
        ref.invalidate(myNominationsProvider);
        await ref.read(awardCyclesProvider.future);
      },
      data: (cycles) {
        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const SectionHeading(text: 'Open for nominations'),
            const SizedBox(height: 8),
            if (cycles.isEmpty)
              const EmptyView(icon: Icons.workspace_premium_outlined, text: 'No awards are open for nominations right now.')
            else
              for (final c in cycles) _CycleCard(cycle: c),
            const SizedBox(height: 22),
            const SectionHeading(text: 'My nominations'),
            const SizedBox(height: 8),
            const _MyNominations(),
            const SizedBox(height: 88),
          ],
        );
      },
    );
  }
}

class _CycleCard extends ConsumerWidget {
  const _CycleCard({required this.cycle});

  final Map<String, dynamic> cycle;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name = (cycle['name'] ?? 'Award').toString();
    final type = (cycle['awardType'] ?? '').toString();
    final period = (cycle['periodLabel'] ?? '').toString();
    final points = (cycle['pointsToWinner'] as num?)?.toInt() ?? 0;
    final closesAt = cycle['nominateCloseAt'];
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: SectionCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Text('🏆', style: TextStyle(fontSize: 20)),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(name,
                      style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: BrandColors.text)),
                ),
                if (points > 0) PointsChip(points: points),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              [
                if (type.isNotEmpty) type.replaceAll('_', ' '),
                if (period.isNotEmpty) period,
                if (closesAt != null) 'Closes ${Fmt.date(closesAt)}',
              ].where((s) => s.isNotEmpty).join(' · '),
              style: const TextStyle(color: BrandColors.muted, fontSize: 12),
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: () => _openNominateSheet(context, ref, cycle),
                icon: const Icon(Icons.person_add_alt_1_outlined, size: 18),
                label: const Text('Nominate a colleague'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MyNominations extends ConsumerWidget {
  const _MyNominations();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(myNominationsProvider);
    return async.when(
      loading: () => const LoadingView(),
      error: (_, __) => const EmptyView(text: 'You have not nominated anyone yet.'),
      data: (data) {
        final made = asList(data, keys: const ['made']);
        final won = asList(data, keys: const ['won']);
        if (made.isEmpty && won.isEmpty) {
          return const EmptyView(icon: Icons.emoji_events_outlined, text: 'You have not nominated anyone yet.');
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (won.isNotEmpty) ...[
              for (final w in won) _NominationRow(nom: w, isWin: true),
            ],
            for (final m in made) _NominationRow(nom: m, isWin: false),
          ],
        );
      },
    );
  }
}

class _NominationRow extends StatelessWidget {
  const _NominationRow({required this.nom, required this.isWin});

  final Map<String, dynamic> nom;
  final bool isWin;

  @override
  Widget build(BuildContext context) {
    final cycle = nom['cycle'] is Map ? (nom['cycle'] as Map).cast<String, dynamic>() : null;
    final nominee = nom['nominee'] is Map ? (nom['nominee'] as Map).cast<String, dynamic>() : null;
    final citation = (nom['citation'] ?? '').toString();
    final status = (nom['status'] ?? '').toString();
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
                  child: Text(
                    isWin ? '🎉 You won: ${cycle?['name'] ?? 'Award'}' : (cycle?['name'] ?? 'Award').toString(),
                    style: const TextStyle(fontWeight: FontWeight.w800, color: BrandColors.text, fontSize: 13.5),
                  ),
                ),
                const SizedBox(width: 8),
                StatusPill.forStatus(status),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              'Nominee: ${personName(nominee)}',
              style: const TextStyle(color: BrandColors.muted, fontSize: 12),
            ),
            if (citation.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(citation,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: BrandColors.text, fontSize: 12.5, height: 1.3)),
            ],
          ],
        ),
      ),
    );
  }
}

/// The nominate modal — a single-colleague picker + citation. Surfaces the 409
/// "already nominated" / "window closed" server message verbatim.
Future<void> _openNominateSheet(BuildContext context, WidgetRef ref, Map<String, dynamic> cycle) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    backgroundColor: BrandColors.card,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
    builder: (_) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: _NominateSheet(cycle: cycle, parentRef: ref),
    ),
  );
}

class _NominateSheet extends ConsumerStatefulWidget {
  const _NominateSheet({required this.cycle, required this.parentRef});

  final Map<String, dynamic> cycle;
  final WidgetRef parentRef;

  @override
  ConsumerState<_NominateSheet> createState() => _NominateSheetState();
}

class _NominateSheetState extends ConsumerState<_NominateSheet> {
  Map<String, dynamic>? _nominee;
  final _citation = TextEditingController();
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _citation.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_nominee == null) {
      setState(() => _error = 'Pick a colleague to nominate.');
      return;
    }
    if (_citation.text.trim().isEmpty) {
      setState(() => _error = 'Add a citation — say why they deserve it.');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await ref.read(apiClientProvider).post(Api.awardNominations, {
        'cycleId': widget.cycle['id'],
        'nomineeEmployeeId': _nominee!['id'],
        'citation': _citation.text.trim(),
      });
      widget.parentRef.invalidate(myNominationsProvider);
      if (mounted) {
        Navigator.of(context).pop();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Nominated ${personName(_nominee)} for ${widget.cycle['name']}.')),
        );
      }
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not submit your nomination.');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Nominate for ${widget.cycle['name']}',
                  style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: BrandColors.text)),
              const SizedBox(height: 14),
              if (_error != null) ...[ErrorBanner(message: _error!), const SizedBox(height: 12)],
              if (_nominee != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Row(
                    children: [
                      PersonAvatar(name: personName(_nominee), size: 34),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(personName(_nominee),
                            style: const TextStyle(fontWeight: FontWeight.w700, color: BrandColors.text)),
                      ),
                      TextButton(
                        onPressed: () => setState(() => _nominee = null),
                        child: const Text('Change'),
                      ),
                    ],
                  ),
                )
              else
                ColleagueSearchField(
                  hint: 'Search the colleague to nominate',
                  onPick: (p) => setState(() => _nominee = p),
                ),
              const SizedBox(height: 12),
              TextField(
                controller: _citation,
                maxLines: 4,
                maxLength: 4000,
                decoration: const InputDecoration(
                  labelText: 'Citation',
                  hintText: 'Why do they deserve this award?',
                  alignLabelWithHint: true,
                ),
              ),
              const SizedBox(height: 8),
              FilledButton(
                onPressed: _submitting ? null : _submit,
                child: _submitting
                    ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : const Text('Submit nomination'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ── Leaderboard ─────────────────────────────────────────────────────────────────
class _LeaderboardTab extends ConsumerStatefulWidget {
  const _LeaderboardTab();

  @override
  ConsumerState<_LeaderboardTab> createState() => _LeaderboardTabState();
}

class _LeaderboardTabState extends ConsumerState<_LeaderboardTab> {
  String _period = 'month';
  String _board = 'earners';

  static const _periods = <(String, String)>[('month', 'Month'), ('quarter', 'Quarter'), ('allTime', 'All time')];

  @override
  Widget build(BuildContext context) {
    final args = (period: _period, board: _board);
    final async = ref.watch(leaderboardProvider(args));
    return RefreshIndicator(
      color: BrandColors.teal,
      onRefresh: () async {
        ref.invalidate(leaderboardProvider(args));
        await ref.read(leaderboardProvider(args).future);
      },
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'earners', label: Text('Top earners'), icon: Icon(Icons.star_outline, size: 16)),
              ButtonSegment(value: 'givers', label: Text('Top givers'), icon: Icon(Icons.volunteer_activism_outlined, size: 16)),
            ],
            selected: {_board},
            onSelectionChanged: (s) => setState(() => _board = s.first),
            showSelectedIcon: false,
            style: const ButtonStyle(
              visualDensity: VisualDensity.compact,
              textStyle: WidgetStatePropertyAll(TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700)),
            ),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            children: _periods.map((p) {
              final sel = p.$1 == _period;
              return ChoiceChip(
                label: Text(p.$2),
                selected: sel,
                showCheckmark: false,
                selectedColor: BrandColors.tealSoft,
                side: BorderSide(color: sel ? BrandColors.teal : BrandColors.border),
                labelStyle: TextStyle(
                  color: sel ? BrandColors.tealDark : BrandColors.text,
                  fontWeight: sel ? FontWeight.w800 : FontWeight.w600,
                  fontSize: 12.5,
                ),
                onSelected: (_) => setState(() => _period = p.$1),
              );
            }).toList(),
          ),
          const SizedBox(height: 16),
          async.when(
            loading: () => const Padding(padding: EdgeInsets.only(top: 40), child: LoadingView()),
            error: (err, __) {
              final msg = err is ApiException ? err.message : 'Could not load the leaderboard.';
              return Padding(padding: const EdgeInsets.only(top: 24), child: ErrorView(message: msg));
            },
            data: (board) {
              final rows = asList(board, keys: const ['rows']);
              final me = board['me'] is Map ? (board['me'] as Map).cast<String, dynamic>() : null;
              final myRank = me == null ? null : (me['rank'] as num?)?.toInt();
              if (rows.isEmpty) {
                return const Padding(
                  padding: EdgeInsets.only(top: 40),
                  child: EmptyView(icon: Icons.leaderboard_outlined, text: 'No leaderboard data for this period yet.'),
                );
              }
              return Column(
                children: [
                  if (me != null && (myRank == null || myRank > rows.length))
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: _LeaderRow(row: me, board: _board, highlight: true),
                    ),
                  SectionCard(
                    padding: EdgeInsets.zero,
                    child: Column(
                      children: [
                        for (var i = 0; i < rows.length; i++) ...[
                          if (i > 0) const Divider(height: 1),
                          _LeaderRow(
                            row: rows[i],
                            board: _board,
                            highlight: me != null && rows[i]['employeeId'] == me['employeeId'],
                          ),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(height: 88),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

class _LeaderRow extends StatelessWidget {
  const _LeaderRow({required this.row, required this.board, this.highlight = false});

  final Map<String, dynamic> row;
  final String board;
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    final rank = (row['rank'] as num?)?.toInt() ?? 0;
    final name = personName(row);
    final metric = board == 'givers'
        ? '${(row['count'] as num?)?.toInt() ?? 0} given'
        : '${(row['points'] as num?)?.toInt() ?? 0} pts';
    final medal = rank == 1 ? '🥇' : rank == 2 ? '🥈' : rank == 3 ? '🥉' : null;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      decoration: BoxDecoration(
        color: highlight ? BrandColors.tealSoft : null,
        borderRadius: BorderRadius.circular(highlight ? BrandRadii.md : 0),
      ),
      child: Row(
        children: [
          SizedBox(
            width: 30,
            child: medal != null
                ? Text(medal, style: const TextStyle(fontSize: 18))
                : Text('$rank',
                    style: const TextStyle(fontWeight: FontWeight.w800, color: BrandColors.muted, fontSize: 14)),
          ),
          const SizedBox(width: 6),
          PersonAvatar(name: name, size: 32),
          const SizedBox(width: 10),
          Expanded(
            child: Text(highlight ? '$name (you)' : name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                    fontWeight: highlight ? FontWeight.w800 : FontWeight.w600,
                    color: BrandColors.text,
                    fontSize: 13.5)),
          ),
          const SizedBox(width: 8),
          Text(metric,
              style: const TextStyle(fontWeight: FontWeight.w800, color: BrandColors.tealDark, fontSize: 13)),
        ],
      ),
    );
  }
}
