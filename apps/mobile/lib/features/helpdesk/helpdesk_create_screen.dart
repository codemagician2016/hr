// Raise a ticket — a pushed flow (/helpdesk/new). Optional category, a required
// subject, an optional description (also becomes the first thread message), and a
// priority. POST /api/hr/me/helpdesk/tickets. The server's 4xx is surfaced verbatim;
// on success we pop to the (refreshed) list.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';
import 'helpdesk_common.dart';
import 'helpdesk_providers.dart';

class HelpdeskCreateScreen extends ConsumerStatefulWidget {
  const HelpdeskCreateScreen({super.key});

  @override
  ConsumerState<HelpdeskCreateScreen> createState() => _HelpdeskCreateScreenState();
}

class _HelpdeskCreateScreenState extends ConsumerState<HelpdeskCreateScreen> {
  String? _categoryId;
  String _priority = 'NORMAL';
  final _subject = TextEditingController();
  final _description = TextEditingController();
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _subject.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_subject.text.trim().isEmpty) {
      setState(() => _error = 'Give your ticket a short subject.');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await ref.read(apiClientProvider).post(Api.helpdeskTickets, {
        'subject': _subject.text.trim(),
        if (_description.text.trim().isNotEmpty) 'description': _description.text.trim(),
        'priority': _priority,
        if (_categoryId != null) 'categoryId': _categoryId,
      });
      ref.invalidate(helpdeskTicketsProvider);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Ticket raised.')),
        );
        Navigator.of(context).maybePop();
      }
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not raise the ticket. Please try again.');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final refAsync = ref.watch(helpdeskReferenceProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Raise a ticket')),
      body: AsyncView<Map<String, dynamic>>(
        value: refAsync,
        onRefresh: () async {
          ref.invalidate(helpdeskReferenceProvider);
          await ref.read(helpdeskReferenceProvider.future);
        },
        data: (reference) {
          final categories = asList(reference, keys: const ['categories']);
          final priorities = (reference['priorities'] is List)
              ? (reference['priorities'] as List).map((e) => e.toString()).toList()
              : const ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              if (_error != null) ...[ErrorBanner(message: _error!), const SizedBox(height: 14)],
              const SectionHeading(text: 'Category'),
              const SizedBox(height: 8),
              if (categories.isEmpty)
                const Text('No categories configured — leave blank and describe your issue below.',
                    style: TextStyle(color: BrandColors.muted, fontSize: 12.5))
              else
                DropdownButtonFormField<String>(
                  value: _categoryId,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'Category (optional)'),
                  hint: const Text('Select a category'),
                  items: categories
                      .map((c) => DropdownMenuItem(
                            value: c['id'].toString(),
                            child: Text((c['name'] ?? 'Category').toString()),
                          ))
                      .toList(),
                  onChanged: (v) => setState(() => _categoryId = v),
                ),
              const SizedBox(height: 18),
              const SectionHeading(text: 'Subject'),
              const SizedBox(height: 8),
              TextField(
                controller: _subject,
                maxLength: 200,
                decoration: const InputDecoration(hintText: 'e.g. Payslip not visible for June'),
              ),
              const SizedBox(height: 8),
              const SectionHeading(text: 'Description'),
              const SizedBox(height: 8),
              TextField(
                controller: _description,
                maxLines: 5,
                decoration: const InputDecoration(
                  hintText: 'Describe the issue so the team can help faster…',
                  alignLabelWithHint: true,
                ),
              ),
              const SizedBox(height: 18),
              const SectionHeading(text: 'Priority'),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: priorities.map((p) {
                  final selected = p == _priority;
                  return ChoiceChip(
                    selected: selected,
                    showCheckmark: false,
                    selectedColor: BrandColors.tealSoft,
                    side: BorderSide(color: selected ? BrandColors.teal : BrandColors.border),
                    onSelected: (_) => setState(() => _priority = p),
                    label: Text(
                      prettyStatus(p),
                      style: TextStyle(
                        color: selected ? BrandColors.tealDark : BrandColors.text,
                        fontWeight: selected ? FontWeight.w800 : FontWeight.w600,
                        fontSize: 12.5,
                      ),
                    ),
                  );
                }).toList(),
              ),
              const SizedBox(height: 22),
              FilledButton.icon(
                onPressed: _submitting ? null : _submit,
                icon: _submitting
                    ? const SizedBox(
                        width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : const Icon(Icons.send_outlined, size: 20),
                label: Text(_submitting ? 'Raising…' : 'Raise ticket'),
              ),
              const SizedBox(height: 24),
            ],
          );
        },
      ),
    );
  }
}
