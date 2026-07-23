// Give recognition — a pushed full-screen flow (/recognition/give). Pick one or
// more colleagues (directory multi-select → removable chips), an optional company
// value + badge, a required message, optional points (only when the points economy
// is on), and a visibility. POST /api/hr/me/recognitions. The server's 4xx/409 is
// surfaced verbatim (daily cap, "already recognised these colleagues today", …) and
// the needsApproval banner is shown from the response.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';
import 'recognition_common.dart';
import 'recognition_providers.dart';

const _visibilities = <(String, String)>[
  ('PUBLIC', 'Public — everyone can see it on the wall'),
  ('TEAM', 'Team — visible to your team only'),
  ('PRIVATE', 'Private — only the recipient(s)'),
];

class GiveRecognitionScreen extends ConsumerStatefulWidget {
  const GiveRecognitionScreen({super.key});

  @override
  ConsumerState<GiveRecognitionScreen> createState() => _GiveRecognitionScreenState();
}

class _GiveRecognitionScreenState extends ConsumerState<GiveRecognitionScreen> {
  final List<Map<String, dynamic>> _recipients = [];
  String? _valueId;
  String? _badgeId;
  String _visibility = 'PUBLIC';
  final _message = TextEditingController();
  final _points = TextEditingController();

  bool _submitting = false;
  String? _error;
  bool _done = false;
  bool _needsApproval = false;
  String _resultMessage = '';

  @override
  void dispose() {
    _message.dispose();
    _points.dispose();
    super.dispose();
  }

  void _addRecipient(Map<String, dynamic> p) {
    if (_recipients.any((e) => e['id'].toString() == p['id'].toString())) return;
    setState(() => _recipients.add(p));
  }

  void _removeRecipient(String id) =>
      setState(() => _recipients.removeWhere((e) => e['id'].toString() == id));

  void _reset() {
    setState(() {
      _recipients.clear();
      _valueId = null;
      _badgeId = null;
      _visibility = 'PUBLIC';
      _message.clear();
      _points.clear();
      _error = null;
      _done = false;
      _needsApproval = false;
      _resultMessage = '';
    });
  }

  Future<void> _submit({required bool pointsEnabled}) async {
    if (_recipients.isEmpty) {
      setState(() => _error = 'Pick at least one colleague to recognise.');
      return;
    }
    if (_message.text.trim().isEmpty) {
      setState(() => _error = 'Add a message — say why they deserve it.');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final body = <String, dynamic>{
        'recipientEmployeeIds': _recipients.map((e) => e['id'].toString()).toList(),
        'message': _message.text.trim(),
        'visibility': _visibility,
        if (_valueId != null) 'valueId': _valueId,
        if (_badgeId != null) 'badgeId': _badgeId,
      };
      if (pointsEnabled) {
        final pts = int.tryParse(_points.text.trim());
        if (pts != null && pts >= 0) body['pointsEach'] = pts;
      }
      final res = await ref.read(apiClientProvider).post(Api.recognitions, body);
      final map = res is Map ? res.cast<String, dynamic>() : const <String, dynamic>{};
      // Refresh every surface a new recognition touches.
      ref.invalidate(recognitionWallProvider);
      ref.invalidate(walletProvider);
      ref.invalidate(walletLedgerProvider);
      setState(() {
        _done = true;
        _needsApproval = map['needsApproval'] == true;
        _resultMessage = (map['message'] ??
                (map['needsApproval'] == true
                    ? 'Your manager will approve the points first.'
                    : 'Your kudos is now on the wall.'))
            .toString();
      });
    } on ApiException catch (e) {
      // Surface the server message verbatim — the 409 daily-cap / pair-spam text.
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not send your recognition. Please try again.');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final optionsAsync = ref.watch(giveOptionsProvider);
    // pointsEnabled drives whether the points field shows (null → assume on until known).
    final pointsEnabled = ref.watch(walletProvider).valueOrNull?['pointsEnabled'] != false;

    return Scaffold(
      appBar: AppBar(title: const Text('Give recognition')),
      body: AsyncView<Map<String, dynamic>>(
        value: optionsAsync,
        onRefresh: () async {
          ref.invalidate(giveOptionsProvider);
          await ref.read(giveOptionsProvider.future);
        },
        data: (options) {
          if (_done) return _successView();
          final values = asList(options, keys: const ['values']);
          final badges = asList(options, keys: const ['badges']);
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              if (_error != null) ...[ErrorBanner(message: _error!), const SizedBox(height: 14)],
              const SectionHeading(text: 'Who are you recognising?'),
              const SizedBox(height: 8),
              SectionCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (_recipients.isNotEmpty) ...[
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: _recipients
                            .map((p) => InputChip(
                                  label: Text(personName(p)),
                                  avatar: PersonAvatar(name: personName(p), size: 24),
                                  onDeleted: () => _removeRecipient(p['id'].toString()),
                                ))
                            .toList(),
                      ),
                      const SizedBox(height: 12),
                    ],
                    ColleagueSearchField(
                      onPick: _addRecipient,
                      excludeIds: _recipients.map((e) => e['id'].toString()).toSet(),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 20),
              if (values.isNotEmpty) ...[
                const SectionHeading(text: 'Company value (optional)'),
                const SizedBox(height: 8),
                _ValuePicker(
                  values: values,
                  selectedId: _valueId,
                  onSelect: (id) => setState(() => _valueId = _valueId == id ? null : id),
                ),
                const SizedBox(height: 20),
              ],
              if (badges.isNotEmpty) ...[
                const SectionHeading(text: 'Badge (optional)'),
                const SizedBox(height: 8),
                _BadgePicker(
                  badges: badges,
                  selectedId: _badgeId,
                  onSelect: (id, defaultPoints) {
                    setState(() {
                      if (_badgeId == id) {
                        _badgeId = null;
                      } else {
                        _badgeId = id;
                        // Mirror the server: prefill points from the badge default.
                        if (pointsEnabled && _points.text.trim().isEmpty && defaultPoints != null) {
                          _points.text = '$defaultPoints';
                        }
                      }
                    });
                  },
                ),
                const SizedBox(height: 20),
              ],
              const SectionHeading(text: 'Your message'),
              const SizedBox(height: 8),
              TextField(
                controller: _message,
                maxLines: 4,
                maxLength: 2000,
                decoration: const InputDecoration(
                  hintText: 'Say why they deserve it…',
                  alignLabelWithHint: true,
                ),
              ),
              const SizedBox(height: 8),
              if (pointsEnabled) ...[
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _points,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(
                          labelText: 'Points each (optional)',
                          isDense: true,
                          helperText: 'Awarded to each colleague',
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
              ],
              DropdownButtonFormField<String>(
                value: _visibility,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Visibility', isDense: true),
                items: _visibilities
                    .map((v) => DropdownMenuItem(value: v.$1, child: Text(v.$2, overflow: TextOverflow.ellipsis)))
                    .toList(),
                onChanged: (v) => setState(() => _visibility = v ?? 'PUBLIC'),
              ),
              const SizedBox(height: 18),
              FilledButton.icon(
                onPressed: _submitting ? null : () => _submit(pointsEnabled: pointsEnabled),
                icon: _submitting
                    ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : const Icon(Icons.emoji_events_outlined, size: 20),
                label: Text(_submitting ? 'Sending…' : 'Send recognition'),
              ),
              const SizedBox(height: 24),
            ],
          );
        },
      ),
    );
  }

  Widget _successView() {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const SizedBox(height: 24),
        Center(
          child: Container(
            width: 64,
            height: 64,
            alignment: Alignment.center,
            decoration: const BoxDecoration(color: BrandColors.tealSoft, shape: BoxShape.circle),
            child: const Text('🎉', style: TextStyle(fontSize: 30)),
          ),
        ),
        const SizedBox(height: 16),
        const Center(
          child: Text('Recognition sent!',
              style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: BrandColors.text)),
        ),
        const SizedBox(height: 16),
        if (_needsApproval)
          ApprovalPendingBanner(message: _resultMessage)
        else
          SuccessBanner(message: _resultMessage),
        const SizedBox(height: 22),
        FilledButton(onPressed: _reset, child: const Text('Give another')),
        const SizedBox(height: 10),
        OutlinedButton(
          onPressed: () => Navigator.of(context).maybePop(),
          child: const Text('Done'),
        ),
        const SizedBox(height: 24),
      ],
    );
  }
}

