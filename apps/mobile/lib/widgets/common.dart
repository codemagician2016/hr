// Small shared UI atoms: an ⓘ help tooltip (mirrors the ESS web InfoTip), a
// status pill, a rounded section card, a labelled stat tile, and a list-shape
// normalizer for the backend's `Array | {items} | {balances} | …` responses.

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// ⓘ tooltip — the same affordance the ESS web puts beside form fields/headings.
class InfoTip extends StatelessWidget {
  const InfoTip({super.key, required this.message});

  final String message;

  @override
  Widget build(BuildContext context) => Tooltip(
        message: message,
        triggerMode: TooltipTriggerMode.tap,
        showDuration: const Duration(seconds: 6),
        margin: const EdgeInsets.symmetric(horizontal: 24),
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: BrandColors.ink,
          borderRadius: BorderRadius.circular(BrandRadii.sm),
        ),
        textStyle: const TextStyle(color: Colors.white, fontSize: 12),
        child: Padding(
          padding: const EdgeInsets.only(left: 4),
          child: Container(
            width: 16,
            height: 16,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(color: BrandColors.border),
            ),
            child: const Text(
              'i',
              style: TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.bold,
                color: BrandColors.muted,
              ),
            ),
          ),
        ),
      );
}

/// A small coloured status pill. Pass explicit colours or use [StatusPill.forStatus].
class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.label, required this.fg, required this.bg, this.bd});

  final String label;
  final Color fg;
  final Color bg;
  final Color? bd;

  factory StatusPill.forStatus(String? status) {
    final s = (status ?? '').toUpperCase();
    Color fg = BrandColors.muted;
    Color bg = const Color(0xFFF1F5F9);
    if (['APPROVED', 'LOCKED', 'AVAILED', 'FULFILLED', 'PRESENT', 'PUBLISHED'].contains(s)) {
      fg = const Color(0xFF047857);
      bg = const Color(0xFFECFDF5);
    } else if (['SUBMITTED', 'PENDING', 'DRAFT', 'IN_PROGRESS', 'IN_REVIEW'].contains(s)) {
      fg = const Color(0xFFB45309);
      bg = const Color(0xFFFFFBEB);
    } else if (['REJECTED', 'CANCELLED', 'WITHDRAWN', 'DECLINED', 'VOIDED', 'ABSENT'].contains(s)) {
      fg = const Color(0xFFB91C1C);
      bg = const Color(0xFFFEF2F2);
    }
    return StatusPill(label: status ?? '—', fg: fg, bg: bg);
  }

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 2),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(BrandRadii.pill),
          border: bd == null ? null : Border.all(color: bd!),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: fg,
            fontSize: 11,
            fontWeight: FontWeight.w600,
            letterSpacing: 0.3,
          ),
        ),
      );
}

/// Rounded white card with a 1px brand border (the ESS "rounded-2xl border" look).
class SectionCard extends StatelessWidget {
  const SectionCard({super.key, required this.child, this.padding = const EdgeInsets.all(16)});

  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: padding,
        decoration: BoxDecoration(
          color: BrandColors.card,
          borderRadius: BorderRadius.circular(BrandRadii.lg),
          border: Border.all(color: BrandColors.border),
          boxShadow: [
            BoxShadow(
              color: BrandColors.ink.withValues(alpha: 0.04),
              blurRadius: 8,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        child: child,
      );
}

/// An uppercase muted section heading, optionally with an ⓘ tip.
class SectionHeading extends StatelessWidget {
  const SectionHeading({super.key, required this.text, this.tip, this.trailing});

  final String text;
  final String? tip;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Row(
        children: [
          Text(
            text.toUpperCase(),
            style: const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.6,
              color: BrandColors.muted,
            ),
          ),
          if (tip != null) InfoTip(message: tip!),
          const Spacer(),
          if (trailing != null) trailing!,
        ],
      );
}

/// A label/value row used inside payslip/CTC/tax statement cards.
class KvRow extends StatelessWidget {
  const KvRow({
    super.key,
    required this.label,
    required this.value,
    this.strong = false,
    this.accent = false,
    this.tip,
  });

  final String label;
  final String value;
  final bool strong;
  final bool accent;
  final String? tip;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Row(
                children: [
                  Flexible(
                    child: Text(
                      label,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: strong ? FontWeight.w700 : FontWeight.w400,
                        color: strong ? BrandColors.text : BrandColors.muted,
                      ),
                    ),
                  ),
                  if (tip != null) InfoTip(message: tip!),
                ],
              ),
            ),
            const SizedBox(width: 12),
            Text(
              value,
              style: TextStyle(
                fontSize: 14,
                fontWeight: strong ? FontWeight.w700 : FontWeight.w500,
                color: accent ? BrandColors.teal : BrandColors.text,
              ),
            ),
          ],
        ),
      );
}

/// `firstOrNull` without depending on package:collection.
extension FirstOrNull<E> on Iterable<E> {
  E? get firstOrNull {
    final it = iterator;
    return it.moveNext() ? it.current : null;
  }
}

/// Normalize the backend's flexible list shapes to a `List<Map>`.
/// Accepts a raw List, or a Map carrying items/`<key>` (balances, payslips, …).
List<Map<String, dynamic>> asList(dynamic body, {List<String> keys = const ['items']}) {
  if (body is List) {
    return body.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
  }
  if (body is Map) {
    for (final k in keys) {
      final v = body[k];
      if (v is List) {
        return v.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
      }
    }
  }
  return const [];
}

/// Extract a paginated `{ items, total }` shape.
({List<Map<String, dynamic>> items, int total}) asPage(dynamic body, {List<String> keys = const ['items']}) {
  if (body is List) {
    final items = body.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
    return (items: items, total: items.length);
  }
  if (body is Map) {
    final items = asList(body, keys: keys);
    final total = (body['total'] as num?)?.toInt() ?? items.length;
    return (items: items, total: total);
  }
  return (items: const [], total: 0);
}
