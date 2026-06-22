// Payslip detail — GET /api/hr/me/payslips/:id. Renders earnings, deductions
// and the net pay. The summary passed via navigation params is shown
// immediately as a placeholder while the full record loads.

import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import * as api from '../lib/api';
import { colors, spacing } from '../theme';
import { Card, Loading, Banner, Row } from '../components/ui';
import { money, formatDate, formatPeriod } from '../lib/format';

function lines(payslip, keys) {
  for (const k of keys) {
    if (Array.isArray(payslip?.[k])) return payslip[k];
  }
  return [];
}

export default function PayslipDetailScreen({ route }) {
  const { id, summary } = route.params || {};
  const [payslip, setPayslip] = useState(summary || null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.fetchPayslip(id);
        setPayslip(res?.payslip || res?.data || res);
        setError(null);
      } catch (err) {
        setError(err?.message || 'Could not load this payslip.');
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  if (loading && !payslip) return <Loading label="Loading payslip…" />;

  const p = payslip || {};
  const earnings = lines(p, ['earnings', 'earningLines', 'incomes']);
  const deductions = lines(p, ['deductions', 'deductionLines']);
  const net = p.netPay ?? p.net ?? p.netAmount;
  const gross = p.grossPay ?? p.gross ?? p.grossAmount;

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.lg }}>
      {error ? <Banner message={error} /> : null}

      <Card style={styles.headCard}>
        <Text style={styles.period}>{formatPeriod(p.period || p) || 'Payslip'}</Text>
        {p.payDate ? <Text style={styles.headSub}>Paid {formatDate(p.payDate)}</Text> : null}
        <Text style={styles.netLabel}>Net pay</Text>
        <Text style={styles.netValue}>{money(net)}</Text>
      </Card>

      <Card>
        <Text style={styles.section}>Earnings</Text>
        {earnings.length ? (
          earnings.map((l, i) => (
            <Row key={l.id || l.code || i} label={l.label || l.name || l.code || 'Earning'} value={money(l.amount ?? l.value)} />
          ))
        ) : (
          <Text style={styles.muted}>No earning lines.</Text>
        )}
        {gross != null ? <Row label="Gross" value={money(gross)} strong /> : null}
      </Card>

      <Card>
        <Text style={styles.section}>Deductions</Text>
        {deductions.length ? (
          deductions.map((l, i) => (
            <Row key={l.id || l.code || i} label={l.label || l.name || l.code || 'Deduction'} value={money(l.amount ?? l.value)} />
          ))
        ) : (
          <Text style={styles.muted}>No deduction lines.</Text>
        )}
      </Card>

      <Card style={styles.netCard}>
        <Row label="Net pay" value={money(net)} strong />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  headCard: { backgroundColor: colors.ink, borderColor: colors.ink },
  period: { color: '#FFFFFF', fontSize: 18, fontWeight: '800' },
  headSub: { color: '#9FB3C8', fontSize: 13, marginTop: 2 },
  netLabel: { color: '#9FB3C8', fontSize: 13, marginTop: spacing.lg },
  netValue: { color: colors.teal, fontSize: 30, fontWeight: '800' },
  section: { fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  muted: { color: colors.muted, fontSize: 13 },
  netCard: { backgroundColor: colors.tealSoft, borderColor: colors.tealSoft },
});
