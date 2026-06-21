export function buildLoginRedirectUrl() {
  if (typeof window === 'undefined') return '/login';

  const currentPath = `${window.location.pathname || ''}${window.location.search || ''}`;
  if (!currentPath || currentPath === '/login') return '/login';

  return `/login?redirect=${encodeURIComponent(currentPath)}`;
}

export function redirectToLogin() {
  if (typeof window === 'undefined') return;
  window.location.href = buildLoginRedirectUrl();
}
