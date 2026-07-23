// Notification inbox — the surface the feed social layer (mentions, comments) and
// the platform fan-outs land in. A tap marks the row read and, for a feed
// notification, jumps to the engagement wall. "Mark all read" clears the badge.
// SELF-only /api/hr/me/notifications/*.

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
import 'notifications_providers.dart';

/// A friendly one-word action label for a notification type (fallback when the
/// server did not carry a title).
String _typeLabel(String? type) {
  switch ((type ?? '').toUpperCase()) {
    case 'FEED_MENTION':
      return 'mentioned you';
    case 'FEED_COMMENT':
      return 'commented on your post';
    default:
      return 'Notification';
  }
}

IconData _typeIcon(String? type) {
  switch ((type ?? '').toUpperCase()) {
    case 'FEED_MENTION':
      return Icons.alternate_email;
    case 'FEED_COMMENT':
      return Icons.mode_comment_outlined;
    default:
      return Icons.notifications_outlined;
  }
}

/// Detect a feed notification + pull the target announcement id from dataJson /
/// entity fields. Returns null when this isn't a feed row.
String? _feedTargetId(Map<String, dynamic> n) {
  final type = (n['type']?.toString() ?? '').toUpperCase();
  final isFeed = type.startsWith('FEED_') || (n['entityType']?.toString() == 'Announcement');
  if (!isFeed) return null;
  final data = n['dataJson'];
  if (data is Map) {
    final id = data['announcementId'] ?? data['entityId'];
    if (id != null) return id.toString();
  }
  final entityId = n['entityId'];
  return entityId?.toString();
}

class NotificationsScreen extends ConsumerWidget {
  const NotificationsScreen({super.key});

  Future<void> _refresh(WidgetRef ref) async {
    ref.invalidate(notificationsUnreadProvider);
    ref.invalidate(notificationsProvider);
    await ref.read(notificationsProvider.future);
  }

  Future<void> _markRead(WidgetRef ref, String id) async {
    try {
      await ref.read(apiClientProvider).post(Api.notificationRead(id), {});
    } catch (_) {/* best-effort — the list refresh reflects the real state */}
    ref.invalidate(notificationsProvider);
    ref.invalidate(notificationsUnreadProvider);
  }

  Future<void> _markAllRead(WidgetRef ref, BuildContext context) async {
    try {
      await ref.read(apiClientProvider).post(Api.notificationsReadAll, {});
      ref.invalidate(notificationsProvider);
      ref.invalidate(notificationsUnreadProvider);
    } on ApiException catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  void _onTap(WidgetRef ref, BuildContext context, Map<String, dynamic> n) {
    final id = n['id'].toString();
    if (n['read'] != true) _markRead(ref, id);
    final feedTarget = _feedTargetId(n);
    if (feedTarget != null) context.go('/feed');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(notificationsProvider);
    final unread = ref.watch(notificationsUnreadProvider).valueOrNull ?? 0;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Notifications'),
        actions: [
          if (unread > 0)
            TextButton(
              onPressed: () => _markAllRead(ref, context),
              child: const Text('Mark all read'),
            ),
        ],
      ),
      body: AsyncView<Map<String, dynamic>>(
        value: async,
        treat404AsEmpty: true,
        emptyText: "You're all caught up.",
        onRefresh: () => _refresh(ref),
        data: (payload) {
          final items = (payload['items'] as List).cast<Map<String, dynamic>>();
          final unlinked = payload['unlinked'] == true;
          if (items.isEmpty) {
            return ListView(
              children: [
                const SizedBox(height: 80),
                EmptyView(
                  icon: Icons.notifications_none,
                  text: unlinked
                      ? "Your account has no notification inbox yet.\nMentions and updates will show up here once it's linked."
                      : "You're all caught up. No notifications.",
                ),
              ],
            );
          }
          return ListView.separated(
            padding: const EdgeInsets.all(16),
            itemCount: items.length,
            separatorBuilder: (_, __) => const SizedBox(height: 8),
            itemBuilder: (_, i) => _NotificationTile(
              notification: items[i],
              onTap: () => _onTap(ref, context, items[i]),
            ),
          );
        },
      ),
    );
  }
}

class _NotificationTile extends StatelessWidget {
  const _NotificationTile({required this.notification, required this.onTap});

  final Map<String, dynamic> notification;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final n = notification;
    final read = n['read'] == true;
    final type = n['type']?.toString();
    final title = (n['title'] ?? '').toString().trim();
    final headline = title.isNotEmpty ? title : _typeLabel(type);
    final body = (n['body'] ?? '').toString().trim();
    final isFeed = _feedTargetId(n) != null;

    return InkWell(
      borderRadius: BorderRadius.circular(BrandRadii.lg),
      onTap: onTap,
      child: SectionCard(
        padding: const EdgeInsets.all(14),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 38,
              height: 38,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: read ? BrandColors.bg : BrandColors.tealSoft,
                shape: BoxShape.circle,
              ),
              child: Icon(_typeIcon(type),
                  size: 18, color: read ? BrandColors.muted : BrandColors.tealDark),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(headline,
                      style: TextStyle(
                        fontWeight: read ? FontWeight.w600 : FontWeight.w800,
                        fontSize: 14,
                        color: BrandColors.text,
                      )),
                  if (body.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(body,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(color: BrandColors.muted, fontSize: 12.5, height: 1.3)),
                  ],
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      Text(Fmt.date(n['createdAt']),
                          style: const TextStyle(color: BrandColors.muted, fontSize: 11)),
                      if (isFeed) ...[
                        const SizedBox(width: 8),
                        const Text('View post',
                            style: TextStyle(color: BrandColors.teal, fontSize: 11, fontWeight: FontWeight.w700)),
                      ],
                    ],
                  ),
                ],
              ),
            ),
            if (!read)
              Container(
                margin: const EdgeInsets.only(left: 8, top: 4),
                width: 8,
                height: 8,
                decoration: const BoxDecoration(color: BrandColors.teal, shape: BoxShape.circle),
              ),
          ],
        ),
      ),
    );
  }
}
