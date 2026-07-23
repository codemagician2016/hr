// Helpdesk ticket detail — the header (status/priority/category/SLA) + the public
// thread, a reply box (unless the ticket is terminal), and, for a resolved/closed
// ticket, Reopen + a 1–5 satisfaction rating. SELF-only /api/hr/me/helpdesk/:id.
// Internal HR notes are never returned on this surface.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/format.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';
import 'helpdesk_common.dart';
import 'helpdesk_providers.dart';

/// Best-effort resolve of the signed-in customer's user id, used only to align my
/// own thread messages to the right (never claims a message is mine on a mismatch).
String? _myUserId(WidgetRef ref) {
  final me = ref.read(authControllerProvider).customer;
  if (me == null) return null;
  final customer = me['customer'];
  if (customer is Map && customer['id'] != null) return customer['id'].toString();
  if (me['userId'] != null) return me['userId'].toString();
  if (me['id'] != null) return me['id'].toString();
  return null;
}

class HelpdeskDetailScreen extends ConsumerStatefulWidget {
  const HelpdeskDetailScreen({super.key, required this.ticketId});

  final String ticketId;

  @override
  ConsumerState<HelpdeskDetailScreen> createState() => _HelpdeskDetailScreenState();
}

class _HelpdeskDetailScreenState extends ConsumerState<HelpdeskDetailScreen> {
  final _reply = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _reply.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    ref.invalidate(helpdeskTicketProvider(widget.ticketId));
    await ref.read(helpdeskTicketProvider(widget.ticketId).future);
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _sendReply() async {
    final body = _reply.text.trim();
    if (body.isEmpty) return;
    FocusScope.of(context).unfocus();
    setState(() => _busy = true);
    try {
      await ref.read(apiClientProvider).post(Api.helpdeskReply(widget.ticketId), {'body': body});
      _reply.clear();
      await _refresh();
      ref.invalidate(helpdeskTicketsProvider);
    } on ApiException catch (e) {
      _toast(e.message);
    } catch (_) {
      _toast('Could not send your reply.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _reopen() async {
    final reason = await _promptReason();
    if (reason == null) return; // cancelled
    setState(() => _busy = true);
    try {
      await ref.read(apiClientProvider).post(
        Api.helpdeskReopen(widget.ticketId),
        reason.isEmpty ? const <String, dynamic>{} : {'reason': reason},
      );
      await _refresh();
      ref.invalidate(helpdeskTicketsProvider);
      _toast('Ticket reopened.');
    } on ApiException catch (e) {
      _toast(e.message);
    } catch (_) {
      _toast('Could not reopen the ticket.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<String?> _promptReason() {
    final ctrl = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Reopen ticket'),
        content: TextField(
          controller: ctrl,
          maxLines: 3,
          decoration: const InputDecoration(hintText: 'Why are you reopening? (optional)'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text.trim()), child: const Text('Reopen')),
        ],
      ),
    );
  }

  Future<void> _rate(int rating) async {
    setState(() => _busy = true);
    try {
      await ref.read(apiClientProvider).post(Api.helpdeskRate(widget.ticketId), {'rating': rating});
      await _refresh();
      ref.invalidate(helpdeskTicketsProvider);
      _toast('Thanks for your feedback.');
    } on ApiException catch (e) {
      _toast(e.message);
    } catch (_) {
      _toast('Could not save your rating.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(helpdeskTicketProvider(widget.ticketId));
    final myId = _myUserId(ref);
    return Scaffold(
      appBar: AppBar(title: const Text('Ticket')),
      body: AsyncView<Map<String, dynamic>>(
        value: async,
        onRefresh: _refresh,
        data: (t) {
          final status = (t['status'] ?? '').toString().toUpperCase();
          final isTerminal = status == 'CLOSED' || status == 'CANCELLED';
          final canReopen = status == 'RESOLVED' || status == 'CLOSED';
          final canRate = (status == 'RESOLVED' || status == 'CLOSED') && t['satisfactionRating'] == null;
          final rating = (t['satisfactionRating'] as num?)?.toInt();
          final messages = asList(t, keys: const ['messages']);
          final category = t['category'] is Map ? (t['category'] as Map)['name']?.toString() : null;

          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              // ── Header card ──
              SectionCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: Text((t['subject'] ?? 'Ticket').toString(),
                              style: const TextStyle(
                                  fontSize: 17, fontWeight: FontWeight.w800, color: BrandColors.text)),
                        ),
                        const SizedBox(width: 8),
                        helpdeskStatusPill(status),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      [
                        if ((t['code'] ?? '').toString().isNotEmpty) t['code'].toString(),
                        if (category != null && category.isNotEmpty) category,
                        'Raised ${Fmt.date(t['createdAt'])}',
                      ].where((s) => s.isNotEmpty).join(' · '),
                      style: const TextStyle(color: BrandColors.muted, fontSize: 12.5),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        PriorityChip(priority: (t['priority'] ?? 'NORMAL').toString()),
                        const SizedBox(width: 8),
                        if (t['slaDueAt'] != null && !isTerminal)
                          Text('SLA due ${Fmt.date(t['slaDueAt'])}',
                              style: TextStyle(
                                color: t['breached'] == true ? BrandColors.danger : BrandColors.muted,
                                fontSize: 12,
                                fontWeight: t['breached'] == true ? FontWeight.w700 : FontWeight.w500,
                              )),
                      ],
                    ),
                    if (rating != null) ...[
                      const SizedBox(height: 12),
                      _StarRow(value: rating, onRate: null),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 20),

              // ── Thread ──
              const SectionHeading(text: 'Conversation'),
              const SizedBox(height: 10),
              if (messages.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 12),
                  child: Text('No messages on this ticket yet.',
                      style: TextStyle(color: BrandColors.muted, fontSize: 13)),
                )
              else
                ...messages.map((m) => _MessageBubble(
                      message: m,
                      mine: myId != null && m['authorUserId']?.toString() == myId,
                    )),

              // ── Rate (resolved/closed, not yet rated) ──
              if (canRate) ...[
                const SizedBox(height: 12),
                SectionCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('How did we do?',
                          style: TextStyle(fontWeight: FontWeight.w700, color: BrandColors.text)),
                      const SizedBox(height: 4),
                      const Text('Rating a resolved ticket also closes it.',
                          style: TextStyle(color: BrandColors.muted, fontSize: 12)),
                      const SizedBox(height: 10),
                      _StarRow(value: 0, onRate: _busy ? null : _rate),
                    ],
                  ),
                ),
              ],