class _ValuePicker extends StatelessWidget {
  const _ValuePicker({required this.values, required this.selectedId, required this.onSelect});

  final List<Map<String, dynamic>> values;
  final String? selectedId;
  final void Function(String id) onSelect;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: values.map((v) {
        final id = v['id'].toString();
        final selected = id == selectedId;
        final c = hexColor(v['colorHex']);
        return ChoiceChip(
          selected: selected,
          onSelected: (_) => onSelect(id),
          showCheckmark: false,
          selectedColor: c.withValues(alpha: 0.18),
          side: BorderSide(color: selected ? c : BrandColors.border),
          label: Text(
            [if ('${v['icon'] ?? ''}'.isNotEmpty) v['icon'], v['name'] ?? 'Value'].join(' '),
            style: TextStyle(
              color: selected ? c : BrandColors.text,
              fontWeight: selected ? FontWeight.w800 : FontWeight.w600,
              fontSize: 12.5,
            ),
          ),
        );
      }).toList(),
    );
  }
}

class _BadgePicker extends StatelessWidget {
  const _BadgePicker({required this.badges, required this.selectedId, required this.onSelect});

  final List<Map<String, dynamic>> badges;
  final String? selectedId;
  final void Function(String id, int? defaultPoints) onSelect;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: badges.map((b) {
        final id = b['id'].toString();
        final selected = id == selectedId;
        final pts = (b['defaultPoints'] as num?)?.toInt();
        return ChoiceChip(
          selected: selected,
          onSelected: (_) => onSelect(id, pts),
          showCheckmark: false,
          selectedColor: BrandColors.tealSoft,
          side: BorderSide(color: selected ? BrandColors.teal : BrandColors.border),
          label: Text(
            [
              if ('${b['icon'] ?? ''}'.isNotEmpty) b['icon'],
              b['name'] ?? 'Badge',
              if (pts != null && pts > 0) '· $pts pts',
            ].join(' '),
            style: TextStyle(
              color: selected ? BrandColors.tealDark : BrandColors.text,
              fontWeight: selected ? FontWeight.w800 : FontWeight.w600,
              fontSize: 12.5,
            ),
          ),
        );
      }).toList(),
    );
  }
}
