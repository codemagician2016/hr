// Profile — GET /api/customer/me details + sign out (clears the persisted
// session via AuthContext.signOut, which flips the root navigator back to the
// auth stack).

import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, RefreshControl, StyleSheet } from 'react-native';
import { useAuth } from '../AuthContext';
import * as api from '../lib/api';
import { colors, spacing, radius, tagline } from '../theme';
import { Card, Button, Row, Loading } from '../components/ui';

function initials(name) {
  if (!name) return 'DH';
  return String(name)
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

export default function ProfileScreen() {
  const { customer: ctxCustomer, signOut, refresh } = useAuth();
  const [customer, setCustomer] = useState(ctxCustomer);
  const [loading, setLoading] = useState(!ctxCustomer);
  const [refreshing, setRefreshing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const load = useCallback(async () => {
    try {
      const { customer: me } = await api.fetchMe();
      setCustomer(me);
    } catch {
      // keep whatever we had
    }
  }, []);

  useEffect(() => {
    (async () => {
      await load();
      setLoading(false);
    })();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    await refresh();
    setRefreshing(false);
  }, [load, refresh]);

  async function onSignOut() {
    setSigningOut(true);
    await signOut();
    // Navigator switches automatically; no manual navigation needed.
  }

  if (loading && !customer) return <Loading label="Loading profile…" />;

  const c = customer || {};

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.lg }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      <View style={styles.header}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(c.name)}</Text>
        </View>
        <Text style={styles.name}>{c.name || 'Employee'}</Text>
        <Text style={styles.email}>{c.email || ''}</Text>
      </View>

      <Card>
        <Text style={styles.cardTitle}>Account</Text>
        <Row label="Name" value={c.name || '—'} />
        <Row label="Email" value={c.email || '—'} />
        {c.phone ? <Row label="Phone" value={c.phone} /> : null}
        {c.employeeId || c.employee?.id ? (
          <Row label="Employee ID" value={String(c.employeeId || c.employee?.id)} />
        ) : null}
        {c.businessId ? <Row label="Business" value={String(c.businessId)} /> : null}
        {c.emailVerified != null ? (
          <Row label="Email verified" value={c.emailVerified ? 'Yes' : 'No'} />
        ) : null}
      </Card>

      <Button
        title="Sign out"
        variant="danger"
        onPress={onSignOut}
        loading={signingOut}
        style={{ marginTop: spacing.sm }}
      />

      <View style={styles.footer}>
        <Text style={styles.footerBrand}>DriftHR</Text>
        <Text style={styles.footerTag}>{tagline}</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', marginBottom: spacing.lg },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: radius.pill,
    backgroundColor: colors.teal,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  avatarText: { color: colors.onPrimary, fontSize: 26, fontWeight: '800' },
  name: { fontSize: 20, fontWeight: '800', color: colors.text },
  email: { fontSize: 14, color: colors.muted, marginTop: 2 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  footer: { alignItems: 'center', marginTop: spacing.xl },
  footerBrand: { fontSize: 14, fontWeight: '800', color: colors.ink },
  footerTag: { fontSize: 12, color: colors.muted, marginTop: 2 },
});
