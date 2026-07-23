// Surveys — my open pulses. Each row shows a done/pending chip and, for an
// anonymous survey, a lock note that responses aren't tied to me. A pending survey
// opens the fill form. SELF-only /api/hr/me/engagement/surveys.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';
import 'surveys_providers.dart';

class SurveysScreen extends ConsumerWidget {
  const SurveysScreen({super.key});

  Future<void> _refresh(WidgetRef ref) async {
    ref.invalidate(surveysProvider);
    await ref.read(surveysProvider.future);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(surveysProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Surveys')),
      body: AsyncView<List<Map<String, dynamic>>>(
        value: async,
        treat404AsEmpty: true,
        emptyText: 'No open surveys right now.',
        onRefresh: () => _refresh(ref),
        data: (items) {
          if (items.isEmpty) {
            return ListView(
              children: const [
                SizedBox(height: 80),
                EmptyView(
                  icon: Icons.poll_outlined,
                  text: 'No open surveys right now.\nWhen your team runs a pulse, it will appear here.',
                ),
              ],
            );
          }
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              const Text(
                'Your voice shapes the workplace. Open pulses are listed below.',
                style: TextStyle(color: BrandColors.muted, fontSize: 12.5),
              ),
              const SizedBox(height: 14),
              ...items.map((s) => _SurveyTile(occurrence: s)),
              const SizedBox(height: 24),
            ],
          );
        },
      ),
    );
  }
}

class _SurveyTile extends StatelessWidget {
  const _SurveyTile({required this.occurrence});

  final Map<String, dynamic> occurrence;

  @override
  Widget build(BuildContext context) {
    final o = occurrence;
    final survey = o['survey'] is Map ? (o['survey'] as Map).cast<String, dynamic>() : const <String, dynamic>{};
    final title = (survey['title'] ?? 'Survey').toString();
    final anonymous = survey['anonymous'] == true;
    final type = survey['type']?.toString();
    final state = (o['state'] ?? 'PENDING').toString().toUpperCase();
    final closesAt = o['closesAt'];
    final done = state == 'SUBMITTED';
    final dismissed = state == 'DISMISSED';
    final occurrenceId = o['occurrenceId'].toString();

    final chip = done
        ? const StatusPill(label: 'Done', fg: Color(0xFF047857), bg: Color(0xFFECFDF5))
        : dismissed
            ? const StatusPill(label: 'Dismissed', fg: BrandColors.muted, bg: Color(0xFFF1F5F9))
            : const StatusPill(label: 'Pending', fg: Color(0xFFB45309), bg: Color(0xFFFFFBEB));

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        borderRadius: BorderRadius.circular(BrandRadii.lg),
        onTap: done || dismissed ? null : () => context.push('/surveys/$occurrenceId'),
        child: SectionCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Text(title,
                        style: const TextStyle(
                            fontSize: 15, fontWeight: FontWeight.w800, color: BrandColors.text)),
                  ),
                  const SizedBox(width: 8),
                  chip,
                ],
              ),
              const SizedBox(height: 6),
              Text(
                [
                  if (type != null && type.isNotEmpty) type,
                  if (closesAt != null) 'Closes ${Fmt.date(closesAt)}',
                ].where((s) => s.isNotEmpty).join(' · '),
                style: const TextStyle(color: BrandColors.muted, fontSize: 12),
              ),
              if (anonymous) ...[
                const SizedBox(height: 10),
                const _AnonymityNote(),
              ],
              if (!done && !dismissed) ...[
                const SizedBox(height: 12),
                const Row(
                  children: [
                    Text('Take the survey',
                        style: TextStyle(color: BrandColors.teal, fontSize: 13, fontWeight: FontWeight.w700)),
                    Icon(Icons.chevron_right, size: 18, color: BrandColors.teal),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _AnonymityNote extends StatelessWidget {
  const _AnonymityNote();

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: BrandColors.tealSoft,
          borderRadius: BorderRadius.circular(BrandRadii.sm),
          border: Border.all(color: BrandColors.border),
        ),
        child: const Row(
          children: [
            Icon(Icons.lock_outline, size: 15, color: BrandColors.tealDark),
            SizedBox(width: 6),
            Expanded(
              child: Text(
                'Anonymous — your answers are never linked to you.',
                style: TextStyle(fontSize: 12, color: BrandColors.text),
              ),
            ),
          ],
        ),
      );
}
