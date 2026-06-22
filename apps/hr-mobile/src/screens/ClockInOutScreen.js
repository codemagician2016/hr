// Clock in / out — POST /api/hr/attendance/punch and lists today's punches via
// GET /api/hr/attendance/punches?from=<today>. The button toggles between
// clock-in and clock-out based on the last punch direction.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, StyleSheet } from 'react-native';
import { useAuth } from '../AuthContext';
import * as api from '../lib/api';
import { colors, spacing, radius } from '../theme';
import { Card, Button, Banner, Loading } from '../components/ui';
import { formatTime, todayISO } from '../lib/format';

function normalizePunches(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.punches || payload?.data || payload?.items || [];
}

function punchDir(p) {
  return String(p?.type || p?.direction || p?.kind || '').toUpperCase();
}

export default function ClockInOutScreen() {
  const { customer } = useAuth();
  const employeeId = customer?.employeeId || customer?.employee?.id || null;

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [punches, setPunches] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const load = useCallback(async () => {
    try {
      const today = todayISO();
      const qs = new URLSearchParams({ from: today, to: today });
      if (employeeId) qs.set('employeeId', String(employeeId));
      const res = await api.fetchPunches(qs.toString());
      setPunches(normalizePunches(res));
      setError(null);
    } catch (err) {
      // A non-employee customer or restricted endpoint shouldn't break the screen.
      setError(err?.message || 'Could not load today\'s punches.');
    }
  }, [employeeId]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const lastDir = useMemo(() => {
    if (!punches.length) return null;
    // Assume the API returns newest-first; fall back to last element otherwise.
    const sorted = [...punches].sort(
      (a, b) => new Date(a.time || a.at || a.createdAt) - new Date(b.time || b.at || b.createdAt)
    );
    return punchDir(sorted[sorted.length - 1]);
  }, [punches]);

  const nextType = lastDir === 'IN' ? 'OUT' : 'IN';

  async function onPunch() {
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const payload = { type: nextType, at: new Date().toISOString() };
      if (employeeId) payload.employeeId = employeeId;
      await api.punch(payload);
      setSuccess(nextType === 'IN' ? 'Clocked in.' : 'Clocked out.');
      await load();
    } catch (err) {
      setError(err?.message || 'Could not record your punch.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <Loading label="Loading attendance…" />;

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.lg }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      <Card style={styles.clockCard}>
        <Text style={styles.status}>
          {lastDir === 'IN' ? 'You are clocked in' : 'You are clocked out'}
        </Text>
        <Text style={styles.clockBig}>{formatTime(new Date().toISOString())}</Text>
        <Banner message={error} />
        <Banner message={success} tone="success" />
        <Button
          title={nextType === 'IN' ? 'Clock in' : 'Clock out'}
          variant={nextType === 'IN' ? 'primary' : 'danger'}
          onPress={onPunch}
          loading={submitting}
          style={{ marginTop: spacing.md }}
        />
      </Card>

      <Card>
        <Text style={styles.cardTitle}>Today's punches</Text>
        {punches.length ? (
          punches
            .slice()
            .sort((a, b) => new Date(a.time || a.at || a.createdAt) - new Date(b.time || b.at || b.createdAt))
            .map((p, i) => (
              <View key={p.id || i} style={styles.punchRow}>
                <Text style={styles.punchType}>{punchDir(p) === 'OUT' ? 'Clock out' : 'Clock in'}</Text>
                <Text style={styles.punchTime}>
                  {formatTime(p.time || p.at || p.createdAt)}
                </Text>
              </View>
            ))
        ) : (
          <Text style={styles.muted}>No punches recorded today.</Text>
        )}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  clockCard: { alignItems: 'center', backgroundColor: colors.ink, borderColor: colors.ink },
  status: { color: '#9FB3C8', fontSize: 14, fontWeight: '600' },
  clockBig: { color: '#FFFFFF', fontSize: 40, fontWeight: '800', marginVertical: spacing.sm },
  cardTitle: { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  muted: { color: colors.muted, fontSize: 13 },
  punchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  punchType: { fontSize: 14, fontWeight: '600', color: colors.text },
  punchTime: { fontSize: 14, color: colors.teal, fontWeight: '700' },
});
