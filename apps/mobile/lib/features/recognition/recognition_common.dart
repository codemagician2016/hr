// Shared R&R atoms: the colleague search field (directory-backed, debounced), a
// value/badge chip, a points chip, an approval-pending banner, and small helpers
// for names/points/colours reused across the tabs and the Give / Nominate flows.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../theme/app_theme.dart';
import 'recognition_providers.dart';

// ── name helpers ────────────────────────────────────────────────────────────────
String personName(Map<String, dynamic>? p) {
  if (p == null) return 'A colleague';
  final n = (p['name'] ?? '').toString().trim();
  if (n.isNotEmpty) return n;
  final joined = [p['firstName'], p['lastName']].where((x) => x != null && '$x'.trim().isNotEmpty).join(' ').trim();
  if (joined.isNotEmpty) return joined;
  return (p['code'] ?? 'A colleague').toString();
}

String initialsOf(String name) {
  final parts = name.trim().split(RegExp(r'\s+')).where((s) => s.isNotEmpty).toList();
  if (parts.isEmpty) return '?';
  if (parts.length == 1) return parts.first.characters.first.toUpperCase();
  return (parts.first.characters.first + parts.last.characters.first).toUpperCase();
}

/// Parse a `#RRGGBB` hex to a Color, falling back to the brand teal.
Color hexColor(Object? hex, {Color fallback = BrandColors.teal}) {
  final s = (hex ?? '').toString().trim().replaceFirst('#', '');
  if (s.length == 6) {
    final v = int.tryParse(s, radix: 16);
    if (v != null) return Color(0xFF000000 | v);
  }
  return fallback;
}

// ── avatar ──────────────────────────────────────────────────────────────────────
class PersonAvatar extends StatelessWidget {
  const PersonAvatar({super.key, required this.name, this.size = 34, this.color});

  final String name;
  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final c = color ?? BrandColors.tealDark;
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: c.withValues(alpha: 0.14), shape: BoxShape.circle),
      child: Text(
        initialsOf(name),
        style: TextStyle(color: c, fontWeight: FontWeight.w800, fontSize: size * 0.4),
      ),
    );
  }
}

// ── value / badge chips ───────────────────────────────────────────────────────────
class ValueChip extends StatelessWidget {
  const ValueChip({super.key, required this.value, this.compact = false});

  final Map<String, dynamic> value;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final name = (value['name'] ?? 'Value').toString();
    final icon = (value['icon'] ?? '').toString();
    final c = hexColor(value['colorHex']);
    return Container(
      padding: EdgeInsets.symmetric(horizontal: compact ? 8 : 10, vertical: compact ? 3 : 5),
      decoration: BoxDecoration(
        color: c.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(BrandRadii.pill),
        border: Border.all(color: c.withValues(alpha: 0.35)),
      ),
      child: Text(
        [if (icon.isNotEmpty) icon, name].join(' '),
        style: TextStyle(color: c, fontWeight: FontWeight.w700, fontSize: compact ? 11 : 12),
      ),
    );
  }
}

/// A small pill for a signed / unsigned points amount.
class PointsChip extends StatelessWidget {
  const PointsChip({super.key, required this.points, this.signed = false});

  final int points;
  final bool signed;

  @override
  Widget build(BuildContext context) {
    final positive = points >= 0;
    final fg = signed ? (positive ? const Color(0xFF047857) : const Color(0xFFB91C1C)) : BrandColors.tealDark;
    final bg = signed ? (positive ? const Color(0xFFECFDF5) : const Color(0xFFFEF2F2)) : BrandColors.tealSoft;
    final label = signed ? '${positive ? '+' : ''}$points pts' : '$points pts';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(BrandRadii.pill)),
      child: Text(label, style: TextStyle(color: fg, fontWeight: FontWeight.w800, fontSize: 11.5)),
    );
  }
}

/// The "manager will approve first" banner shown after a governed give / redeem.
class ApprovalPendingBanner extends StatelessWidget {
  const ApprovalPendingBanner({super.key, required this.message});

