// Auth/session context. Hydrates the persisted session at startup, exposes the
// current customer, and wires login/logout. Screens read `customer` for the
// greeting, employeeId (leave balances), etc.

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import * as api from './lib/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [booting, setBooting] = useState(true);
  const [customer, setCustomer] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const { customer: me } = await api.fetchMe();
      setCustomer(me || null);
      return me || null;
    } catch {
      setCustomer(null);
      return null;
    }
  }, []);

  useEffect(() => {
    (async () => {
      await api.loadSession();
      if (api.hasSession()) {
        await refresh();
      }
      setBooting(false);
    })();
  }, [refresh]);

  const signIn = useCallback(async (email, password) => {
    await api.login(email, password);
    const me = await refresh();
    return me;
  }, [refresh]);

  const signOut = useCallback(async () => {
    await api.logout();
    setCustomer(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ booting, customer, isAuthed: Boolean(customer), signIn, signOut, refresh }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
