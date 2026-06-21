'use client';

// Extracted from [slug]/admin/page.js 2026-04-29 as part of the admin
// page split.

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/adminApi';
import { Spinner, ErrorBanner, PrimaryButton, Modal, ModalActions, TextInput, TextArea, Empty, formatAdminDate, formatAdminDateTime, formatMoneyMinor } from '@/components/admin-ui';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import EmailDeliveryHistoryPanel from '@/components/EmailDeliveryHistoryPanel';

function EmailUpdatesTab() {
  return (
    <EmailDeliveryHistoryPanel
      endpoint="/api/business/email-deliveries"
      title="Email updates"
      description="Track OTPs, invites, booking emails, and appointment status changes for this business."
      emptyMessage="This business has not sent any tracked emails yet."
    />
  );
}

// Customers tab — merges what used to be the "Emails" tab with a proper
// customer list. Two sub-tabs: "People" (the list) and "Emails"
// (existing delivery history). A3.2 in the admin-shell polish sprint.

export default EmailUpdatesTab;
