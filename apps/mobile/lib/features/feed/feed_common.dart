// Shared feed atoms: the five reaction kinds (kind → emoji), a compact reaction
// bar (counts, my-reaction highlighted, tap to set/toggle), and a best-effort
// rich-text → plain-text reducer for announcement bodies.

import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';

/// The single-reaction palette (order = display order). Mirrors the backend
/// REACTION_KINDS. A person has at most ONE reaction; PUT replaces it.
const List<(String, String)> kReactionKinds = [
  ('LIKE', '👍'),
  ('CELEBRATE', '🎉'),
  ('SUPPORT', '🙌'),
  ('INSIGHTFUL', '💡'),
  ('LOVE', '❤️'),
];

String reactionEmoji(String kind) {
  for (final r in kReactionKinds) {
    if (r.$1 == kind) return r.$2;
  }
  return '👍';
}

int reactionTotal(Map<String, dynamic>? summary) {
  final t = summary?['total'];
  if (t is num) return t.toInt();
  return 0;
}

String? myReactionOf(Map<String, dynamic>? summary) {
  final m = summary?['myReaction'];
  return m?.toString();
}

/// Reduce a stored rich-text body to readable plain text (strip tags, decode a
/// few common entities, collapse whitespace). The feed authoring is light HTML;
/// the mobile card shows a clean text preview.
String plainText(Object? richText) {
  if (richText == null) return '';
  var s = richText.toString();
  s = s.replaceAll(RegExp(r'<br\s*/?>', caseSensitive: false), '\n');
  s = s.replaceAll(RegExp(r'</p>', caseSensitive: false), '\n\n');
  s = s.replaceAll(RegExp(r'<[^>]+>'), '');
  s = s
      .replaceAll('&nbsp;', ' ')
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'");
  s = s.replaceAll(RegExp(r'\n{3,}'), '\n\n');
  return s.trim();
}

/// A compact reaction bar. Shows each kind with its live count; the caller's own
/// reaction is highlighted. Tapping a kind sets it (or toggles it off when it is
/// already yours). [busy] disables taps while a mutation is in flight.
class ReactionBar extends StatelessWidget {
  const ReactionBar({
    super.key,
    required this.summary,
    required this.onReact,
    required this.onRemove,
    this.busy = false,
  });

  final Map<String, dynamic>? summary;
  final void Function(String kind) onReact;
  final VoidCallback onRemove;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final counts = (summary?['counts'] is Map)
        ? (summary!['counts'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};
    final mine = myReactionOf(summary);
    final total = reactionTotal(summary);
    return Wrap(
      spacing: 6,
      runSpacing: 6,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        for (final r in kReactionKinds)
          _ReactionChip(
            emoji: r.$2,
            count: (counts[r.$1] as num?)?.toInt() ?? 0,
            selected: mine == r.$1,
            onTap: busy
                ? null
                : () => mine == r.$1 ? onRemove() : onReact(r.$1),
          ),
        if (total > 0)
          Padding(
            padding: const EdgeInsets.only(left: 2),
            child: Text('$total',
                style: const TextStyle(color: BrandColors.muted, fontSize: 12, fontWeight: FontWeight.w600)),
          ),
      ],
    );
  }
}

class _ReactionChip extends StatelessWidget {
  const _ReactionChip({
    required this.emoji,
    required this.count,
    required this.selected,
    required this.onTap,
  });

  final String emoji;
  final int count;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(BrandRadii.pill),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(
          color: selected ? BrandColors.tealSoft : BrandColors.bg,
          borderRadius: BorderRadius.circular(BrandRadii.pill),
          border: Border.all(color: selected ? BrandColors.teal : BrandColors.border),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(emoji, style: const TextStyle(fontSize: 14)),
            if (count > 0) ...[
              const SizedBox(width: 4),
              Text('$count',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    color: selected ? BrandColors.tealDark : BrandColors.muted,
                  )),
            ],
          ],
        ),
      ),
    );
  }
}
