// Small set of DriftHR-branded, mobile-native UI primitives. No web/Tailwind —
// pure React Native StyleSheet using the brand palette in ../theme.

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { colors, radius, spacing } from '../theme';

export function Card({ style, children }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({ title, onPress, loading, disabled, variant = 'primary', style }) {
  const isPrimary = variant === 'primary';
  const isDanger = variant === 'danger';
  const bg = isDanger ? colors.dangerSoft : isPrimary ? colors.primary : colors.card;
  const fg = isDanger ? colors.danger : isPrimary ? colors.onPrimary : colors.text;
  const isDisabled = disabled || loading;
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      disabled={isDisabled}
      style={[
        styles.button,
        { backgroundColor: bg, opacity: isDisabled ? 0.6 : 1 },
        !isPrimary && !isDanger && styles.buttonOutline,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>
      )}
    </TouchableOpacity>
  );
}

export function Pill({ label, tone = 'teal' }) {
  const map = {
    teal: [colors.tealSoft, colors.tealDark],
    success: [colors.successSoft, colors.success],
    warning: [colors.warningSoft, colors.warning],
    danger: [colors.dangerSoft, colors.danger],
    muted: [colors.bg, colors.muted],
  };
  const [bg, fg] = map[tone] || map.teal;
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[styles.pillText, { color: fg }]}>{label}</Text>
    </View>
  );
}

export function Field({ label, children }) {
  return (
    <View style={styles.field}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      {children}
    </View>
  );
}

export function Banner({ message, tone = 'danger' }) {
  if (!message) return null;
  const map = {
    danger: [colors.dangerSoft, colors.danger],
    success: [colors.successSoft, colors.success],
    info: [colors.tealSoft, colors.tealDark],
  };
  const [bg, fg] = map[tone] || map.danger;
  return (
    <View style={[styles.banner, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontSize: 13, fontWeight: '600' }}>{message}</Text>
    </View>
  );
}

export function Loading({ label }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.primary} size="large" />
      {label ? <Text style={styles.loadingText}>{label}</Text> : null}
    </View>
  );
}

export function Empty({ title, subtitle }) {
  return (
    <View style={styles.center}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle ? <Text style={styles.emptySub}>{subtitle}</Text> : null}
    </View>
  );
}

export function Row({ label, value, strong }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, strong && { fontWeight: '700', color: colors.text }]}>
        {label}
      </Text>
      <Text style={[styles.rowValue, strong && { fontWeight: '800', color: colors.text }]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  button: {
    minHeight: 50,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  buttonOutline: {
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonText: { fontSize: 16, fontWeight: '700' },
  pill: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  pillText: { fontSize: 12, fontWeight: '700' },
  field: { marginBottom: spacing.md },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
    marginBottom: spacing.xs,
  },
  banner: {
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  loadingText: { marginTop: spacing.md, color: colors.muted },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  emptySub: { marginTop: spacing.xs, color: colors.muted, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  rowLabel: { fontSize: 14, color: colors.muted },
  rowValue: { fontSize: 14, color: colors.text, fontWeight: '600' },
});

export const inputStyle = {
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: radius.md,
  paddingHorizontal: spacing.md,
  paddingVertical: 12,
  fontSize: 15,
  color: colors.text,
  backgroundColor: colors.card,
};
