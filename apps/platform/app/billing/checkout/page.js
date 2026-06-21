import PaddleCheckoutLauncherClient from './PaddleCheckoutLauncherClient';

function isSafeRedirect(value) {
  if (!value) return false;
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\');
}

export default function PaddleCheckoutPage({ searchParams }) {
  const transactionId = searchParams?._ptxn || searchParams?.transaction_id || '';
  const redirectParam = searchParams?.redirect || '';
  const redirectUrl = isSafeRedirect(redirectParam) ? redirectParam : '/';
  const cancelParam = searchParams?.cancel || '';
  const cancelUrl = isSafeRedirect(cancelParam) ? cancelParam : '';

  return (
    <PaddleCheckoutLauncherClient
      transactionId={transactionId}
      redirectUrl={redirectUrl}
      cancelUrl={cancelUrl}
    />
  );
}
