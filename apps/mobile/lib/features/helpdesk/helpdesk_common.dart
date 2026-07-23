// Shared Helpdesk atoms: a status pill mapped to the ticket lifecycle colours and a
// priority chip. The status set mirrors the backend helpdesk.service TICKET_STATUSES
// (OPEN · IN_PROGRESS · WAITING_ON_EMPLOYEE · RESOLVED · CLOSED · REOPENED · CANCELLED).

import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

String prettyStatus(String status) => status
    .split('_')
    .where((s) => s.isNotEmpty)
    .map((s) => s[0].toUpperCase() + s.substring(1).toLowerCase())
    .join(' ');

/// A status pill coloured for the helpdesk lifecycle.
StatusPill helpdeskStatusPill(String status) {
  final s = status.toUpperCase();
  Color fg;
  Color bg;
  switch (s) {
    case 'RESOLVED':
      fg = const Color(0xFF047857);
      bg = const Color(0xFFECFDF5);
      break;
    case 'IN_PROGRESS':
    case 'WAITING_ON_EMPLOYEE':
      fg = const Color(0xFFB45309);
      bg = const Color(0xFFFFFBEB);
      break;
    case 'OPEN':
    case 'REOPENED':
      fg = const Color(0xFF1D4ED8);
      bg = const Color(0xFFEFF6FF);
      break;
    case 'CANCELLED':
      fg = const Color(0xFFB91C1C);
      bg = const Color(0xFFFEF2F2);
      break;
    default: // CLOSED / unknown
      fg = BrandColors.muted;
      bg = const Color(0xFFF1F5F9);
  }
  return StatusPill(label: prettyStatus(status.isEmpty ? '—' : status), fg: fg, bg: bg);
}

/// A small chip for the ticket priority (LOW · NORMAL · HIGH · URGENT).
class PriorityChip extends StatelessWidget {
  const PriorityChip({super.key, required this.priority});

  final String priority;

  @override
  Widget build(BuildContext context) {
    final p = priority.toUpperCase();
    Color c;
    switch (p) {
      case 'URGENT':
        c = BrandColors.danger;
        break;
      case 'HIGH':
        c = BrandColors.warning;
        break;
      case 'LOW':
        c = BrandColors.muted;
        break;
      default: // NORMAL
        c = BrandColors.tealDark;
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: c.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(BrandRadii.pill),
        border: Border.all(color: c.withValues(alpha: 0.35)),
      ),
      child: Text(
        prettyStatus(p.isEmpty ? 'NORMAL' : p),
        style: TextStyle(color: c, fontWeight: FontWeight.w700, fontSize: 11),
      ),
    );
  }
}
