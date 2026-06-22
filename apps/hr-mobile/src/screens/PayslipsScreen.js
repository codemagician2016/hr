// Payslips list — GET /api/hr/me/payslips. Tapping a row pushes the detail
// screen (PayslipDetail) within the Payslips stack.

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native';
import * as api from '../lib/api';
import { colors, spacing, radius } from '../theme';
import { Loading, Empty, Banner, Pill } from '../components/ui';
import { money, formatDate, formatPeriod } from '../lib/format';

function normalize(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.payslips || payload?.data || payload?.items || [];
}

export default function PayslipsScreen({ navigation }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [items, setItems] = useState([]);

  const load = useCallback(async () => {
    try {
      const res = await api.fetchPayslips();
      setItems(normalize(res));
      setError(null);
    } catch (err) {
      setError(err?.message || 'Could not load payslips.');
    }
  }, []);

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

  if (loading) return <Loading label="Loading payslips…" />;

  return (
    <View style={styles.container}>
      {error ? <View style={{ padding: spacing.lg }}><Banner message={error} /></View> : null}
      <FlatList
        data={items}
        keyExtractor={(it, i) => String(it.id ?? i)}
        contentContainerStyle={items.length ? { padding: spacing.lg } : styles.emptyWrap}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        ListEmptyComponent={
          <Empty title="No payslips yet" subtitle="Your payslips will appear here once payroll is processed." />
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            activeOpacity={0.8}
            style={styles.row}
            onPress={() => navigation.navigate('PayslipDetail', { id: item.id, summary: item })}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.period}>{formatPeriod(item.period || item) || 'Payslip'}</Text>
              <Text style={styles.date}>
                {item.payDate ? `Paid ${formatDate(item.payDate)}` : item.status || ''}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.net}>{money(item.netPay ?? item.net ?? item.netAmount)}</Text>
              {item.status ? <Pill label={item.status} tone="muted" /> : null}
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  emptyWrap: { flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  period: { fontSize: 16, fontWeight: '700', color: colors.text },
  date: { fontSize: 13, color: colors.muted, marginTop: 2 },
  net: { fontSize: 16, fontWeight: '800', color: colors.teal, marginBottom: 4 },
});
