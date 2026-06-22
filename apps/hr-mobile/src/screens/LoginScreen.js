// Login — POST /api/customer/login via AuthContext.signIn. DriftHR-branded on
// the ink (#16243B) background with the teal accent. On success the root
// navigator swaps to the tab navigator automatically (isAuthed flips).

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useAuth } from '../AuthContext';
import { colors, spacing, radius, tagline } from '../theme';
import { Button, Banner, inputStyle } from '../components/ui';

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function onSubmit() {
    if (!email || !password) {
      setError('Enter your email and password.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      // Navigation switches automatically on auth.
    } catch (err) {
      setError(err?.message || 'Login failed. Check your email and password.');
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brand}>
          <View style={styles.logoMark}>
            <Text style={styles.logoMarkText}>D</Text>
          </View>
          <Text style={styles.brandName}>DriftHR</Text>
          <Text style={styles.tagline}>{tagline}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Sign in to your account</Text>
          <Banner message={error} />

          <Text style={styles.label}>Email</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@company.com"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            style={[inputStyle, styles.input]}
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={colors.muted}
            secureTextEntry
            style={[inputStyle, styles.input]}
            onSubmitEditing={onSubmit}
          />

          <Button
            title="Sign in"
            onPress={onSubmit}
            loading={submitting}
            style={{ marginTop: spacing.sm }}
          />
        </View>

        <Text style={styles.footer}>Effortless HR & payroll, in your pocket.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.ink },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  brand: { alignItems: 'center', marginBottom: spacing.xl },
  logoMark: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: colors.teal,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  logoMarkText: { color: colors.onPrimary, fontSize: 30, fontWeight: '800' },
  brandName: { color: '#FFFFFF', fontSize: 28, fontWeight: '800' },
  tagline: { color: '#9FB3C8', fontSize: 14, marginTop: spacing.xs },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    padding: spacing.xl,
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.md,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
    marginBottom: spacing.xs,
    marginTop: spacing.sm,
  },
  input: { marginBottom: spacing.xs },
  footer: {
    textAlign: 'center',
    color: '#9FB3C8',
    fontSize: 12,
    marginTop: spacing.xl,
  },
});
