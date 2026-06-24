// Profile — the employee's rich Personal Information (GET /api/hr/me/profile/full).
// Every field carries a server-driven governance policy: self-edit (commits
// immediately via PATCH personal/contact), hr-approval (files a change request),
// or read-only. We render Personal / Contact / Professional sections and support
// inline editing of the self-edit + hr-approval fields. Mirrors the governance
// model of apps/ess/app/profile/page.js (a focused, mobile-first subset).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/format.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';

final profileFullProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final res = await api.get(Api.meProfileFull);
  return res is Map<String, dynamic> ? res : <String, dynamic>{};
});

const _contactFields = {'phone', 'homePhone', 'officePhone', 'personalEmail'};

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(profileFullProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Personal Information')),
      body: AsyncView<Map<String, dynamic>>(
        value: async,
        onRefresh: () => ref.refresh(profileFullProvider.future),
        data: (data) {
          final sections = data['sections'];
          if (sections is! Map) {
            return const EmptyView(text: 'No employee record is linked to your account yet.');
          }
          final s = sections.cast<String, dynamic>();
          final pending = (data['pendingChangeRequests'] as Map?)?.cast<String, dynamic>() ?? const {};
          final readOnly = data['readOnly'] == true;

          final personal = (s['personal'] as Map?)?.cast<String, dynamic>() ?? const {};
          final contact = (s['contact'] as Map?)?.cast<String, dynamic>() ?? const {};
          final professional = (s['professional'] as Map?)?.cast<String, dynamic>() ?? const {};

          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              if (readOnly)
                Container(
                  margin: const EdgeInsets.only(bottom: 12),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: BrandColors.warningSoft,
                    borderRadius: BorderRadius.circular(BrandRadii.md),
                  ),
                  child: const Text(
                    'Your account is no longer active, so your profile is read-only.',
                    style: TextStyle(color: Color(0xFF92400E), fontSize: 13),
                  ),
                ),
              _ProfileSection(
                title: 'Personal',
                fields: const [
                  ('firstName', 'First name'),
                  ('lastName', 'Last name'),
                  ('dateOfBirth', 'Date of birth'),
                  ('gender', 'Gender'),
                  ('maritalStatus', 'Marital status'),
                  ('bloodGroup', 'Blood group'),
                  ('nationality', 'Nationality'),
                ],
                source: personal,
                pending: pending,
                readOnly: readOnly,
              ),
              const SizedBox(height: 12),
              _ProfileSection(
                title: 'Contact',
                fields: const [
                  ('personalEmail', 'Personal email'),
                  ('workEmail', 'Official email'),
                  ('phone', 'Mobile'),
                  ('homePhone', 'Home phone'),
                  ('officePhone', 'Office phone'),
                ],
                source: contact,
                pending: pending,
                readOnly: readOnly,
              ),
              const SizedBox(height: 12),
              _ProfileSection(
                title: 'Professional',
                fields: const [
                  ('employeeCode', 'Employee code'),
                  ('designation', 'Designation'),
                  ('department', 'Department'),
                  ('location', 'Location'),
                  ('dateOfJoining', 'Date of joining'),
                  ('manager', 'Manager'),
                  ('status', 'Status'),
                ],
                source: professional,
                pending: pending,
                readOnly: true, // managed by HR / manager
              ),
              const SizedBox(height: 24),
            ],
          );
        },
      ),
    );
  }
}

class _ProfileSection extends StatelessWidget {
  const _ProfileSection({
    required this.title,
    required this.fields,
    required this.source,
    required this.pending,
    required this.readOnly,
  });

  final String title;
  final List<(String, String)> fields;
  final Map<String, dynamic> source;
  final Map<String, dynamic> pending;
  final bool readOnly;

  @override
  Widget build(BuildContext context) {
    final rows = <Widget>[];
    for (final f in fields) {
      final field = source[f.$1];
      // Each field is a governed `{ value, policy, … }` object; skip anything
      // that isn't (the backend never sends a bare scalar for a known field).
      if (field is! Map) continue;
      rows.add(_FieldRow(
        fieldKey: f.$1,
        label: f.$2,
        field: field.cast<String, dynamic>(),
        pending: pending[f.$1] is Map ? (pending[f.$1] as Map).cast<String, dynamic>() : null,
        readOnly: readOnly,
      ));
    }
    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SectionHeading(text: title),
          const SizedBox(height: 4),
          if (rows.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8),
              child: Text('Nothing on file.', style: TextStyle(color: BrandColors.muted)),
            )
          else
            ...rows,
        ],
      ),
    );
  }
}

