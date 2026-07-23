// Feed post detail — the full announcement body, its reaction bar, and a threaded
// (one-level) comment discussion with a composer that supports a simple @mention
// picker (type "@name" → pick a colleague from the directory → inserts @[Name]).
// Marks the post read on open. All calls hit SELF-scope /api/hr/me/engagement/*.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/format.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';
import 'feed_common.dart';
import 'feed_providers.dart';

class FeedDetailScreen extends ConsumerStatefulWidget {
  const FeedDetailScreen({super.key, required this.announcementId});

  final String announcementId;

  @override
  ConsumerState<FeedDetailScreen> createState() => _FeedDetailScreenState();
}

class _FeedDetailScreenState extends ConsumerState<FeedDetailScreen> {
  final _composer = TextEditingController();
  final _composerFocus = FocusNode();

  String? _replyToId;
  String? _replyToName;
  bool _sending = false;
  bool _reacting = false;

  // @mention picker state
  Timer? _debounce;
  int _mentionAnchor = -1;
  List<Map<String, dynamic>> _suggestions = const [];
  bool _loadingSuggestions = false;

  String get _id => widget.announcementId;

  @override
  void initState() {
    super.initState();
    _composer.addListener(_onComposerChanged);
    // Mark read on open (best-effort) and reflect it on the list card.
    WidgetsBinding.instance.addPostFrameCallback((_) => _markRead());
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _composer.removeListener(_onComposerChanged);
    _composer.dispose();
    _composerFocus.dispose();
    super.dispose();
  }

  Future<void> _markRead() async {
    try {
      await ref.read(apiClientProvider).post(Api.feedRead(_id), {});
      ref.read(feedControllerProvider.notifier).patch(_id, {'read': true});
    } catch (_) {/* best-effort */}
  }

  Map<String, dynamic>? _postFromList() {
    final items = ref.read(feedControllerProvider).items;
    for (final p in items) {
      if (p['id'].toString() == _id) return p;
    }
    return null;
  }

  // ── reactions ────────────────────────────────────────────────────────────────
  Future<void> _react(String? kind) async {
    setState(() => _reacting = true);
    try {
      final api = ref.read(apiClientProvider);
      final res = kind == null
          ? await api.delete(Api.feedReaction(_id))
          : await api.put(Api.feedReaction(_id), {'kind': kind});
      final summary = res is Map ? res['reactionSummary'] : null;
      if (summary is Map) {
        ref.read(feedControllerProvider.notifier)
            .patch(_id, {'reactionSummary': summary.cast<String, dynamic>()});
      }
    } on ApiException catch (e) {
      _toast(e.message);
    } finally {
      if (mounted) setState(() => _reacting = false);
    }
  }

