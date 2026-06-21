import { redirect } from 'next/navigation';

export default function RiderMobileShortcutPage({ params, searchParams }) {
  const qs = new URLSearchParams(searchParams || {});
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  redirect(`/${params.slug}/staff/delivery${suffix}`);
}
