// Directory profile — a colleague's safe work card (name / designation / department
// / work email / work phone per their sharing preference / entity / location /
// manager / direct-reports count). Read-only; the backend Prisma select is the
// privacy boundary, so we render exactly what it returns and invent nothing.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';
import 'directory_common.dart';
import 'directory_providers.dart';

class DirectoryProfileScreen extends ConsumerWidget {
  const DirectoryProfileScreen({super.key, required this.employeeId});

  final String employeeId;

  Future<void> _refresh(WidgetRef ref) async {
    ref.invalidate(directoryProfileProvider(employeeId));
    await ref.read(directoryProfileProvider(employeeId).future);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(directoryProfileProvider(employeeId));
    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: AsyncView<Map<String, dynamic>>(
        value: async,
        onRefresh: () => _refresh(ref),
        data: (c) {
          final name = colleagueName(c);
          final designation = (c['designation'] ?? '').toString();
          final department = (c['department'] ?? '').toString();
          final workEmail = (c['workEmail'] ?? '').toString();
          final workPhone = (c['workPhone'] ?? '').toString();
          final phoneShared = c['workPhoneShared'] == true;
          final entity = (c['entity'] ?? '').toString();
          final location = (c['location'] ?? '').toString();
          final manager = c['manager'] is Map ? (c['manager'] as Map).cast<String, dynamic>() : null;
          final reports = (c['reportsCount'] as num?)?.toInt() ?? 0;

          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              // Header
              SectionCard(
                child: Column(
                  children: [
                    DirectoryAvatar(name: name, photoUrl: c['photoUrl']?.toString(), size: 72),
                    const SizedBox(height: 12),
                    Text(name,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                            fontSize: 20, fontWeight: FontWeight.w800, color: BrandColors.text)),
                    if (designation.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Text(designation,
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: BrandColors.tealDark, fontWeight: FontWeight.w600)),
                    ],
                    if (department.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(department,
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: BrandColors.muted, fontSize: 13)),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 18),

              // Contact
              if (workEmail.isNotEmpty || workPhone.isNotEmpty) ...[
                const SectionHeading(text: 'Contact'),
                const SizedBox(height: 8),
                SectionCard(
                  padding: EdgeInsets.zero,
                  child: Column(
                    children: [
                      if (workEmail.isNotEmpty)
                        _ContactRow(icon: Icons.mail_outline, label: 'Work email', value: workEmail),
                      if (workEmail.isNotEmpty && workPhone.isNotEmpty) const Divider(height: 1),
                      if (workPhone.isNotEmpty)
                        _ContactRow(icon: Icons.phone_outlined, label: 'Work phone', value: workPhone),
                    ],
                  ),
                ),
                if (!phoneShared && workPhone.isEmpty) ...[
                  const SizedBox(height: 6),
                  const Text('This colleague keeps their work phone private.',
                      style: TextStyle(color: BrandColors.muted, fontSize: 12)),
                ],
                const SizedBox(height: 18),
              ],

              // Organisation
              const SectionHeading(text: 'Organisation'),
              const SizedBox(height: 8),
              SectionCard(
                child: Column(
                  children: [
                    if (entity.isNotEmpty) KvRow(label: 'Entity', value: entity),
                    if (location.isNotEmpty) KvRow(label: 'Location', value: location),
                    KvRow(label: 'Direct reports', value: '$reports'),
                  ],
                ),
              ),

              // Manager
              if (manager != null && (manager['id'] != null)) ...[
                const SizedBox(height: 18),
                const SectionHeading(text: 'Reports to'),
                const SizedBox(height: 8),
                InkWell(
                  borderRadius: BorderRadius.circular(BrandRadii.lg),
                  onTap: () => context.push('/directory/${manager['id']}'),
                  child: SectionCard(
                    padding: const EdgeInsets.all(12),
                    child: Row(
                      children: [
                        DirectoryAvatar(name: colleagueName(manager), size: 36),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(colleagueName(manager),
                              style: const TextStyle(fontWeight: FontWeight.w700, color: BrandColors.text)),
                        ),
                        const Icon(Icons.chevron_right, color: BrandColors.teal),
                      ],
                    ),
                  ),
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

class _ContactRow extends StatelessWidget {
  const _ContactRow({required this.icon, required this.label, required this.value});

  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: Icon(icon, color: BrandColors.tealDark, size: 20),
      title: Text(label, style: const TextStyle(color: BrandColors.muted, fontSize: 12)),
      subtitle: Text(value,
          style: const TextStyle(color: BrandColors.text, fontWeight: FontWeight.w600, fontSize: 14)),
      trailing: IconButton(
        icon: const Icon(Icons.copy_outlined, size: 18, color: BrandColors.muted),
        tooltip: 'Copy',
        onPressed: () {
          Clipboard.setData(ClipboardData(text: value));
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('$label copied')),
          );
        },
      ),
    );
  }
}