  final String message;

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: BrandColors.warningSoft,
          borderRadius: BorderRadius.circular(BrandRadii.md),
          border: Border.all(color: BrandColors.warning.withValues(alpha: 0.35)),
        ),
        child: Row(
          children: [
            const Icon(Icons.hourglass_top, size: 18, color: BrandColors.warning),
            const SizedBox(width: 8),
            Expanded(
              child: Text(message,
                  style: const TextStyle(color: BrandColors.text, fontSize: 12.5, fontWeight: FontWeight.w600)),
            ),
          ],
        ),
      );
}

// ── colleague search field (directory-backed) ────────────────────────────────────
/// A debounced search box that surfaces directory matches and calls [onPick] when a
/// colleague is tapped. [excludeIds] hides already-picked people (multi-select) and
/// [selfIsExcluded] is always true server-side (the directory omits the caller).
class ColleagueSearchField extends ConsumerStatefulWidget {
  const ColleagueSearchField({
    super.key,
    required this.onPick,
    this.excludeIds = const {},
    this.hint = 'Search colleagues by name',
  });

  final void Function(Map<String, dynamic> person) onPick;
  final Set<String> excludeIds;
  final String hint;

  @override
  ConsumerState<ColleagueSearchField> createState() => _ColleagueSearchFieldState();
}

class _ColleagueSearchFieldState extends ConsumerState<ColleagueSearchField> {
  final _controller = TextEditingController();
  Timer? _debounce;
  String _query = '';

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.dispose();
    super.dispose();
  }

  void _onChanged(String v) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 240), () {
      if (mounted) setState(() => _query = v.trim());
    });
  }

  void _pick(Map<String, dynamic> person) {
    widget.onPick(person);
    _controller.clear();
    setState(() => _query = '');
    FocusScope.of(context).unfocus();
  }

  @override
  Widget build(BuildContext context) {
    final results = _query.isEmpty
        ? const AsyncValue<List<Map<String, dynamic>>>.data([])
        : ref.watch(directorySearchProvider(_query));

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: _controller,
          onChanged: _onChanged,
          textInputAction: TextInputAction.search,
          decoration: InputDecoration(
            hintText: widget.hint,
            prefixIcon: const Icon(Icons.search, size: 20),
            isDense: true,
          ),
        ),
        if (_query.isNotEmpty)
          results.when(
            loading: () => const Padding(
              padding: EdgeInsets.symmetric(vertical: 14),
              child: Center(child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.2))),
            ),
            error: (_, __) => const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text('Could not search the directory.', style: TextStyle(color: BrandColors.muted, fontSize: 12)),
            ),
            data: (people) {
              final shown = people.where((p) => !widget.excludeIds.contains(p['id'].toString())).toList();
              if (shown.isEmpty) {
                return const Padding(
                  padding: EdgeInsets.only(top: 10),
                  child: Text('No colleagues match that search.',
                      style: TextStyle(color: BrandColors.muted, fontSize: 12)),
                );
              }
              return Container(
                margin: const EdgeInsets.only(top: 8),
                decoration: BoxDecoration(
                  color: BrandColors.card,
                  borderRadius: BorderRadius.circular(BrandRadii.md),
                  border: Border.all(color: BrandColors.border),
                ),
                child: Column(
                  children: [
                    for (var i = 0; i < shown.length; i++) ...[
                      if (i > 0) const Divider(height: 1),
                      ListTile(
                        dense: true,
                        leading: PersonAvatar(name: personName(shown[i]), size: 32),
                        title: Text(personName(shown[i]),
                            style: const TextStyle(fontWeight: FontWeight.w600, color: BrandColors.text, fontSize: 14)),
                        subtitle: (shown[i]['designation'] ?? shown[i]['department']) != null
                            ? Text(
                                [shown[i]['designation'], shown[i]['department']]
                                    .where((x) => x != null && '$x'.trim().isNotEmpty)
                                    .join(' · '),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(color: BrandColors.muted, fontSize: 11.5))
                            : null,
                        trailing: const Icon(Icons.add_circle_outline, color: BrandColors.teal, size: 20),
                        onTap: () => _pick(shown[i]),
                      ),
                    ],
                  ],
                ),
              );
            },
          ),
      ],
    );
  }
}