  // ── @mention detection + lookup ───────────────────────────────────────────────
  void _onComposerChanged() {
    final sel = _composer.selection;
    final cursor = sel.isValid ? sel.baseOffset : _composer.text.length;
    final active = _activeMention(_composer.text, cursor);
    if (active == null) {
      if (_suggestions.isNotEmpty || _mentionAnchor != -1) {
        setState(() {
          _suggestions = const [];
          _mentionAnchor = -1;
        });
      }
      return;
    }
    _mentionAnchor = active.$1;
    final token = active.$2;
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 220), () => _lookup(token));
  }

  /// Find an in-progress "@token" ending at the cursor: returns (indexOf'@', token)
  /// or null. The char before '@' must be a boundary (so "john@acme.com" is safe),
  /// and the token itself carries no whitespace or bracket (an already-inserted
  /// @[Name] is complete, not active).
  (int, String)? _activeMention(String text, int cursor) {
    if (cursor < 0 || cursor > text.length) return null;
    final upto = text.substring(0, cursor);
    final at = upto.lastIndexOf('@');
    if (at < 0) return null;
    if (at > 0 && RegExp(r'[A-Za-z0-9._%+-]').hasMatch(upto[at - 1])) return null;
    final token = upto.substring(at + 1);
    if (token.contains(RegExp(r'[\s\]\[]'))) return null;
    return (at, token);
  }

  Future<void> _lookup(String token) async {
    final q = token.trim();
    if (q.isEmpty) {
      if (mounted) setState(() => _suggestions = const []);
      return;
    }
    setState(() => _loadingSuggestions = true);
    try {
      final res = await ref.read(apiClientProvider).get(
        Api.directory,
        query: {'q': q, 'pageSize': 6},
      );
      final people = asList(res);
      if (mounted) setState(() => _suggestions = people.take(6).toList());
    } catch (_) {
      if (mounted) setState(() => _suggestions = const []);
    } finally {
      if (mounted) setState(() => _loadingSuggestions = false);
    }
  }

  void _pickMention(Map<String, dynamic> person) {
    final name = (person['name'] ?? person['code'] ?? '').toString().trim();
    if (name.isEmpty || _mentionAnchor < 0) return;
    final text = _composer.text;
    final sel = _composer.selection;
    final cursor = sel.isValid ? sel.baseOffset : text.length;
    final before = text.substring(0, _mentionAnchor);
    final after = text.substring(cursor);
    final insert = '@[$name] ';
    final next = '$before$insert$after';
    _composer.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: (before + insert).length),
    );
    setState(() {
      _suggestions = const [];
      _mentionAnchor = -1;
    });
  }

  // ── comment actions ────────────────────────────────────────────────────────────
  void _startReply(Map<String, dynamic> comment) {
    setState(() {
      _replyToId = comment['id'].toString();
      _replyToName = comment['authorName']?.toString();
    });
    _composerFocus.requestFocus();
  }

  void _cancelReply() => setState(() {
        _replyToId = null;
        _replyToName = null;
      });

  Future<void> _send() async {
    final body = _composer.text.trim();
    if (body.isEmpty) return;
    setState(() => _sending = true);
    try {
      await ref.read(apiClientProvider).post(Api.feedComments(_id), {
        'body': body,
        if (_replyToId != null) 'parentId': _replyToId,
      });
      _composer.clear();
      _bumpCommentCount(1);
      setState(() {
        _replyToId = null;
        _replyToName = null;
        _suggestions = const [];
      });
      ref.invalidate(feedCommentsProvider(_id));
    } on ApiException catch (e) {
      _toast(e.message);
    } catch (_) {
      _toast('Could not post your comment.');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _editComment(Map<String, dynamic> comment) async {
    final controller = TextEditingController(text: (comment['body'] ?? '').toString());
    final next = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Edit comment'),
        content: TextField(
          controller: controller,
          autofocus: true,
          maxLines: 4,
          decoration: const InputDecoration(hintText: 'Update your comment'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (next == null || next.isEmpty) return;
    try {
      await ref.read(apiClientProvider)
          .patch(Api.feedComment(_id, comment['id'].toString()), {'body': next});
      ref.invalidate(feedCommentsProvider(_id));
    } on ApiException catch (e) {
      _toast(e.message);
    }
  }

  Future<void> _deleteComment(Map<String, dynamic> comment) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete comment?'),
        content: const Text('This removes your comment from the thread.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep it')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(apiClientProvider).delete(Api.feedComment(_id, comment['id'].toString()));
      _bumpCommentCount(-1);
      ref.invalidate(feedCommentsProvider(_id));
    } on ApiException catch (e) {
      _toast(e.message);
    }
  }

  void _bumpCommentCount(int delta) {
    final post = _postFromList();
    if (post == null) return;
    final current = (post['commentCount'] as num?)?.toInt() ?? 0;
    ref.read(feedControllerProvider.notifier)
        .patch(_id, {'commentCount': (current + delta).clamp(0, 1 << 30)});
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    final post = _postFromList();
    final commentsAsync = ref.watch(feedCommentsProvider(_id));
    final myEmployeeId = employeeIdOf(ref.watch(authControllerProvider).customer);

    return Scaffold(
      appBar: AppBar(title: const Text('Post')),
      body: Column(
        children: [
          Expanded(
            child: RefreshIndicator(
              color: BrandColors.teal,
              onRefresh: () async => ref.invalidate(feedCommentsProvider(_id)),
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (post != null) _PostHeader(post: post, reacting: _reacting, onReact: _react),
                  const SizedBox(height: 18),
                  const SectionHeading(text: 'Comments'),
                  const SizedBox(height: 8),
                  commentsAsync.when(
                    loading: () => const LoadingView(),
                    error: (err, _) => EmptyView(
                        text: err is ApiException ? err.message : 'Could not load comments.'),
                    data: (comments) {
                      if (comments.isEmpty) {
                        return const EmptyView(
                            text: 'No comments yet. Be the first to say something.',
                            icon: Icons.mode_comment_outlined);
                      }
                      return Column(
                        children: comments
                            .map((c) => _CommentThread(
                                  comment: c,
                                  myEmployeeId: myEmployeeId,
                                  onReply: _startReply,
                                  onEdit: _editComment,
                                  onDelete: _deleteComment,
                                ))
                            .toList(),
                      );
                    },
                  ),
                  const SizedBox(height: 12),
                ],
              ),
            ),
          ),
          _Composer(
            controller: _composer,
            focusNode: _composerFocus,
            sending: _sending,
            replyToName: _replyToName,
            onCancelReply: _cancelReply,
            onSend: _send,
            suggestions: _suggestions,
            loadingSuggestions: _loadingSuggestions,
            onPickMention: _pickMention,
          ),
        ],
      ),
    );
  }
}

