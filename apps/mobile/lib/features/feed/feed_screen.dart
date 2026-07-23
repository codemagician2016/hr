// Engagement wall — the paginated news feed (pinned first, pull-to-refresh +
// load-more), a compact reaction bar per card, an optional celebrations strip on
// top, and tap-through to the post detail (comments + @mentions). Every call hits
// the SELF-scope /api/hr/me/engagement/*.

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
import 'feed_common.dart';
import 'feed_providers.dart';

class FeedScreen extends ConsumerStatefulWidget {
  const FeedScreen({super.key});

  @override
  ConsumerState<FeedScreen> createState() => _FeedScreenState();
}

class _FeedScreenState extends ConsumerState<FeedScreen> {
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
  }

  @override
  void dispose() {
    _scroll.removeListener(_onScroll);
    _scroll.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_scroll.position.pixels >= _scroll.position.maxScrollExtent - 320) {
      ref.read(feedControllerProvider.notifier).loadMore();
    }
  }

  Future<void> _refresh() async {
    ref.invalidate(celebrationsProvider);
    await ref.read(feedControllerProvider.notifier).refresh();
  }

  Future<void> _react(String id, String? kind) async {
    try {
      final api = ref.read(apiClientProvider);
      final res = kind == null
          ? await api.delete(Api.feedReaction(id))
          : await api.put(Api.feedReaction(id), {'kind': kind});
      final summary = res is Map ? res['reactionSummary'] : null;
      if (summary is Map) {
        ref.read(feedControllerProvider.notifier).patch(id, {'reactionSummary': summary.cast<String, dynamic>()});
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(feedControllerProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Feed')),
      body: RefreshIndicator(
        color: BrandColors.teal,
        onRefresh: _refresh,
        child: _body(state),
      ),
    );
  }

  Widget _body(FeedState state) {
    if (state.loading) return const LoadingView();
    if (state.error != null && state.items.isEmpty) {
      final msg = state.error is ApiException
          ? (state.error as ApiException).message
          : 'Could not load the feed.';
      return ErrorView(message: msg, onRetry: _refresh);
    }

    final celebrations = ref.watch(celebrationsProvider).valueOrNull ?? const [];
    final items = state.items;

    return ListView.builder(
      controller: _scroll,
      padding: const EdgeInsets.all(16),
      // header (celebrations) + posts + footer (load-more / end)
      itemCount: items.length + 2,
      itemBuilder: (context, i) {
        if (i == 0) {
          if (celebrations.isEmpty) return const SizedBox.shrink();
          return _CelebrationsStrip(items: celebrations);
        }
        if (i == items.length + 1) return _Footer(state: state);
        if (items.isEmpty) {
          return const Padding(
            padding: EdgeInsets.only(top: 40),
            child: EmptyView(text: 'No posts yet. Company news will show up here.'),
          );
        }
        final post = items[i - 1];
        return _FeedCard(
          post: post,
          onReact: (kind) => _react(post['id'].toString(), kind),
          onRemoveReaction: () => _react(post['id'].toString(), null),
          onOpen: () => context.push('/feed/${post['id']}'),
        );
      },
    );
  }
}

class _Footer extends StatelessWidget {
  const _Footer({required this.state});

  final FeedState state;

  @override
  Widget build(BuildContext context) {
    if (state.loadingMore) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 20),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2.4)),
      );
    }
    if (state.items.isNotEmpty && !state.hasMore) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 20),
        child: Center(
          child: Text("You're all caught up.",
              style: TextStyle(color: BrandColors.muted, fontSize: 12)),
        ),
      );
    }
    return const SizedBox(height: 24);
  }
}

class _CelebrationsStrip extends StatelessWidget {
  const _CelebrationsStrip({required this.items});

  final List<Map<String, dynamic>> items;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SectionHeading(text: 'Celebrations'),
          const SizedBox(height: 8),
          SizedBox(
            height: 92,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: items.length,
              separatorBuilder: (_, __) => const SizedBox(width: 10),
              itemBuilder: (_, i) => _CelebrationCard(item: items[i]),
            ),
          ),
          const SizedBox(height: 18),
        ],
      ),
    );
  }
}

class _CelebrationCard extends StatelessWidget {
  const _CelebrationCard({required this.item});

  final Map<String, dynamic> item;