              // ── Reply / Reopen ──
              const SizedBox(height: 16),
              if (isTerminal && !canReopen)
                const _ClosedNote()
              else if (status == 'CLOSED')
                Column(
                  children: [
                    const _ClosedNote(),
                    const SizedBox(height: 12),
                    OutlinedButton.icon(
                      onPressed: _busy ? null : _reopen,
                      icon: const Icon(Icons.replay, size: 18),
                      label: const Text('Reopen ticket'),
                    ),
                  ],
                )
              else ...[
                TextField(
                  controller: _reply,
                  maxLines: 3,
                  decoration: const InputDecoration(
                    hintText: 'Write a reply…',
                    alignLabelWithHint: true,
                  ),
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: _busy ? null : _sendReply,
                        icon: _busy
                            ? const SizedBox(
                                width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                            : const Icon(Icons.send_outlined, size: 18),
                        label: const Text('Send reply'),
                      ),
                    ),
                    if (canReopen) ...[
                      const SizedBox(width: 10),
                      OutlinedButton(
                        onPressed: _busy ? null : _reopen,
                        child: const Text('Reopen'),
                      ),
                    ],
                  ],
                ),
              ],
              const SizedBox(height: 24),
            ],
          );
        },
      ),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message, required this.mine});

  final Map<String, dynamic> message;
  final bool mine;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        children: [
          Container(
            constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: mine ? BrandColors.tealSoft : BrandColors.card,
              borderRadius: BorderRadius.circular(BrandRadii.md),
              border: Border.all(color: mine ? BrandColors.teal.withValues(alpha: 0.35) : BrandColors.border),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(mine ? 'You' : 'Support',
                    style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w800,
                        color: mine ? BrandColors.tealDark : BrandColors.muted)),
                const SizedBox(height: 4),
                Text((message['body'] ?? '').toString(),
                    style: const TextStyle(fontSize: 14, color: BrandColors.text)),
              ],
            ),
          ),
          const SizedBox(height: 3),
          Text(
            '${Fmt.date(message['createdAt'])} · ${Fmt.time(message['createdAt'])}',
            style: const TextStyle(color: BrandColors.muted, fontSize: 10.5),
          ),
        ],
      ),
    );
  }
}

class _StarRow extends StatelessWidget {
  const _StarRow({required this.value, required this.onRate});

  final int value;
  final void Function(int rating)? onRate;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: List.generate(5, (i) {
        final n = i + 1;
        final filled = n <= value;
        return IconButton(
          onPressed: onRate == null ? null : () => onRate!(n),
          visualDensity: VisualDensity.compact,
          padding: EdgeInsets.zero,
          constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
          icon: Icon(
            filled ? Icons.star_rounded : Icons.star_border_rounded,
            color: filled ? BrandColors.warning : BrandColors.muted,
            size: 28,
          ),
        );
      }),
    );
  }
}

class _ClosedNote extends StatelessWidget {
  const _ClosedNote();

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: const Color(0xFFF1F5F9),
          borderRadius: BorderRadius.circular(BrandRadii.md),
          border: Border.all(color: BrandColors.border),
        ),
        child: const Text(
          'This ticket is closed. Reopen it if you still need help.',
          style: TextStyle(color: BrandColors.muted, fontSize: 12.5),
        ),
      );
}