class _PostHeader extends StatelessWidget {
  const _PostHeader({required this.post, required this.reacting, required this.onReact});

  final Map<String, dynamic> post;
  final bool reacting;
  final Future<void> Function(String? kind) onReact;

  @override
  Widget build(BuildContext context) {
    final title = (post['title'] ?? 'Announcement').toString();
    final author = post['authorName']?.toString();
    final category = post['category']?.toString();
    final pinned = post['pinned'] == true;
    final body = plainText(post['bodyRichText']);
    final summary = (post['reactionSummary'] is Map)
        ? (post['reactionSummary'] as Map).cast<String, dynamic>()
        : null;

    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (pinned) ...[
                const Icon(Icons.push_pin, size: 15, color: BrandColors.teal),
                const SizedBox(width: 4),
              ],
              Expanded(
                child: Text(title,
                    style: const TextStyle(
                        fontSize: 18, fontWeight: FontWeight.w800, color: BrandColors.text)),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            [
              if (category != null && category.isNotEmpty)
                category.toLowerCase().replaceAll('_', ' '),
              if (author != null && author.isNotEmpty) author,
              Fmt.date(post['publishedAt']),
            ].where((s) => s.isNotEmpty).join(' · '),
            style: const TextStyle(color: BrandColors.muted, fontSize: 12),
          ),
          if (body.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text(body, style: const TextStyle(color: BrandColors.text, fontSize: 14, height: 1.4)),
          ],
          const SizedBox(height: 14),
          const Divider(height: 1),
          const SizedBox(height: 10),
          ReactionBar(
            summary: summary,
            busy: reacting,
            onReact: (k) => onReact(k),
            onRemove: () => onReact(null),
          ),
        ],
      ),
    );
  }
}

class _CommentThread extends StatelessWidget {
  const _CommentThread({
    required this.comment,
    required this.myEmployeeId,
    required this.onReply,
    required this.onEdit,
    required this.onDelete,
  });

  final Map<String, dynamic> comment;
  final String? myEmployeeId;
  final void Function(Map<String, dynamic>) onReply;
  final void Function(Map<String, dynamic>) onEdit;
  final void Function(Map<String, dynamic>) onDelete;

  @override
  Widget build(BuildContext context) {
    final replies = asList(comment, keys: const ['replies']);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _CommentTile(
            comment: comment,
            myEmployeeId: myEmployeeId,
            canReply: true,
            onReply: onReply,
            onEdit: onEdit,
            onDelete: onDelete,
          ),
          if (replies.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(left: 22, top: 8),
              child: Column(
                children: replies
                    .map((r) => Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: _CommentTile(
                            comment: r,
                            myEmployeeId: myEmployeeId,
                            canReply: false,
                            onReply: onReply,
                            onEdit: onEdit,
                            onDelete: onDelete,
                          ),
                        ))
                    .toList(),
              ),
            ),
        ],
      ),
    );
  }
}

class _CommentTile extends StatelessWidget {
  const _CommentTile({
    required this.comment,
    required this.myEmployeeId,
    required this.canReply,
    required this.onReply,
    required this.onEdit,
    required this.onDelete,
  });

  final Map<String, dynamic> comment;
  final String? myEmployeeId;
  final bool canReply;
  final void Function(Map<String, dynamic>) onReply;
  final void Function(Map<String, dynamic>) onEdit;
  final void Function(Map<String, dynamic>) onDelete;

