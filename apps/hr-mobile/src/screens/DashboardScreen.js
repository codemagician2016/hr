// Dashboard — greeting, next payday, and leave balance summary. Data is best
// effort: each panel degrades gracefully if its endpoint isn't available for
// the tenant. Pull-to-refresh re-fetches everything.

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, StyleSheet } from 'react-native';
import { useAuth } from '../AuthContext';
import * as api from '../lib/api';
import { colors, spacing, radius } from '../theme';
import { Card, Pill, Loading, Row } from '../components/ui';
import { greeting, formatDate, formatPeriod, money } from '../lib/format';

function firstName(name) {
  if (!name) return 'there';
  return String(name).trim().split(/\s+/)[0];
}

// Pull the next payday off whatever shape the payslip/me payload offers.
function deriveNextPayday(me, payslips) {
  if (me?.nextPayday) return me.nextPayday;
  if (me?.nextPayDate) return me.nextPayDate;
  const upcoming = (payslips || []).find((p) => p?.payDate && new Date(p.payDate) >= new Date());
  return upcoming?.payDate || null;
}

function totalLeaveBalance(balances) {
  if (!Array.isArray(balances)) return null;
  return balances.reduce((sum, b) => {
    const v = b?.balance ?? b?.available ?? b?.remaining ?? 0;
    return sum + (Number(v) || 0);
  }, 0);
}

export default function DashboardScreen() {
  const { customer } = useAuth();
  const employeeId = customer?.employeeId || customer?.employee?.id || null;

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [payslips, setPayslips] = useState([]);
  const [balances, setBalances] = useState(null);

  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      api.fetchPayslips(),
      employeeId ? api.fetchLeaveBalances(employeeId) : Promise.resolve(null),
    ]);
    const [slipsRes, balRes] = results;
    if (slipsRes.status === 'fulfilled') {
      const v = slipsRes.value;
      setPayslips(Array.isArray(v) ? v : v?.payslips || v?.data || []);
    }
    if (balRes.status === 'fulfilled' && balRes.value) {
      const v = balRes.value;
      setBalances(Array.isArray(v) ? v : v?.balances || v?.data || []);
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

  if (loading) return <Loading label="Loading your dashboard…" />;

  const nextPayday = deriveNextPayday(customer, payslips);
  const balanceTotal = totalLeaveBalance(balances);
  const latest = payslips[0];

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.lg }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      <View style={styles.hero}>
        <Text style={styles.greeting}>
          {greeting()}, {firstName(customer?.name)}
        </Text>
        <Text style={styles.sub}>Here's your snapshot for today.</Text>
      </View>

      <Card style={styles.payCard}>
        <Text style={styles.payLabel}>Next payday</Text>
        <Text style={styles.payValue}>
          {nextPayday ? formatDate(nextPayday) : 'Not scheduled yet'}
        </Text>
        {latest ? (
          <View style={{ marginTop: spacing.sm }}>
            <Pill label={`Latest: ${formatPeriod(latest.period || latest) || 'payslip'}`} tone="teal" />
          </View>
        ) : null}
      </Card>

      <Card>
        <Text style={styles.cardTitle}>Leave balance</Text>
        {balanceTotal != null ? (
          <>
            <Text style={styles.bigNumber}>{balanceTotal}</Text>
            <Text style={styles.muted}>days available across all types</Text>
            {Array.isArray(balances) &&
              balances.slice(0, 4).map((b, i) => (
                <Row
                  key={b.id || b.leaveTypeId || i}
                  label={b.leaveType?.name || b.name || b.type || 'Leave'}
                  value={`${b.balance ?? b.available ?? b.remaining ?? 0} d`}
                />
              ))}
          </>
        ) : (
          <Text style={styles.muted}>
            Leave balance will appear once your employee profile is linked.
          </Text>
        )}
      </Card>

      {latest ? (
        <Card>
          <Text style={styles.cardTitle}>Latest payslip</Text>
          <Row label="Period" value={formatPeriod(latest.period || latest) || '—'} />
          <Row label="Net pay" value={money(latest.netPay ?? latest.net ?? latest.netAmount)} strong />
        </Card>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  hero: { marginBottom: spacing.lg },
  greeting: { fontSize: 24, fontWeight: '800', color: colors.text },
  sub: { color: colors.muted, marginTop: spacing.xs, fontSize: 14 },
  payCard: { backgroundColor: colors.ink, borderColor: colors.ink },
  payLabel: { color: '#9FB3C8', fontSize: 13, fontWeight: '600' },
  payValue: { color: '#FFFFFF', fontSize: 24, fontWeight: '800', marginTop: spacing.xs },
  cardTitle: { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  bigNumber: { fontSize: 36, fontWeight: '800', color: colors.teal },
  muted: { color: colors.muted, fontSize: 13 },
});