class _FieldRow extends ConsumerStatefulWidget {
  const _FieldRow({
    required this.fieldKey,
    required this.label,
    required this.field,
    required this.pending,
    required this.readOnly,
  });

  final String fieldKey;
  final String label;
  final Map<String, dynamic> field;
  final Map<String, dynamic>? pending;
  final bool readOnly;

  @override
  ConsumerState<_FieldRow> createState() => _FieldRowState();
}

class _FieldRowState extends ConsumerState<_FieldRow> {
  bool _editing = false;
  bool _busy = false;
  late final TextEditingController _ctl =
      TextEditingController(text: widget.field['value']?.toString() ?? '');

  @override
  void dispose() {
    _ctl.dispose();
    super.dispose();
  }

  String get _policy => (widget.field['policy'] ?? 'read-only').toString();

  String _displayValue() {
    final v = widget.field['value'];
    if (v == null || v.toString().isEmpty) return '—';
    // Date-ish fields display formatted.
    if (widget.fieldKey.toLowerCase().contains('date')) return Fmt.date(v);
    return v.toString();
  }

  Future<void> _save() async {
    setState(() => _busy = true);
    try {
      final api = ref.read(apiClientProvider);
      if (_policy == 'hr-approval') {
        await api.post('${Api.meProfile}/change-requests', {
          'changes': [
            {'field': widget.fieldKey, 'newValue': _ctl.text},
          ],
        });
        _toast('Change request sent to HR');
      } else {
        final path = _contactFields.contains(widget.fieldKey) ? 'contact' : 'personal';
        await api.patch('${Api.meProfile}/$path', {widget.fieldKey: _ctl.text});
        _toast('Saved');
      }
      ref.invalidate(profileFullProvider);
      if (mounted) setState(() => _editing = false);
    } on ApiException catch (e) {
      _toast(e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _toast(String msg) {
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final editable = !widget.readOnly && _policy != 'read-only';
    final pendingLabel = widget.pending?['newValue'];

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(widget.label, style: const TextStyle(color: BrandColors.muted, fontSize: 12)),
                    if (!_editing) ...[
                      const SizedBox(height: 2),
                      Text(_displayValue(),
                          style: const TextStyle(color: BrandColors.text, fontWeight: FontWeight.w600)),
                    ],
                  ],
                ),
              ),
              if (editable && !_editing && widget.pending == null)
                IconButton(
                  visualDensity: VisualDensity.compact,
                  icon: Icon(
                    _policy == 'hr-approval' ? Icons.lock_outline : Icons.edit_outlined,
                    size: 18,
                    color: _policy == 'hr-approval' ? BrandColors.warning : BrandColors.success,
                  ),
                  onPressed: () => setState(() => _editing = true),
                ),
            ],
          ),
          if (widget.pending != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: StatusPill(
                label: 'Pending HR approval${pendingLabel != null ? ' → $pendingLabel' : ''}',
                fg: const Color(0xFF92400E),
                bg: BrandColors.warningSoft,
              ),
            ),
          if (_editing) ...[
            const SizedBox(height: 6),
            TextField(controller: _ctl, decoration: const InputDecoration(isDense: true)),
            if (_policy == 'hr-approval')
              const Padding(
                padding: EdgeInsets.only(top: 4),
                child: Text('This change needs HR approval — we will send a request.',
                    style: TextStyle(color: BrandColors.warning, fontSize: 11)),
              ),
            const SizedBox(height: 8),
            Row(
              children: [
                FilledButton(
                  onPressed: _busy ? null : _save,
                  style: FilledButton.styleFrom(minimumSize: const Size(0, 36)),
                  child: Text(_busy
                      ? 'Saving…'
                      : _policy == 'hr-approval'
                          ? 'Send request'
                          : 'Save'),
                ),
                const SizedBox(width: 8),
                TextButton(
                  onPressed: _busy
                      ? null
                      : () => setState(() {
                            _editing = false;
                            _ctl.text = widget.field['value']?.toString() ?? '';
                          }),
                  child: const Text('Cancel'),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