  @override
  Widget build(BuildContext context) {
    final deleted = comment['deleted'] == true;
    final author = (comment['authorName'] ?? 'A colleague').toString();
    final body = (comment['body'] ?? '').toString();
    final edited = comment['editedAt'] != null;
    final authorId = comment['authorEmployeeId']?.toString();
    final isMine = !deleted && myEmployeeId != null && authorId == myEmployeeId;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: BrandColors.bg,
        borderRadius: BorderRadius.circular(BrandRadii.md),
        border: Border.all(color: BrandColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(deleted ? 'Deleted' : author,
                    style: TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 12.5,
                        color: deleted ? BrandColors.muted : BrandColors.text)),
              ),
              Text(Fmt.date(comment['createdAt']),
                  style: const TextStyle(color: BrandColors.muted, fontSize: 11)),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            deleted ? '[deleted]' : body,
            style: TextStyle(
              fontSize: 13.5,
              height: 1.35,
              fontStyle: deleted ? FontStyle.italic : FontStyle.normal,
              color: deleted ? BrandColors.muted : BrandColors.text,
            ),
          ),
          if (!deleted && (edited || canReply || isMine)) ...[
            const SizedBox(height: 6),
            Row(
              children: [
                if (edited)
                  const Text('edited',
                      style: TextStyle(color: BrandColors.muted, fontSize: 10.5, fontStyle: FontStyle.italic)),
                const Spacer(),
                if (canReply)
                  _LinkAction(label: 'Reply', onTap: () => onReply(comment)),
                if (isMine) ...[
                  _LinkAction(label: 'Edit', onTap: () => onEdit(comment)),
                  _LinkAction(label: 'Delete', danger: true, onTap: () => onDelete(comment)),
                ],
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _LinkAction extends StatelessWidget {
  const _LinkAction({required this.label, required this.onTap, this.danger = false});

  final String label;
  final VoidCallback onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(left: 12),
        child: InkWell(
          onTap: onTap,
          child: Text(label,
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w700,
                color: danger ? BrandColors.danger : BrandColors.teal,
              )),
        ),
      );
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.focusNode,
    required this.sending,
    required this.replyToName,
    required this.onCancelReply,
    required this.onSend,
    required this.suggestions,
    required this.loadingSuggestions,
    required this.onPickMention,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final bool sending;
  final String? replyToName;
  final VoidCallback onCancelReply;
  final Future<void> Function() onSend;
  final List<Map<String, dynamic>> suggestions;
  final bool loadingSuggestions;
  final void Function(Map<String, dynamic>) onPickMention;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Container(
        decoration: const BoxDecoration(
          color: BrandColors.card,
          border: Border(top: BorderSide(color: BrandColors.border)),
        ),
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (suggestions.isNotEmpty || loadingSuggestions)
              _MentionSuggestions(
                suggestions: suggestions,
                loading: loadingSuggestions,
                onPick: onPickMention,
              ),
            if (replyToName != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Row(
                  children: [
                    const Icon(Icons.reply, size: 14, color: BrandColors.muted),
                    const SizedBox(width: 4),
                    Expanded(
                      child: Text('Replying to $replyToName',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(color: BrandColors.muted, fontSize: 12)),
                    ),
                    InkWell(
                      onTap: onCancelReply,
                      child: const Text('Cancel',
                          style: TextStyle(color: BrandColors.teal, fontSize: 12, fontWeight: FontWeight.w700)),
                    ),
                  ],
                ),
              ),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: TextField(
                    controller: controller,
                    focusNode: focusNode,
                    minLines: 1,
                    maxLines: 4,
                    textInputAction: TextInputAction.newline,
                    decoration: const InputDecoration(
                      hintText: 'Add a comment…  @ to mention',
                      isDense: true,
                      contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                sending
                    ? const Padding(
                        padding: EdgeInsets.all(10),
                        child: SizedBox(
                            width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)),
                      )
                    : IconButton.filled(
                        onPressed: onSend,
                        style: IconButton.styleFrom(backgroundColor: BrandColors.teal),
                        icon: const Icon(Icons.send_rounded, size: 20, color: Colors.white),
                      ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _MentionSuggestions extends StatelessWidget {
  const _MentionSuggestions({
    required this.suggestions,
    required this.loading,
    required this.onPick,
  });

  final List<Map<String, dynamic>> suggestions;
  final bool loading;
  final void Function(Map<String, dynamic>) onPick;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      constraints: const BoxConstraints(maxHeight: 200),
      decoration: BoxDecoration(
        color: BrandColors.card,
        borderRadius: BorderRadius.circular(BrandRadii.md),
        border: Border.all(color: BrandColors.border),
      ),
      child: loading && suggestions.isEmpty
          ? const Padding(
              padding: EdgeInsets.all(14),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                  SizedBox(width: 10),
                  Text('Searching…', style: TextStyle(color: BrandColors.muted, fontSize: 12)),
                ],
              ),
            )
          : ListView(
              shrinkWrap: true,
              padding: EdgeInsets.zero,
              children: suggestions.map((p) {
                final name = (p['name'] ?? p['code'] ?? '—').toString();
                final designation = p['designation']?.toString();
                final dept = p['department']?.toString();
                final sub = [designation, dept].where((s) => s != null && s.isNotEmpty).join(' · ');
                return ListTile(
                  dense: true,
                  visualDensity: VisualDensity.compact,
                  leading: CircleAvatar(
                    radius: 15,
                    backgroundColor: BrandColors.tealSoft,
                    child: Text(
                      name.isNotEmpty ? name[0].toUpperCase() : '?',
                      style: const TextStyle(color: BrandColors.tealDark, fontWeight: FontWeight.w700, fontSize: 13),
                    ),
                  ),
                  title: Text(name,
                      style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: BrandColors.text)),
                  subtitle: sub.isEmpty
                      ? null
                      : Text(sub, style: const TextStyle(fontSize: 11.5, color: BrandColors.muted)),
                  onTap: () => onPick(p),
                );
              }).toList(),
            ),
    );
  }
}
