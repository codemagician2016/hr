'use client';

import { createContext, useContext, useMemo } from 'react';

const EcomAccessContext = createContext({
  permissions: null,
  isOwner: true,
});

export function EcomAccessProvider({ access, children }) {
  const value = useMemo(() => ({
    permissions: Array.isArray(access?.permissions) ? access.permissions : [],
    isOwner: !!access?.isOwner,
    role: access?.role || null,
  }), [access]);

  return (
    <EcomAccessContext.Provider value={value}>
      {children}
    </EcomAccessContext.Provider>
  );
}

export function useEcomAccess() {
  const access = useContext(EcomAccessContext);
  const permissionSet = useMemo(
    () => new Set(access.permissions || []),
    [access.permissions],
  );

  return {
    ...access,
    has(permission) {
      return access.isOwner || permissionSet.has(permission);
    },
    hasAny(permissions = []) {
      return access.isOwner || permissions.some((permission) => permissionSet.has(permission));
    },
  };
}
