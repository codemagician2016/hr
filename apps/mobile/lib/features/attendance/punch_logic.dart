// Pure helpers that mirror the ESS web's punch math: build IN→OUT pairs, sum
// worked time, and derive the current clock state. Kept dependency-free so both
// the Attendance screen and the Home dashboard can reuse them.

class PunchPair {
  const PunchPair(this.inAt, this.outAt);
  final DateTime? inAt;
  final DateTime? outAt;
}

DateTime? _at(Map<String, dynamic> p) => DateTime.tryParse((p['punchAt'] ?? '').toString());

/// Ascending IN→OUT pairs for a day's punches. BREAK_* punches don't open/close
/// a worked pair (matches pairsForDay in the web app).
List<PunchPair> pairsForDay(List<Map<String, dynamic>> punches) {
  final sorted = [...punches]..sort((a, b) {
      final ax = _at(a)?.millisecondsSinceEpoch ?? 0;
      final bx = _at(b)?.millisecondsSinceEpoch ?? 0;
      return ax.compareTo(bx);
    });
  final pairs = <PunchPair>[];
  DateTime? openIn;
  for (final p in sorted) {
    final type = (p['punchType'] ?? '').toString();
    final at = _at(p);
    if (type == 'IN') {
      if (openIn != null) pairs.add(PunchPair(openIn, null));
      openIn = at;
    } else if (type == 'OUT') {
      pairs.add(PunchPair(openIn, at));
      openIn = null;
    }
  }
  if (openIn != null) pairs.add(PunchPair(openIn, null));
  return pairs;
}

Duration workedFromPairs(List<PunchPair> pairs) {
  var ms = 0;
  for (final p in pairs) {
    if (p.inAt != null && p.outAt != null) {
      ms += p.outAt!.difference(p.inAt!).inMilliseconds;
    }
  }
  return Duration(milliseconds: ms < 0 ? 0 : ms);
}

String fmtWorked(Duration d) {
  final h = d.inMinutes ~/ 60;
  final m = d.inMinutes % 60;
  return '${h}h ${m.toString().padLeft(2, '0')}m';
}

/// The last meaningful punch type for "today" (descending), used to decide which
/// clock buttons are enabled.
String? lastPunchTypeToday(List<Map<String, dynamic>> all) {
  final now = DateTime.now();
  final startOfToday = DateTime(now.year, now.month, now.day);
  final today = all.where((p) {
    final at = _at(p);
    return at != null && !at.isBefore(startOfToday);
  }).toList()
    ..sort((a, b) => (_at(b)?.millisecondsSinceEpoch ?? 0).compareTo(_at(a)?.millisecondsSinceEpoch ?? 0));
  return today.isEmpty ? null : (today.first['punchType'] ?? '').toString();
}

bool isClockedIn(List<Map<String, dynamic>> all) {
  final t = lastPunchTypeToday(all);
  return t == 'IN' || t == 'BREAK_END';
}

List<Map<String, dynamic>> todaysPunches(List<Map<String, dynamic>> all) {
  final now = DateTime.now();
  final startOfToday = DateTime(now.year, now.month, now.day);
  final today = all.where((p) {
    final at = _at(p);
    return at != null && !at.isBefore(startOfToday);
  }).toList()
    ..sort((a, b) => (_at(b)?.millisecondsSinceEpoch ?? 0).compareTo(_at(a)?.millisecondsSinceEpoch ?? 0));
  return today;
}

const punchLabels = {
  'IN': 'Clocked in',
  'OUT': 'Clocked out',
  'BREAK_START': 'Break started',
  'BREAK_END': 'Break ended',
};
