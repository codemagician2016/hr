// Shared formatters. Mirrors apps/ess/lib/format.js: money values arrive as a
// plain number, a Decimal-ish string, or an object { amount, currency } /
// { minor, currency }. Bare numbers/strings are MAJOR units; we only divide by
// 100 when a `minor` field is explicitly present.

import 'package:intl/intl.dart';

class Fmt {
  Fmt._();

  static double? _toNum(Object? v) {
    if (v == null) return null;
    if (v is num) return v.toDouble();
    return double.tryParse(v.toString());
  }

  /// Locale-aware currency. Accepts a number, a numeric string, or a map with
  /// `amount`/`value`/`minor` (+ optional `currency`/`currencyCode`).
  static String money(Object? value, {String fallbackCurrency = 'INR'}) {
    if (value == null || (value is String && value.isEmpty)) return '—';

    double? amount;
    var currency = fallbackCurrency;

    if (value is Map) {
      currency = (value['currency'] ?? value['currencyCode'] ?? fallbackCurrency).toString();
      if (value['minor'] != null) {
        final m = _toNum(value['minor']);
        amount = m == null ? null : m / 100.0;
      } else if (value['amount'] != null) {
        amount = _toNum(value['amount']);
      } else if (value['value'] != null) {
        amount = _toNum(value['value']);
      } else {
        return '—';
      }
    } else {
      amount = _toNum(value);
    }

    if (amount == null || amount.isNaN || amount.isInfinite) return '—';

    try {
      final f = NumberFormat.simpleCurrency(name: currency);
      return f.format(amount);
    } catch (_) {
      return '$currency ${amount.toStringAsFixed(2)}';
    }
  }

  /// "23 Jun 2026" style date. Tolerates ISO strings and DateTime.
  static String date(Object? value) {
    final d = _parseDate(value);
    if (d == null) return value?.toString() ?? '';
    return DateFormat('dd MMM yyyy').format(d);
  }

  /// "09:41 AM" style time.
  static String time(Object? value) {
    final d = _parseDate(value);
    if (d == null) return value?.toString() ?? '';
    return DateFormat('hh:mm a').format(d.toLocal());
  }

  static DateTime? _parseDate(Object? value) {
    if (value == null) return null;
    if (value is DateTime) return value;
    final s = value.toString();
    if (s.isEmpty) return null;
    return DateTime.tryParse(s);
  }

  /// Period label for a payslip/pay run from a variety of payload shapes
  /// (mirrors formatPeriod in format.js).
  static String period(Object? p) {
    if (p == null) return '';
    if (p is String) return p;
    if (p is Map) {
      if (p['label'] != null) return p['label'].toString();
      if (p['periodLabel'] != null) return p['periodLabel'].toString();
      if (p['month'] != null && p['year'] != null) return '${p['month']} ${p['year']}';
      if (p['periodStart'] != null && p['periodEnd'] != null) {
        return '${date(p['periodStart'])} – ${date(p['periodEnd'])}';
      }
      if (p['periodStart'] != null) return date(p['periodStart']);
      if (p['id'] != null) return p['id'].toString();
    }
    return '';
  }

  /// Tidy a Decimal-ish quantity to a short number (no trailing zeros).
  static String qty(Object? v) {
    final n = _toNum(v) ?? 0;
    if (n == n.roundToDouble()) return n.toInt().toString();
    return n.toStringAsFixed(2).replaceFirst(RegExp(r'\.?0+$'), '');
  }

  static double numOr0(Object? v) => _toNum(v) ?? 0;

  /// "YYYY-MM-DD" civil-day key for a DateTime (local).
  static String dayKey(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
}

/// Resolve the logged-in employee id from the rich profile / customer shapes.
/// IMPORTANT (audit #55): the customer/session id is NOT the employee id — we
/// only read a genuine employee anchor and never fall back to me.customer.id.
String? employeeIdOf(Map<String, dynamic>? me) {
  if (me == null) return null;
  final employee = me['employee'];
  if (employee is Map && employee['id'] != null) return employee['id'].toString();
  if (me['employeeId'] != null) return me['employeeId'].toString();
  final profile = me['profile'];
  if (profile is Map && profile['employeeId'] != null) {
    return profile['employeeId'].toString();
  }
  final customer = me['customer'];
  if (customer is Map && customer['employeeId'] != null) {
    return customer['employeeId'].toString();
  }
  return null;
}