  @override
  Widget build(BuildContext context) {
    final isBirthday = (item['type']?.toString() ?? '') == 'BIRTHDAY';
    final isSelf = item['isSelf'] == true;
    final name = (item['name'] ?? 'A colleague').toString();
    final years = item['years'];
    final inDays = celebrationInDays(item);
    final when = inDays <= 0 ? 'Today' : (inDays == 1 ? 'Tomorrow' : 'in $inDays days');
    final sub = isBirthday
        ? (isSelf ? 'Your birthday · $when' : 'Birthday · $when')
        : (years != null
            ? '${Fmt.qty(years)}-yr anniversary · $when'
            : 'Work anniversary · $when');
    return Container(
      width: 200,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: BrandColors.card,
        borderRadius: BorderRadius.circular(BrandRadii.lg),
        border: Border.all(color: BrandColors.border),
      ),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: isBirthday ? BrandColors.violetSoft : BrandColors.tealSoft,
              shape: BoxShape.circle,
            ),
            child: Text(isBirthday ? '🎂' : '🎉', style: const TextStyle(fontSize: 18)),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(isSelf ? 'You' : name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w700, color: BrandColors.text, fontSize: 13)),
                const SizedBox(height: 2),
                Text(sub,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: BrandColors.muted, fontSize: 11)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _FeedCard extends StatelessWidget {
  const _FeedCard({
    required this.post,
    required this.onReact,
    required this.onRemoveReaction,
    required this.onOpen,
  });

  final Map<String, dynamic> post;
  final void Function(String kind) onReact;
  final VoidCallback onRemoveReaction;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final read = post['read'] == true;
    final pinned = post['pinned'] == true;
    final title = (post['title'] ?? 'Announcement').toString();
    final category = post['category']?.toString();
    final author = post['authorName']?.toString();
    final body = plainText(post['bodyRichText']);
    final summary = (post['reactionSummary'] is Map)
        ? (post['reactionSummary'] as Map).cast<String, dynamic>()
        : null;
    final commentCount = (post['commentCount'] as num?)?.toInt() ?? 0;

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: SectionCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (!read)
                  Container(
                    margin: const EdgeInsets.only(top: 6, right: 8),
                    width: 8,
                    height: 8,
                    decoration: const BoxDecoration(color: BrandColors.teal, shape: BoxShape.circle),
                  ),
                Expanded(
                  child: InkWell(
                    onTap: onOpen,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            if (pinned) ...[
                              const Icon(Icons.push_pin, size: 14, color: BrandColors.teal),
                              const SizedBox(width: 4),
                            ],
                            Expanded(
                              child: Text(title,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    fontSize: 15.5,
                                    fontWeight: read ? FontWeight.w600 : FontWeight.w800,
                                    color: BrandColors.text,
                                  )),
                            ),
                          ],
                        ),
                        const SizedBox(height: 2),
                        Text(
                          [
                            if (category != null && category.isNotEmpty) _titleCase(category),
                            if (author != null && author.isNotEmpty) author,
                            Fmt.date(post['publishedAt']),
                          ].where((s) => s.isNotEmpty).join(' · '),
                          style: const TextStyle(color: BrandColors.muted, fontSize: 11.5),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
            if (body.isNotEmpty) ...[
              const SizedBox(height: 8),
              InkWell(
                onTap: onOpen,
                child: Text(body,
                    maxLines: 4,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: BrandColors.text, fontSize: 13.5, height: 1.35)),
              ),
            ],
            const SizedBox(height: 12),
            ReactionBar(summary: summary, onReact: onReact, onRemove: onRemoveReaction),
            const SizedBox(height: 8),
            const Divider(height: 1),
            const SizedBox(height: 4),
            InkWell(
              onTap: onOpen,
              borderRadius: BorderRadius.circular(BrandRadii.sm),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(
                  children: [
                    const Icon(Icons.mode_comment_outlined, size: 16, color: BrandColors.muted),
                    const SizedBox(width: 6),
                    Text(
                      commentCount == 0
                          ? 'Comment'
                          : '$commentCount ${commentCount == 1 ? 'comment' : 'comments'}',
                      style: const TextStyle(color: BrandColors.muted, fontSize: 12.5, fontWeight: FontWeight.w600),
                    ),
                    const Spacer(),
                    const Text('Open',
                        style: TextStyle(color: BrandColors.teal, fontSize: 12.5, fontWeight: FontWeight.w700)),
                    const Icon(Icons.chevron_right, size: 18, color: BrandColors.teal),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

String _titleCase(String s) {
  if (s.isEmpty) return s;
  final lower = s.toLowerCase().replaceAll('_', ' ');
  return lower[0].toUpperCase() + lower.substring(1);
}
