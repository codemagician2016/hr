// Directory — search colleagues (debounced) and tap through to a safe work profile.
// A "My visibility" card lets me toggle whether my work phone is shared in the
// directory (PATCH /me/directory/preferences). SELF-scope /api/hr/me/directory.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';
import 'directory_common.dart';
import 'directory_providers.dart';

class DirectoryScreen extends ConsumerStatefulWidget {
  const DirectoryScreen({super.key});

  @override
  ConsumerState<DirectoryScreen> createState() => _DirectoryScreenState();
}

class _DirectoryScreenState extends ConsumerState<DirectoryScreen> {
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
    _debounce = Timer(const Duration(milliseconds: 260), () {
      if (mounted) setState(() => _query = v.trim());
    });
  }

  Future<void> _refresh() async {
    ref.invalidate(directoryListProvider(_query));
    ref.invalidate(directoryPreferencesProvider);
    await ref.read(directoryListProvider(_query).future);
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(directoryListProvider(_query));
    return Scaffold(
      appBar: AppBar(title: const Text('Directory')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: TextField(
              controller: _controller,
              onChanged: _onChanged,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                hintText: 'Search by name, designation, department…',
                prefixIcon: const Icon(Icons.search, size: 20),
                isDense: true,
                suffixIcon: _query.isEmpty
                    ? null
                    : IconButton(
                        icon: const Icon(Icons.clear, size: 18),
                        onPressed: () {
                          _controller.clear();
                          setState(() => _query = '');
                        },
                      ),
              ),
            ),
          ),
          Expanded(
            child: AsyncView<({List<Map<String, dynamic>> items, int total})>(
              value: async,
              treat404AsEmpty: true,
              emptyText: 'No colleagues to show.',
              onRefresh: _refresh,
              data: (page) {
                final items = page.items;
                return ListView(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                  children: [
                    if (_query.isEmpty) const _VisibilityCard(),
                    if (_query.isEmpty) const SizedBox(height: 16),
                    if (items.isEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 40),
                        child: EmptyView(
                          icon: Icons.groups_outlined,
                          text: _query.isEmpty
                              ? 'No colleagues in the directory yet.'
                              : 'No colleagues match “$_query”.',
                        ),
                      )
                    else ...[
                      ...items.map((c) => _ColleagueTile(colleague: c)),
                      if (page.total > items.length) ...[
                        const SizedBox(height: 8),
                        Text(
                          'Showing ${items.length} of ${page.total}. Refine your search to narrow the list.',
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: BrandColors.muted, fontSize: 12),
                        ),
                      ],
                    ],
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _ColleagueTile extends StatelessWidget {
  const _ColleagueTile({required this.colleague});

  final Map<String, dynamic> colleague;

  @override
  Widget build(BuildContext context) {
    final c = colleague;
    final name = colleagueName(c);
    final sub = [c['designation'], c['department']]
        .where((x) => x != null && '$x'.trim().isNotEmpty)
        .join(' · ');
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        borderRadius: BorderRadius.circular(BrandRadii.lg),
        onTap: () => context.push('/directory/${c['id']}'),
        child: SectionCard(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              DirectoryAvatar(name: name, photoUrl: c['photoUrl']?.toString()),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontWeight: FontWeight.w700, color: BrandColors.text)),
                    if (sub.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(sub,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(color: BrandColors.muted, fontSize: 12.5)),
                    ],
                  ],
                ),
              ),
              const Icon(Icons.chevron_right, color: BrandColors.teal),
            ],
          ),
        ),
      ),
    );
  }
}

/// A compact card that surfaces + toggles my own work-phone visibility.
class _VisibilityCard extends ConsumerStatefulWidget {
  const _VisibilityCard();

  @override
  ConsumerState<_VisibilityCard> createState() => _VisibilityCardState();
}

class _VisibilityCardState extends ConsumerState<_VisibilityCard> {
  bool _busy = false;

  Future<void> _toggle(bool hide) async {
    setState(() => _busy = true);
    try {
      await ref.read(apiClientProvider).patch(Api.directoryPreferences, {'hideWorkPhone': hide});
      ref.invalidate(directoryPreferencesProvider);
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final prefs = ref.watch(directoryPreferencesProvider);
    return prefs.maybeWhen(
      orElse: () => const SizedBox.shrink(),
      data: (p) {
        final linked = p['linked'] == true;
        final hasPhone = p['hasWorkPhone'] == true;
        final hidden = p['hideWorkPhone'] == true;
        if (!linked) return const SizedBox.shrink();
        return SectionCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SectionHeading(text: 'My visibility'),
              const SizedBox(height: 6),
              if (!hasPhone)
                const Text(
                  'You have no work phone on file, so nothing extra is shared. Your name, designation and work email are always listed.',
                  style: TextStyle(color: BrandColors.muted, fontSize: 12.5),
                )
              else
                Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Share my work phone',
                              style: TextStyle(fontWeight: FontWeight.w600, color: BrandColors.text)),
                          const SizedBox(height: 2),
                          Text(
                            hidden ? 'Hidden from colleagues' : 'Visible to colleagues',
                            style: const TextStyle(color: BrandColors.muted, fontSize: 12),
                          ),
                        ],
                      ),
                    ),
                    if (_busy)
                      const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.2))
                    else
                      Switch(
                        value: !hidden,
                        onChanged: (v) => _toggle(!v),
                      ),
                  ],
                ),
            ],
          ),
        );
      },
    );
  }
}
