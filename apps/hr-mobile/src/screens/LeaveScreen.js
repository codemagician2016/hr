// Leave — shows leave balance + recent requests, and an apply form that POSTs
// to /api/hr/leave/requests. Dates are entered as YYYY-MM-DD to avoid pulling
// in a date-picker dependency for this scaffold.

import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  RefreshControl,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useAuth } from '../AuthContext';
import * as api from '../lib/api';
import { colors, spacing } from '../theme';
import { Card, Button, Banner, Field, Row, Pill, inputStyle } from '../components/ui';
import { formatDate, todayISO } from '../lib/format';

function normalizeRequests(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.requests || payload?.data || payload?.items || [];
}
function normalizeBalances(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.balances || payload?.data || [];
}

function statusTone(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('approve')) return 'success';
  if (s.includes('reject') || s.includes('cancel')) return 'danger';
  return 'warning';
}

export default function LeaveScreen() {
  const { customer } = useAuth();
  const employeeId = customer?.employeeId || customer?.employee?.id || null;

  const [refreshing, setRefreshing] = useState(false);
  const [requests, setRequests] = useState([]);
  const [balances, setBalances] = useState([]);

  // Apply form state.
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [startDate, setStartDate] = useState(todayISO());
  const [endDate, setEndDate] = useState(todayISO());
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const load = useCallback(async () => {
    const [reqRes, balRes] = await Promise.allSettled([
      api.fetchLeaveRequests(),
      employeeId ? api.fetchLeaveBalances(employeeId) : Promise.resolve(null),
    ]);
    if (reqRes.status === 'fulfilled') setRequests(normalizeRequests(reqRes.value));
    if (balRes.status === 'fulfilled' && balRes.value) setBalances(normalizeBalances(balRes.value));
  }, [employeeId]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  async function onApply() {
    setError(null);
    setSuccess(null);
    if (!startDate || !endDate) {
      setError('Choose a start and end date.');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        startDate,
        endDate,
        reason: reason || undefined,
      };
      if (leaveTypeId) payload.leaveTypeId = leaveTypeId;
      if (employeeId) payload.employeeId = employeeId;
      await api.applyLeave(payload);
      setSuccess('Leave request submitted.');
      setReason('');
      await load();
    } catch (err) {
      setError(err?.message || 'Could not submit your leave request.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={{ backgroundColor: colors.bg }}
        contentContainerStyle={{ padding: spacing.lg }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        <Card>
          <Text style={styles.cardTitle}>Balance</Text>
          {balances.length ? (
            balances.map((b, i) => (
              <Row
                key={b.id || b.leaveTypeId || i}
                label={b.leaveType?.name || b.name || b.type || 'Leave'}
                value={`${b.balance ?? b.available ?? b.remaining ?? 0} days`}
              />
            ))
          ) : (
            <Text style={styles.muted}>Balance unavailable for your profile.</Text>
          )}
        </Card>

        <Card>
          <Text style={styles.cardTitle}>Apply for leave</Text>
          <Banner message={error} />
          <Banner message={success} tone="success" />

          <Field label="Leave type ID (optional)">
            <TextInput
              value={leaveTypeId}
              onChangeText={setLeaveTypeId}
              placeholder="e.g. annual"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              style={inputStyle}
            />
          </Field>
          <Field label="Start date (YYYY-MM-DD)">
            <TextInput
              value={startDate}
              onChangeText={setStartDate}
              placeholder="2026-06-22"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              style={inputStyle}
            />
          </Field>
          <Field label="End date (YYYY-MM-DD)">
            <TextInput
              value={endDate}
              onChangeText={setEndDate}
              placeholder="2026-06-23"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              style={inputStyle}
            />
          </Field>
          <Field label="Reason (optional)">
            <TextInput
              value={reason}
              onChangeText={setReason}
              placeholder="Reason for leave"
              placeholderTextColor={colors.muted}
              multiline
              style={[inputStyle, { minHeight: 72, textAlignVertical: 'top' }]}
            />
          </Field>

          <Button title="Submit request" onPress={onApply} loading={submitting} />
        </Card>

        <Card>
          <Text style={styles.cardTitle}>Recent requests</Text>
          {requests.length ? (
            requests.slice(0, 10).map((r, i) => (
              <View key={r.id || i} style={styles.reqRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.reqDates}>
                    {formatDate(r.startDate)} – {formatDate(r.endDate)}
                  </Text>
                  <Text style={styles.muted}>
                    {r.leaveType?.name || r.type || 'Leave'}
                    {r.days ? ` · ${r.days}d` : ''}
                  </Text>
                </View>
                <Pill label={r.status || 'pending'} tone={statusTone(r.status)} />
              </View>
            ))
          ) : (
            <Text style={styles.muted}>No leave requests yet.</Text>
          )}
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  cardTitle: { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  muted: { color: colors.muted, fontSize: 13 },
  reqRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  reqDates: { fontSize: 14, fontWeight: '600', color: colors.text },
});
