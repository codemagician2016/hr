'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import axios from 'axios';
import { redirectToLogin } from '@/lib/loginRedirect';
import { useConfirm } from '@/components/ConfirmDialog';
import { useTenant } from '@/components/TenantProvider';
import WeekCalendar from './WeekCalendar';


const STATUS_STYLES = {
  PENDING:   'bg-amber-100 text-amber-700 border-amber-200',
  CONFIRMED: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  CANCELLED: 'bg-gray-100 text-gray-500 border-gray-200',
  COMPLETED: 'bg-blue-100 text-blue-700 border-blue-200',
  NO_SHOW:   'bg-rose-100 text-rose-700 border-rose-200',
};

const STATUS_LABEL = {
  PENDING:   'Pending',
  CONFIRMED: 'Confirmed',
  COMPLETED: 'Completed',
  NO_SHOW:   'No-show',
  CANCELLED: 'Cancelled',
};

// Active statuses = not cancelled/completed/no-show. These flow through
// the Today / This Week / Later sections. Everything else falls to Past.
const ACTIVE_STATUSES = new Set(['PENDING', 'CONFIRMED']);
const FILTER_STATUS_KEYS = new Set(Object.keys(STATUS_LABEL));

function normalizeThemeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isDoctorClinicTenant(tenant) {
  const themeKey = normalizeThemeKey(tenant?.subscription?.theme || tenant?.business?.theme);
  return themeKey === 'doctor_clinic';
}

/**
 * Shared appointments list for all three dashboards.
 *
 * @param {'BUSINESS_ADMIN' | 'SUPER_ADMIN' | 'STAFF' | 'USER'} role
 */
export default function AppointmentsPanel({ role, me }) {
  const { tenant } = useTenant();
  const router = useRouter();
  const searchParams = useSearchParams();
  const effectiveRole = role || me?.role;
  const permissions = me?.businessRole?.permissions || {};
  const isOwnerLike = effectiveRole === 'BUSINESS_ADMIN' || effectiveRole === 'SUPER_ADMIN';
  const isAdminOrStaff = isOwnerLike || effectiveRole === 'STAFF';
  const canViewAllStaff = isOwnerLike || !!permissions.canViewAllAppointments || !!permissions.canManageAllAppointments;
  const canManageAllAppointments = isOwnerLike || !!permissions.canManageAllAppointments;
  const canManageOwnAppointments = isOwnerLike || !!permissions.canManageOwnAppointments;
  const canCancelAny = isOwnerLike || !!permissions.canCancelAppointments || canManageAllAppointments;
  const canExportAppointments = isOwnerLike;
  const canWriteClinicalDocuments = isOwnerLike || !!permissions.canWriteClinicalDocuments;
  const canBulkAppointments = isOwnerLike;
  const canManageAppointment = useCallback((appt) => {
    if (!appt) return false;
    if (canManageAllAppointments) return true;
    return effectiveRole === 'STAFF' && canManageOwnAppointments && appt.staff?.id === me?.id;
  }, [canManageAllAppointments, canManageOwnAppointments, effectiveRole, me?.id]);
  const canCancelAppointment = useCallback((appt) => {
    if (!appt) return false;
    if (canManageAppointment(appt)) return true;
    return canCancelAny && (canViewAllStaff || appt.staff?.id === me?.id);
  }, [canCancelAny, canManageAppointment, canViewAllStaff, me?.id]);
  const canWritePrescriptionFor = useCallback((appt) => (
    canWriteClinicalDocuments && (isOwnerLike || appt?.staff?.id === me?.id)
  ), [canWriteClinicalDocuments, isOwnerLike, me?.id]);
  const queryView = searchParams.get('view');
  const view = isAdminOrStaff && queryView === 'calendar' ? 'calendar' : 'list';
  const statusFilter = useMemo(() => {
    const raw = searchParams.get('status') || '';
    const values = raw.split(',').map((s) => s.trim().toUpperCase()).filter((s) => FILTER_STATUS_KEYS.has(s));
    return new Set(values);
  }, [searchParams]);
  const staffFilter = searchParams.get('staff') || '';
  const search = searchParams.get('q') || '';
  const showPast = searchParams.get('past') === '1';
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pendingId, setPendingId] = useState(null);
  const confirm = useConfirm();
  // When an appointment is opened, the drawer shows both tabs (Details +
  // History). When only a customer is opened (from customer history elsewhere),
  // the drawer opens on the History tab without an appointment context.
  const [detailAppt, setDetailAppt] = useState(null);
  const [historyCustomerId, setHistoryCustomerId] = useState(null);
  const [rescheduleAppt, setRescheduleAppt] = useState(null);
  const [rescheduleForm, setRescheduleForm] = useState({ date: '', startTime: '', endTime: '' });
  const [rescheduleSaving, setRescheduleSaving] = useState(false);
  const [prescriptionAppt, setPrescriptionAppt] = useState(null);
  const [rxCompletionPrompt, setRxCompletionPrompt] = useState(null);
  const [completeAfterRxId, setCompleteAfterRxId] = useState(null);

  // Filter state lives in the URL so refresh/back/forward preserve the
  // operator's current appointments workspace.
  const [toast, setToast] = useState(null); // { kind: 'success'|'error', message }
  // Bulk-ops: which appointment IDs are checked + state of the
  // compose-message modal. Selection is cleared after each bulk action
  // so the next batch starts fresh.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [messageModal, setMessageModal] = useState(null); // null | { ids: [...] }
  const canUsePrescriptionWorkflow = isDoctorClinicTenant(tenant);
  const openPrescription = canUsePrescriptionWorkflow && canWriteClinicalDocuments
    ? (appointment) => {
        setCompleteAfterRxId(null);
        setPrescriptionAppt(appointment);
      }
    : undefined;

  const replaceQuery = useCallback((mutator) => {
    const params = new URLSearchParams(searchParams.toString());
    mutator(params);
    const next = params.toString();
    router.replace(next ? `?${next}` : '?', { scroll: false });
  }, [router, searchParams]);

  useEffect(() => {
    if (!canUsePrescriptionWorkflow) setPrescriptionAppt(null);
  }, [canUsePrescriptionWorkflow]);

  const setView = useCallback((nextView) => {
    replaceQuery((params) => {
      if (nextView === 'calendar') params.set('view', 'calendar');
      else params.delete('view');
    });
  }, [replaceQuery]);

  const setStaffFilter = useCallback((nextStaffId) => {
    replaceQuery((params) => {
      if (nextStaffId) params.set('staff', nextStaffId);
      else params.delete('staff');
    });
  }, [replaceQuery]);

  const setSearch = useCallback((nextSearch) => {
    replaceQuery((params) => {
      const value = String(nextSearch || '').trim();
      if (value) params.set('q', value);
      else params.delete('q');
    });
  }, [replaceQuery]);

  const setShowPast = useCallback((nextShowPast) => {
    replaceQuery((params) => {
      if (nextShowPast) params.set('past', '1');
      else params.delete('past');
    });
  }, [replaceQuery]);

  const openAppointmentDetail = useCallback((appt) => {
    setDetailAppt(appt);
    setHistoryCustomerId(null);
    replaceQuery((params) => {
      params.set('id', appt.id);
      params.delete('customer');
    });
  }, [replaceQuery]);

  const openCustomerHistory = useCallback((customerId) => {
    setHistoryCustomerId(customerId);
    setDetailAppt(null);
    replaceQuery((params) => {
      params.set('customer', customerId);
      params.delete('id');
    });
  }, [replaceQuery]);

  const closeAppointmentDrawer = useCallback(() => {
    setDetailAppt(null);
    setHistoryCustomerId(null);
    replaceQuery((params) => {
      params.delete('id');
      params.delete('customer');
    });
  }, [replaceQuery]);

  function showToast(message, kind = 'success', action = null) {
    setToast({ message, kind, action });
    // A toast carrying an action link (e.g. "View / print Rx + invoice")
    // lingers longer so the operator has time to click it.
    setTimeout(() => {
      setToast((t) => (t && t.message === message ? null : t));
    }, action ? 9000 : 3000);
  }

  async function load() {
    setLoading(true);
    setError('');
    try {
      const { data } = await axios.get('/api/appointments', {
        withCredentials: true,
        timeout: 15000,
      });
      setAppointments(Array.isArray(data.appointments) ? data.appointments : []);
    } catch (err) {
      if (err.response?.status === 401) {
        redirectToLogin();
        return;
      }
      const timedOut = err.code === 'ECONNABORTED' || /timeout/i.test(String(err.message || ''));
      setError(timedOut
        ? 'Appointments are taking too long to load. Please retry in a moment.'
        : err.response?.data?.message || 'Failed to load appointments');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    const id = searchParams.get('id');
    if (!id || detailAppt?.id === id || appointments.length === 0) return;
    const match = appointments.find((appointment) => appointment.id === id);
    if (match) {
      setDetailAppt(match);
      setHistoryCustomerId(null);
    }
  }, [appointments, detailAppt?.id, searchParams]);

  useEffect(() => {
    const customerId = searchParams.get('customer');
    if (!customerId || historyCustomerId === customerId) return;
    setHistoryCustomerId(customerId);
    setDetailAppt(null);
  }, [historyCustomerId, searchParams]);

  useEffect(() => {
    if (searchParams.get('id') || searchParams.get('customer')) return;
    setDetailAppt(null);
    setHistoryCustomerId(null);
  }, [searchParams]);

  function appointmentById(id) {
    return appointments.find((appointment) => appointment.id === id)
      || (detailAppt?.id === id ? detailAppt : null)
      || (prescriptionAppt?.id === id ? prescriptionAppt : null);
  }

  async function updateStatus(id, status, { skipConfirm = false, skipRxWarning = false } = {}) {
    const appointment = appointmentById(id);
    if (
      status === 'COMPLETED' &&
      !skipRxWarning &&
      canUsePrescriptionWorkflow &&
      appointment &&
      !appointment.prescription &&
      canWritePrescriptionFor(appointment)
    ) {
      setRxCompletionPrompt(appointment);
      return false;
    }
    const label = status === 'CANCELLED' ? 'cancel'
      : status === 'CONFIRMED' ? 'confirm'
      : status === 'NO_SHOW' ? 'mark as no-show'
      : 'mark complete';
    if (!skipConfirm && !confirm(`Are you sure you want to ${label} this appointment?`)) return false;
    setPendingId(id);
    try {
      await axios.put(`/api/appointments/${id}/status`, { status }, { withCredentials: true });
      await load();
      const verb = status === 'CANCELLED' ? 'Cancelled'
        : status === 'CONFIRMED' ? 'Confirmed'
        : status === 'NO_SHOW' ? 'Marked as no-show'
        : 'Marked complete';
      showToast(`${verb}.`);
      return true;
    } catch (err) {
      showToast(err.response?.data?.message || 'Action failed', 'error');
      return false;
    } finally {
      setPendingId(null);
    }
  }

  function openRxFromCompletionPrompt() {
    if (!rxCompletionPrompt) return;
    setCompleteAfterRxId(rxCompletionPrompt.id);
    setPrescriptionAppt(rxCompletionPrompt);
    setRxCompletionPrompt(null);
  }

  async function completeWithoutRx() {
    if (!rxCompletionPrompt) return;
    const id = rxCompletionPrompt.id;
    setRxCompletionPrompt(null);
    await updateStatus(id, 'COMPLETED', { skipConfirm: true, skipRxWarning: true });
  }

  function closePrescriptionModal() {
    if (prescriptionAppt?.id && completeAfterRxId === prescriptionAppt.id) {
      setCompleteAfterRxId(null);
    }
    setPrescriptionAppt(null);
  }

  // ── Bulk operations ──────────────────────────────────────────────
  function toggleSelect(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function clearSelection() { setSelectedIds(new Set()); }

  // Run a status change against every selected appointment in parallel.
  // Errors are toasted but don't roll back successes — partial success is
  // the right semantic for "I asked you to confirm 5 and 4 worked".
  async function bulkStatus(status) {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const verb = status === 'CONFIRMED' ? 'Confirm' : status === 'CANCELLED' ? 'Cancel' : status;
    if (!await confirm(`${verb} ${ids.length} appointment${ids.length === 1 ? '' : 's'}?`, { confirmLabel: verb, tone: status === 'CANCELLED' ? 'danger' : 'primary' })) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(
        ids.map((id) => axios.put(`/api/appointments/${id}/status`, { status }, { withCredentials: true }))
      );
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - ok;
      await load();
      clearSelection();
      if (failed === 0) showToast(`${verb}ed ${ok}.`);
      else showToast(`${verb}ed ${ok}. ${failed} failed — refresh to see why.`, 'error');
    } finally { setBulkBusy(false); }
  }

  async function bulkMessage({ subject, body }) {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const { data } = await axios.post('/api/business/appointments/bulk-message',
        { ids, subject, body },
        { withCredentials: true }
      );
      const sent = data.sent || 0;
      const skipped = data.skipped || 0;
      setMessageModal(null);
      clearSelection();
      if (skipped > 0) showToast(`Sent ${sent}. Skipped ${skipped} (no email on file).`);
      else showToast(`Sent ${sent} message${sent === 1 ? '' : 's'}.`);
    } catch (err) {
      showToast(err.response?.data?.message || 'Send failed', 'error');
    } finally { setBulkBusy(false); }
  }

  async function saveMeetingUrl(id, url) {
    await axios.put(`/api/appointments/${id}/meeting-url`, { url }, { withCredentials: true });
    setAppointments((prev) => prev.map((a) => (a.id === id ? { ...a, meetingUrl: url || null } : a)));
    if (detailAppt && detailAppt.id === id) {
      setDetailAppt((prev) => prev ? { ...prev, meetingUrl: url || null } : prev);
    }
    showToast(url ? 'Meeting link saved.' : 'Meeting link cleared.');
  }

  async function saveNotes(id, notes) {
    const { data } = await axios.put(`/api/appointments/${id}/notes`, { notes }, { withCredentials: true });
    // Merge in place so the drawer stays open on the correct appointment
    // without a full reload flicker.
    setAppointments((prev) => prev.map((a) => (a.id === id ? { ...a, notes: data.appointment.notes } : a)));
    if (detailAppt && detailAppt.id === id) {
      setDetailAppt((prev) => prev ? { ...prev, notes: data.appointment.notes } : prev);
    }
    showToast('Notes saved.');
  }

  function openReschedule(appt) {
    setRescheduleAppt(appt);
    setRescheduleForm({
      date: new Date(appt.date).toISOString().slice(0, 10),
      startTime: appt.startTime || '',
      endTime: appt.endTime || '',
    });
  }

  async function submitReschedule() {
    if (!rescheduleAppt) return;
    setRescheduleSaving(true);
    try {
      await axios.put(`/api/appointments/${rescheduleAppt.id}/reschedule`, rescheduleForm, { withCredentials: true });
      setRescheduleAppt(null);
      await load();
      showToast('Appointment rescheduled.');
    } catch (err) {
      showToast(err.response?.data?.message || 'Reschedule failed', 'error');
    } finally {
      setRescheduleSaving(false);
    }
  }

  // Drag-and-drop reschedule from the week calendar. Same backend
  // endpoint as the modal-driven path; the calendar already knows the
  // new date / startTime / endTime so we skip the modal entirely.
  // Optimistic update — the appointment block jumps to the new slot
  // immediately, then we reconcile with the server's reply.
  async function handleDragReschedule(appt, newSlot) {
    const previous = appointments;
    setAppointments((prev) => prev.map((a) => (
      a.id === appt.id
        ? { ...a, date: `${newSlot.date}T00:00:00.000Z`, startTime: newSlot.startTime, endTime: newSlot.endTime }
        : a
    )));
    try {
      await axios.put(`/api/appointments/${appt.id}/reschedule`, newSlot, { withCredentials: true });
      await load();
      showToast(`Moved to ${newSlot.date} ${newSlot.startTime}.`);
    } catch (err) {
      // Roll back the optimistic move on failure (slot conflict, past
      // date, schedule mismatch, etc.) and surface the backend's reason.
      setAppointments(previous);
      showToast(err.response?.data?.message || 'Reschedule failed', 'error');
    }
  }

  // Distinct staff list for the BUSINESS_ADMIN staff filter dropdown.
  const staffOptions = useMemo(() => {
    const map = new Map();
    for (const a of appointments) {
      if (a.staff?.id && !map.has(a.staff.id)) map.set(a.staff.id, a.staff.name || 'Staff');
    }
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [appointments]);

  // Apply all active filters. Runs in memory — list filtering lives client-side
  // until appointment count gets large enough to need server-side filtering.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return appointments.filter((a) => {
      if (statusFilter.size > 0 && !statusFilter.has(a.status)) return false;
      if (staffFilter && a.staff?.id !== staffFilter) return false;
      if (q) {
        const hay = [
          a.customer?.name, a.customer?.email, a.customer?.phone,
          a.user?.name, a.user?.email,
          a.service?.name,
          a.staff?.name,
          a.notes,
          a.couponCode,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [appointments, statusFilter, staffFilter, search]);

  // Partition by time window. Date math runs in the browser's local zone,
  // which is fine for "when should this appear in the Today section?" — the
  // business's timezone is only authoritative for new-booking validation.
  const { today, thisWeek, later, past, pendingCount } = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endOfToday = startOfToday + 24 * 60 * 60 * 1000;
    const endOfWeek = startOfToday + 7 * 24 * 60 * 60 * 1000;

    const today = [];
    const thisWeek = [];
    const later = [];
    const past = [];
    let pendingCount = 0;

    for (const a of filtered) {
      if (a.status === 'PENDING') pendingCount += 1;
      const t = new Date(a.date).getTime();
      const isActive = ACTIVE_STATUSES.has(a.status);
      const isFuture = t + 24 * 60 * 60 * 1000 >= Date.now();

      if (isActive && isFuture) {
        if (t >= startOfToday && t < endOfToday) today.push(a);
        else if (t >= endOfToday && t < endOfWeek) thisWeek.push(a);
        else later.push(a);
      } else {
        past.push(a);
      }
    }

    // Sort each active bucket by start time ascending.
    const byTime = (x, y) => new Date(x.date) - new Date(y.date) || (x.startTime || '').localeCompare(y.startTime || '');
    today.sort(byTime);
    thisWeek.sort(byTime);
    later.sort(byTime);
    // Past: most-recent first so the top of the list is the most relevant.
    past.sort((x, y) => new Date(y.date) - new Date(x.date));

    return { today, thisWeek, later, past, pendingCount };
  }, [filtered]);

  if (loading) {
    return (
      <div className="space-y-3">
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4">
        <p className="text-sm font-semibold text-red-700">{error}</p>
        <button
          type="button"
          onClick={load}
          className="mt-3 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-700 hover:bg-red-100"
        >
          Retry loading appointments
        </button>
      </div>
    );
  }

  const hasAnyFilter = statusFilter.size > 0 || staffFilter || search.trim();
  const totalActive = today.length + thisWeek.length + later.length;

  function toggleStatus(status) {
    const next = new Set(statusFilter);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    replaceQuery((params) => {
      const values = Array.from(next);
      if (values.length) params.set('status', values.join(','));
      else params.delete('status');
    });
  }

  function clearFilters() {
    replaceQuery((params) => {
      params.delete('status');
      params.delete('staff');
      params.delete('q');
    });
  }

  return (
    <div className="space-y-5">
      {/* Pending alert banner — only for admin/staff, when there are pending
          items that aren't already filtered out. Drives focus to the action
          that most often gets forgotten. */}
      {isAdminOrStaff && pendingCount > 0 && (
        <PendingBanner
          count={pendingCount}
          onClick={() => replaceQuery((params) => { params.set('status', 'PENDING'); })}
          alreadyFiltered={statusFilter.has('PENDING') && statusFilter.size === 1}
        />
      )}

      {/* View toggle (List / Calendar) — admin & staff only */}
      {isAdminOrStaff && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-xl w-fit">
            <ViewToggle active={view === 'list'} onClick={() => setView('list')}>
              <ListIcon /> List
            </ViewToggle>
            <ViewToggle active={view === 'calendar'} onClick={() => setView('calendar')}>
              <GridIcon /> Calendar
            </ViewToggle>
          </div>
          {canExportAppointments && <ExportMenu staffFilter={staffFilter} />}
        </div>
      )}

      {/* Filter bar — list view only; calendar has its own navigation */}
      {view === 'list' && (isAdminOrStaff || appointments.length > 5) && (
        <FilterBar
          canViewAllStaff={canViewAllStaff}
          statusFilter={statusFilter}
          onToggleStatus={toggleStatus}
          staffFilter={staffFilter}
          onStaffFilter={setStaffFilter}
          staffOptions={staffOptions}
          search={search}
          onSearch={setSearch}
          hasAnyFilter={hasAnyFilter}
          onClear={clearFilters}
          totalActive={totalActive}
          totalPast={past.length}
        />
      )}

      {/* Calendar view. Still uses the filtered list so the staff-dropdown
          filter from the list view carries over if the user toggles back. */}
      {view === 'calendar' && (
        <WeekCalendar
          appointments={filtered}
          schedule={[]}
          showStaff={canViewAllStaff}
          staffOptions={canViewAllStaff ? staffOptions : []}
          onAppointmentClick={openAppointmentDetail}
          onDragReschedule={canManageAllAppointments ? handleDragReschedule : undefined}
        />
      )}

      {/* Active sections (list view only) */}
      {view === 'list' && (
        <>
          <Section title="Today" count={today.length} accent emptyMsg="No appointments today.">
            {today.map((a) => (
              <AppointmentRow key={a.id} appt={a} role={role} pending={pendingId === a.id}
                selectable={canBulkAppointments && (a.status === 'PENDING' || a.status === 'CONFIRMED')}
                selected={selectedIds.has(a.id)} onToggleSelect={() => toggleSelect(a.id)}
                canManage={canManageAppointment(a)}
                canCancel={canCancelAppointment(a)}
                canWritePrescription={canWritePrescriptionFor(a)}
                showStaff={canViewAllStaff}
                onUpdate={updateStatus} onReschedule={openReschedule}
                onCustomerTap={openCustomerHistory}
                onWritePrescription={openPrescription}
                onOpenDetail={openAppointmentDetail} />
            ))}
          </Section>

          <Section title="This week" count={thisWeek.length} hideWhenEmpty>
            {thisWeek.map((a) => (
              <AppointmentRow key={a.id} appt={a} role={role} pending={pendingId === a.id}
                selectable={canBulkAppointments && (a.status === 'PENDING' || a.status === 'CONFIRMED')}
                selected={selectedIds.has(a.id)} onToggleSelect={() => toggleSelect(a.id)}
                canManage={canManageAppointment(a)}
                canCancel={canCancelAppointment(a)}
                canWritePrescription={canWritePrescriptionFor(a)}
                showStaff={canViewAllStaff}
                onUpdate={updateStatus} onReschedule={openReschedule}
                onCustomerTap={openCustomerHistory}
                onWritePrescription={openPrescription}
                onOpenDetail={openAppointmentDetail} />
            ))}
          </Section>

          <Section title="Later" count={later.length} hideWhenEmpty>
            {later.map((a) => (
              <AppointmentRow key={a.id} appt={a} role={role} pending={pendingId === a.id}
                selectable={canBulkAppointments && (a.status === 'PENDING' || a.status === 'CONFIRMED')}
                selected={selectedIds.has(a.id)} onToggleSelect={() => toggleSelect(a.id)}
                canManage={canManageAppointment(a)}
                canCancel={canCancelAppointment(a)}
                canWritePrescription={canWritePrescriptionFor(a)}
                showStaff={canViewAllStaff}
                onUpdate={updateStatus} onReschedule={openReschedule}
                onCustomerTap={openCustomerHistory}
                onWritePrescription={openPrescription}
                onOpenDetail={openAppointmentDetail} />
            ))}
          </Section>

          {totalActive === 0 && past.length === 0 && (
            <EmptyState hasFilter={hasAnyFilter} onClear={clearFilters} />
          )}

          {past.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setShowPast(!showPast)}
                className="text-sm font-semibold text-gray-600 hover:text-gray-900 flex items-center gap-1.5"
              >
                <ChevronIcon open={showPast} />
                Past &amp; cancelled
                <span className="text-xs text-gray-400 font-normal">({past.length})</span>
              </button>
              {showPast && (
                <div className="mt-3 space-y-2">
                  {past.map((a) => (
                    <AppointmentRow key={a.id} appt={a} role={role} pending={pendingId === a.id}
                      canManage={canManageAppointment(a)}
                      canCancel={canCancelAppointment(a)}
                      canWritePrescription={canWritePrescriptionFor(a)}
                      showStaff={canViewAllStaff}
                      onUpdate={updateStatus} onReschedule={openReschedule}
                      onCustomerTap={openCustomerHistory}
                      onWritePrescription={openPrescription}
                      onOpenDetail={openAppointmentDetail} readOnly />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {detailAppt && (
        <AppointmentDetailDrawer
          appointment={detailAppt}
          role={role}
          pending={pendingId === detailAppt.id}
          canManage={canManageAppointment(detailAppt)}
          canCancel={canCancelAppointment(detailAppt)}
          canWritePrescription={canWritePrescriptionFor(detailAppt)}
          onClose={closeAppointmentDrawer}
          onStatusChange={async (status) => {
            const changed = await updateStatus(detailAppt.id, status);
            if (changed) closeAppointmentDrawer();
          }}
          onReschedule={() => {
            openReschedule(detailAppt);
            closeAppointmentDrawer();
          }}
          onSaveNotes={async (notes) => { await saveNotes(detailAppt.id, notes); }}
          onSaveMeetingUrl={async (url) => { await saveMeetingUrl(detailAppt.id, url); }}
          onWritePrescription={openPrescription ? () => openPrescription(detailAppt) : undefined}
        />
      )}

      {historyCustomerId && (
        <AppointmentDetailDrawer
          customerId={historyCustomerId}
          role={role}
          canManage={false}
          canCancel={false}
          canWritePrescription={false}
          onClose={closeAppointmentDrawer}
        />
      )}

      {canUsePrescriptionWorkflow && prescriptionAppt && (
        <PrescriptionModal
          appointment={prescriptionAppt}
          onClose={closePrescriptionModal}
          completeAfterSave={completeAfterRxId === prescriptionAppt.id}
          onDraftSaved={async (prescription) => {
            await load();
            if (prescription) {
              setPrescriptionAppt((prev) => (prev ? { ...prev, prescription } : prev));
            }
          }}
          onCompleted={async (appointmentId) => {
            setCompleteAfterRxId(null);
            setPrescriptionAppt(null);
            await load();
            showToast('Consultation completed — Rx + invoice issued.', 'success', {
              actionLabel: 'View / print',
              href: `/api/appointments/${appointmentId}/consultation/view`,
            });
          }}
        />
      )}

      {rxCompletionPrompt && (
        <RxCompletionPrompt
          appointment={rxCompletionPrompt}
          onWriteRx={openRxFromCompletionPrompt}
          onCompleteWithoutRx={completeWithoutRx}
          onCancel={() => setRxCompletionPrompt(null)}
        />
      )}

      {rescheduleAppt && (
        <RescheduleModal
          appt={rescheduleAppt}
          form={rescheduleForm}
          saving={rescheduleSaving}
          onChange={(patch) => setRescheduleForm((prev) => ({ ...prev, ...patch }))}
          onClose={() => { if (!rescheduleSaving) setRescheduleAppt(null); }}
          onSubmit={submitReschedule}
        />
      )}

      {toast && <Toast kind={toast.kind} message={toast.message} action={toast.action} onClose={() => setToast(null)} />}

      {/* Bulk-actions sticky bar — only renders when at least one
          appointment checkbox is ticked. Sits above the toast (z-50)
          and below modals (z-60). */}
      {selectedIds.size > 0 && (
        <BulkActionBar
          count={selectedIds.size}
          busy={bulkBusy}
          onConfirmAll={() => bulkStatus('CONFIRMED')}
          onCancelAll={() => bulkStatus('CANCELLED')}
          onMessageAll={() => setMessageModal({ ids: Array.from(selectedIds) })}
          onClear={clearSelection}
        />
      )}

      {messageModal && (
        <BulkMessageModal
          count={messageModal.ids.length}
          busy={bulkBusy}
          onClose={() => !bulkBusy && setMessageModal(null)}
          onSend={bulkMessage}
        />
      )}
    </div>
  );
}

function Toast({ kind, message, action, onClose }) {
  const tone = kind === 'error'
    ? 'bg-rose-600 text-white'
    : 'bg-gray-900 text-white';
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] animate-[fadeIn_0.15s_ease-out]">
      <div className={`flex items-center gap-3 px-4 py-2.5 rounded-xl shadow-lg ${tone}`}>
        <span className="text-sm font-medium">{message}</span>
        {action?.href && (
          <a
            href={action.href}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md bg-teal-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-teal-500"
          >
            {action.actionLabel || 'View'}
          </a>
        )}
        <button type="button" onClick={onClose} aria-label="Dismiss" className="opacity-70 hover:opacity-100 text-lg leading-none">
          ×
        </button>
      </div>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="border border-gray-200 rounded-xl p-4 animate-pulse">
      <div className="flex flex-col sm:flex-row sm:items-start gap-4">
        <div className="flex-1 space-y-2">
          <div className="h-4 w-1/3 bg-gray-200 rounded" />
          <div className="h-3 w-1/2 bg-gray-100 rounded" />
          <div className="h-3 w-2/3 bg-gray-100 rounded" />
          <div className="h-3 w-1/4 bg-gray-100 rounded mt-2" />
        </div>
        <div className="space-y-2 sm:items-end flex flex-col">
          <div className="h-5 w-16 bg-gray-200 rounded-full" />
          <div className="flex gap-2">
            <div className="h-6 w-16 bg-gray-100 rounded-lg" />
            <div className="h-6 w-20 bg-gray-100 rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  );
}

// Export menu — pops over with CSV / iCal / range options. Hits the
// new GET /api/business/appointments/export endpoint and triggers a
// browser download via a hidden anchor tag.
function ExportMenu({ staffFilter }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  function rangeFor(daysBack) {
    const today = new Date();
    const from = new Date(today);
    from.setDate(today.getDate() - (daysBack - 1));
    return { from: from.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
  }

  async function download(format, daysBack) {
    setBusy(true);
    try {
      const { from, to } = rangeFor(daysBack);
      const params = new URLSearchParams({ format, from, to });
      if (staffFilter) params.set('staffId', staffFilter);
      const res = await fetch(`/api/business/appointments/export?${params}`, { credentials: 'include' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `appointments_${from}_to_${to}.${format === 'ical' ? 'ics' : 'csv'}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch (err) {
      alert(err.message || 'Export failed');
    } finally { setBusy(false); }
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} disabled={busy}
        className="px-3 py-2 text-xs font-semibold rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50 inline-flex items-center gap-1.5">
        ⬇ Export
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-64 bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden z-20">
            <p className="px-3 py-2 text-[10px] font-bold tracking-wider uppercase text-gray-500 bg-gray-50 border-b border-gray-100">CSV (spreadsheet)</p>
            {[7, 30, 90].map((d) => (
              <button key={`csv-${d}`} disabled={busy} onClick={() => download('csv', d)}
                className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 disabled:opacity-50">
                Last {d} days
              </button>
            ))}
            <p className="px-3 py-2 text-[10px] font-bold tracking-wider uppercase text-gray-500 bg-gray-50 border-y border-gray-100">iCal (calendar app)</p>
            {[7, 30, 90].map((d) => (
              <button key={`ical-${d}`} disabled={busy} onClick={() => download('ical', d)}
                className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 disabled:opacity-50">
                Last {d} days
              </button>
            ))}
            {staffFilter && (
              <p className="px-3 py-2 text-[10px] text-gray-500 bg-amber-50 border-t border-amber-100">
                Filtered to selected staff member
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Inline editable meeting-link field for virtual appointments. Shows
// the effective link (per-appointment override → service default),
// lets admin/staff paste a different URL, and surfaces a "Copy" +
// "Open" affordance. Empty save clears the per-booking override and
// reverts to the service-level default.
function MeetingUrlField({ appt, onSave }) {
  const fallback = appt.service?.virtualMeetingUrl || '';
  const initial = appt.meetingUrl || '';
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const dirty = (draft || '') !== (initial || '');
  const effective = (draft || initial || fallback || '').trim();

  async function save() {
    if (!dirty) return;
    setSaving(true);
    try { await onSave(draft.trim()); } finally { setSaving(false); }
  }
  async function copy() {
    if (!effective) return;
    try { await navigator.clipboard.writeText(effective); } catch {}
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Meeting link
          {!appt.meetingUrl && fallback && (
            <span className="ml-2 text-[10px] font-normal text-gray-400 normal-case tracking-normal">using service default</span>
          )}
        </label>
        {effective && (
          <div className="flex items-center gap-1.5">
            <a href={effective} target="_blank" rel="noopener noreferrer"
              className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800">
              Open ↗
            </a>
            <button type="button" onClick={copy}
              className="text-[11px] font-semibold text-gray-600 hover:text-gray-900">
              Copy
            </button>
          </div>
        )}
      </div>
      <input
        type="url"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={fallback || 'https://meet.google.com/abc-defg-hij'}
        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-gray-400"
      />
      {dirty && (
        <div className="flex justify-end gap-2 mt-2">
          <button type="button" onClick={() => setDraft(initial)} disabled={saving}
            className="px-3 py-1.5 text-xs font-semibold text-gray-700 border border-gray-300 rounded-lg hover:border-gray-900 disabled:opacity-50">
            Discard
          </button>
          <button type="button" onClick={save} disabled={saving}
            className="px-3 py-1.5 text-xs font-semibold text-white rounded-lg disabled:opacity-50"
            style={{ backgroundColor: 'var(--theme-primary)' }}>
            {saving ? 'Saving…' : 'Save link'}
          </button>
        </div>
      )}
    </div>
  );
}

// Sticky action bar — renders fixed at the bottom of the viewport
// whenever the admin has selected at least one appointment via the
// row checkbox. Three actions: Confirm all, Cancel all, Message all.
// Cancel-selection X on the right.
function BulkActionBar({ count, busy, onConfirmAll, onCancelAll, onMessageAll, onClear }) {
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-2xl w-[calc(100%-2rem)]">
      <div className="bg-gray-900 text-white rounded-2xl shadow-2xl px-4 py-3 flex items-center gap-3">
        <p className="text-sm font-semibold">
          {count} selected
        </p>
        <div className="flex-1" />
        <button onClick={onMessageAll} disabled={busy}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-50">
          Message
        </button>
        <button onClick={onConfirmAll} disabled={busy}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50">
          Confirm
        </button>
        <button onClick={onCancelAll} disabled={busy}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-rose-500 hover:bg-rose-600 disabled:opacity-50">
          Cancel
        </button>
        <button onClick={onClear} disabled={busy} aria-label="Clear selection"
          className="ml-1 w-8 h-8 rounded-lg flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 disabled:opacity-50">
          ✕
        </button>
      </div>
    </div>
  );
}

// Compose a custom email to every selected customer. Subject + body.
// Backend skips appointments with no email on file and returns the
// counts so we can toast accurately.
function BulkMessageModal({ count, busy, onClose, onSend }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  function submit(e) {
    e.preventDefault();
    if (!subject.trim() || !body.trim()) return;
    onSend({ subject: subject.trim(), body: body.trim() });
  }

  return (
    <div className="fixed inset-0 z-60 bg-black/40 flex items-center justify-center px-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-4">
        <div>
          <h3 className="text-lg font-bold text-gray-900" style={{ fontFamily: 'var(--font-heading)' }}>
            Message {count} customer{count === 1 ? '' : 's'}
          </h3>
          <p className="text-xs text-gray-500 mt-1">
            Sends one email per selected appointment. Customers without an email on file are skipped.
          </p>
        </div>
        <label className="block">
          <span className="block text-xs font-semibold text-gray-700 mb-1">Subject</span>
          <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} required
            maxLength={200} placeholder="A quick update about your appointment"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </label>
        <label className="block">
          <span className="block text-xs font-semibold text-gray-700 mb-1">Message</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} required
            rows={6} maxLength={4000} placeholder="Hi — just wanted to let you know…"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none" />
        </label>
        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={busy}
            className="px-4 py-2 text-sm font-semibold text-gray-700 hover:text-gray-900 disabled:opacity-50">
            Cancel
          </button>
          <button type="submit" disabled={busy || !subject.trim() || !body.trim()}
            className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
            {busy ? 'Sending…' : `Send ${count} message${count === 1 ? '' : 's'}`}
          </button>
        </div>
      </form>
    </div>
  );
}

function ViewToggle({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
        active ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'
      }`}
    >
      {children}
    </button>
  );
}

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18M8 14v6M16 14v6M3 14h18" />
    </svg>
  );
}

function PendingBanner({ count, onClick, alreadyFiltered }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-amber-200 bg-amber-50">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-700">
            <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-amber-900">
            {count} appointment{count === 1 ? '' : 's'} waiting for confirmation
          </p>
          <p className="text-xs text-amber-700">Confirm soon so customers know they're in.</p>
        </div>
      </div>
      {!alreadyFiltered && (
        <button
          type="button"
          onClick={onClick}
          className="px-3 py-1.5 text-xs font-semibold text-amber-900 bg-white border border-amber-300 rounded-lg hover:border-amber-500 whitespace-nowrap"
        >
          Review
        </button>
      )}
    </div>
  );
}

function FilterBar({ canViewAllStaff, statusFilter, onToggleStatus, staffFilter, onStaffFilter, staffOptions, search, onSearch, hasAnyFilter, onClear, totalActive, totalPast }) {
  const statuses = ['PENDING', 'CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'];
  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <div className="relative flex-1 min-w-0">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search by customer, service, staff, or notes…"
            className="w-full pl-9 pr-3 py-2.5 text-sm bg-white border border-gray-200 rounded-xl focus:outline-none focus:border-gray-400"
          />
        </div>

        {canViewAllStaff && staffOptions.length > 1 && (
          <select
            value={staffFilter}
            onChange={(e) => onStaffFilter(e.target.value)}
            className="px-3 py-2.5 text-sm bg-white border border-gray-200 rounded-xl focus:outline-none focus:border-gray-400 min-w-[140px]"
          >
            <option value="">All staff</option>
            {staffOptions.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}

        {hasAnyFilter && (
          <button
            type="button"
            onClick={onClear}
            className="px-3 py-2.5 text-sm font-semibold text-gray-700 border border-gray-200 rounded-xl hover:border-gray-400 bg-white whitespace-nowrap"
          >
            Clear
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {statuses.map((s) => {
          const active = statusFilter.has(s);
          const cls = active ? STATUS_STYLES[s] : 'bg-white text-gray-600 border-gray-200';
          return (
            <button
              key={s}
              type="button"
              onClick={() => onToggleStatus(s)}
              className={`px-2.5 py-1 text-xs font-semibold rounded-full border transition-colors ${cls}`}
            >
              {STATUS_LABEL[s]}
            </button>
          );
        })}
        <div className="ml-auto text-xs text-gray-500 self-center">
          {totalActive} active · {totalPast} past
        </div>
      </div>
    </div>
  );
}

function EmptyState({ hasFilter, onClear }) {
  return (
    <div className="border border-dashed border-gray-200 rounded-xl py-10 text-center">
      <div className="w-12 h-12 rounded-full bg-gray-50 flex items-center justify-center mx-auto mb-3">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
      </div>
      <p className="text-sm font-medium text-gray-900">
        {hasFilter ? 'No appointments match your filters' : 'No appointments yet'}
      </p>
      <p className="text-xs text-gray-500 mt-1">
        {hasFilter ? 'Try clearing the filters to see everything.' : "Once customers start booking, they'll show up here."}
      </p>
      {hasFilter && (
        <button
          type="button"
          onClick={onClear}
          className="mt-4 px-3 py-1.5 text-xs font-semibold text-gray-700 border border-gray-300 rounded-lg hover:border-gray-900"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

function ChevronIcon({ open }) {
  return (
    <svg
      viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
      className={`transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/**
 * Unified right-side drawer. Shows appointment details + customer history in
 * two tabs. Called from: row "Details" button, calendar block click, or
 * customer-name tap (which opens on the History tab).
 */
function AppointmentDetailDrawer({ appointment, customerId, role, pending, canManage, canCancel, canWritePrescription, onClose, onStatusChange, onReschedule, onSaveNotes, onSaveMeetingUrl, onWritePrescription }) {
  const initialTab = appointment ? 'details' : 'history';
  const [tab, setTab] = useState(initialTab);
  const customerIdForHistory = appointment?.customer?.id || customerId || null;

  const [history, setHistory] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');

  // Notes edit state
  const [notesDraft, setNotesDraft] = useState(appointment?.notes || '');
  const [notesSaving, setNotesSaving] = useState(false);
  const notesDirty = (notesDraft || '') !== (appointment?.notes || '');

  // Keyboard shortcuts: Esc closes; C confirms (when pending); R reschedules.
  // Shortcuts are ignored while typing in an input/textarea so they don't
  // interfere with the Notes field.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
        return;
      }
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
      if (!appointment || pending) return;
      if ((e.key === 'c' || e.key === 'C') && canManage && appointment.status === 'PENDING') {
        e.preventDefault();
        onStatusChange?.('CONFIRMED');
      } else if ((e.key === 'r' || e.key === 'R') && canManage && (appointment.status === 'PENDING' || appointment.status === 'CONFIRMED')) {
        e.preventDefault();
        onReschedule?.();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [appointment, pending, canManage, onClose, onStatusChange, onReschedule]);

  useEffect(() => {
    if (!customerIdForHistory) return;
    if (tab !== 'history' && !appointment) return; // only preload when on history tab or when we have no appointment
    if (history) return; // already loaded
    let cancelled = false;
    setHistoryLoading(true);
    (async () => {
      try {
        const { data: body } = await axios.get(`/api/business/customers/${customerIdForHistory}/history`, { withCredentials: true });
        if (!cancelled) setHistory(body);
      } catch (err) {
        if (!cancelled) setHistoryError(err.response?.data?.message || 'Could not load customer history');
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [customerIdForHistory, tab, appointment, history]);

  async function handleSaveNotes() {
    if (!onSaveNotes || !notesDirty) return;
    setNotesSaving(true);
    try {
      await onSaveNotes(notesDraft);
    } catch (err) {
      alert(err.response?.data?.message || 'Could not save notes');
    } finally {
      setNotesSaving(false);
    }
  }

  const customer = appointment?.customer || appointment?.user || history?.customer || {};

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-stretch sm:justify-end" onClick={onClose}>
      <div
        className="bg-white w-full max-w-md sm:h-full max-h-[92vh] sm:max-h-none overflow-y-auto shadow-xl flex flex-col rounded-t-2xl sm:rounded-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle on mobile */}
        <div className="sm:hidden pt-2 pb-1 flex justify-center">
          <div className="w-10 h-1.5 rounded-full bg-gray-200" aria-hidden />
        </div>
        <div className="sticky top-0 bg-white border-b border-gray-100 px-5 py-4 flex items-start justify-between z-10">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-gray-900 truncate">{customer.name || 'Customer'}</h3>
            {customer.email && <p className="text-xs text-gray-500 truncate">{customer.email}</p>}
            {customer.phone && (
              <a href={`tel:${customer.phone}`} className="text-xs text-gray-500 hover:text-gray-900 hover:underline">
                {customer.phone}
              </a>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-2xl leading-none flex-shrink-0 ml-2" aria-label="Close (Esc)" title="Close (Esc)">×</button>
        </div>

        {/* Tabs */}
        {appointment && (
          <div className="flex border-b border-gray-100 px-5">
            <DrawerTab active={tab === 'details'} onClick={() => setTab('details')}>Details</DrawerTab>
            {customerIdForHistory && (
              <DrawerTab active={tab === 'history'} onClick={() => setTab('history')}>History</DrawerTab>
            )}
          </div>
        )}

        {/* Tab content */}
        <div className="flex-1">
          {tab === 'details' && appointment && (
            <DetailTab
              appt={appointment}
              role={role}
              pending={pending}
              canManage={canManage}
              canCancel={canCancel}
              canWritePrescription={canWritePrescription}
              notesDraft={notesDraft}
              setNotesDraft={setNotesDraft}
              notesDirty={notesDirty}
              notesSaving={notesSaving}
              onSaveNotes={handleSaveNotes}
              onSaveMeetingUrl={onSaveMeetingUrl}
              onStatusChange={onStatusChange}
              onReschedule={onReschedule}
              onWritePrescription={onWritePrescription}
            />
          )}

          {tab === 'history' && (
            <HistoryTab data={history} loading={historyLoading} error={historyError} />
          )}
        </div>
      </div>
    </div>
  );
}

function DrawerTab({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-1 py-3 mr-5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
        active ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800'
      }`}
    >
      {children}
    </button>
  );
}

function DetailTab({ appt, role, pending, canManage, canCancel, canWritePrescription, notesDraft, setNotesDraft, notesDirty, notesSaving, onSaveNotes, onSaveMeetingUrl, onStatusChange, onReschedule, onWritePrescription }) {
  const dateLabel = formatDate(appt.date);
  const dur = durationMin(appt);
  const price = formatPrice(appt.finalPrice ?? appt.originalPrice ?? appt.service?.price);
  const discounted = appt.discountAmount && Number(appt.discountAmount) > 0;
  const statusClass = STATUS_STYLES[appt.status] || STATUS_STYLES.PENDING;
  const isAdminOrStaff = role === 'BUSINESS_ADMIN' || role === 'SUPER_ADMIN' || role === 'STAFF';
  const canWriteDocument = !!onWritePrescription && canWritePrescription && appt.status !== 'CANCELLED' && appt.status !== 'NO_SHOW';

  return (
    <div className="p-5 space-y-5">
      {/* Status + key facts */}
      <div className="flex items-center gap-3">
        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${statusClass}`}>
          {STATUS_LABEL[appt.status] || appt.status}
        </span>
        {price && (
          <span className="ml-auto flex items-center gap-1.5">
            <span className={`text-base font-semibold ${discounted ? 'text-emerald-700' : 'text-gray-900'}`}>{price}</span>
            {discounted && (
              <span className="text-[10px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
                −{formatPrice(appt.discountAmount)}
              </span>
            )}
          </span>
        )}
      </div>

      <dl className="grid grid-cols-[90px_1fr] gap-y-2 text-sm">
        <dt className="text-gray-500">Service</dt>
        <dd className="text-gray-900 font-medium">
          {appt.service?.name || 'Appointment'}
          {dur && <span className="text-gray-500 font-normal"> · {dur} min</span>}
        </dd>
        <dt className="text-gray-500">When</dt>
        <dd className="text-gray-900">{dateLabel} · {appt.startTime}–{appt.endTime}</dd>
        {appt.staff?.name && (
          <>
            <dt className="text-gray-500">Staff</dt>
            <dd className="text-gray-900">{appt.staff.name}</dd>
          </>
        )}
        {appt.couponCode && (
          <>
            <dt className="text-gray-500">Coupon</dt>
            <dd className="text-gray-900 font-mono text-xs">{appt.couponCode}</dd>
          </>
        )}
      </dl>

      {/* Meeting link — only for virtual services. Admin / staff can
          override the service-level URL per booking; the override
          flows into the customer's confirmation + reminder emails. */}
      {appt.service?.isVirtual && canManage && onSaveMeetingUrl && (
        <MeetingUrlField
          appt={appt}
          onSave={onSaveMeetingUrl}
        />
      )}

      {/* Notes — inline editable (admin/staff only) */}
      {isAdminOrStaff && canManage ? (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">Internal notes</label>
            <span className="text-[10px] text-gray-400">{(notesDraft || '').length} / 500</span>
          </div>
          <textarea
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder="Anything the team should know about this booking…"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-gray-400 resize-none"
          />
          {notesDirty && (
            <div className="flex justify-end gap-2 mt-2">
              <button
                type="button"
                onClick={() => setNotesDraft(appt.notes || '')}
                disabled={notesSaving}
                className="px-3 py-1.5 text-xs font-semibold text-gray-700 border border-gray-300 rounded-lg hover:border-gray-900 disabled:opacity-50"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={onSaveNotes}
                disabled={notesSaving}
                className="px-3 py-1.5 text-xs font-semibold text-white rounded-lg disabled:opacity-50"
                style={{ backgroundColor: 'var(--theme-primary)' }}
              >
                {notesSaving ? 'Saving…' : 'Save note'}
              </button>
            </div>
          )}
        </div>
      ) : appt.notes ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1.5">Notes</p>
          <p className="text-sm text-gray-800 italic">"{appt.notes}"</p>
        </div>
      ) : null}

      {/* Actions */}
      <div className="border-t border-gray-100 pt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Actions</p>
          {isAdminOrStaff && canManage && (
            <p className="text-[10px] text-gray-400">Shortcuts: C · R · Esc</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage && appt.status === 'PENDING' && (
            <Btn onClick={() => onStatusChange?.('CONFIRMED')} disabled={pending} variant="primary">Confirm</Btn>
          )}
          {canManage && (appt.status === 'PENDING' || appt.status === 'CONFIRMED') && (
            <Btn onClick={onReschedule} disabled={pending} variant="secondary">Reschedule</Btn>
          )}
          {canManage && appt.status === 'CONFIRMED' && (
            <Btn onClick={() => onStatusChange?.('COMPLETED')} disabled={pending} variant="primary">Mark complete</Btn>
          )}
          {canManage && appt.status === 'CONFIRMED' && (
            <Btn onClick={() => onStatusChange?.('NO_SHOW')} disabled={pending} variant="warn">No-show</Btn>
          )}
          {canWriteDocument && (
            <Btn onClick={onWritePrescription} disabled={pending} variant="primary">{appt.prescription ? 'Edit Rx' : 'Write Rx'}</Btn>
          )}
          {canCancel && (appt.status === 'PENDING' || appt.status === 'CONFIRMED') && (
            <Btn onClick={() => onStatusChange?.('CANCELLED')} disabled={pending} variant="danger">Cancel</Btn>
          )}
          {appt.customer?.email && (
            <a
              href={`mailto:${appt.customer.email}`}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg text-gray-700 border border-gray-300 hover:bg-gray-50 transition-colors"
            >
              Email customer
            </a>
          )}
          {appt.customer?.phone && (
            <a
              href={`tel:${appt.customer.phone}`}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg text-gray-700 border border-gray-300 hover:bg-gray-50 transition-colors"
            >
              Call customer
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function HistoryTab({ data, loading, error }) {
  if (loading) return <div className="py-10 flex justify-center"><Spinner /></div>;
  if (error) return <p className="p-5 text-sm text-red-600">{error}</p>;
  if (!data) return null;

  return (
    <>
      <div className="grid grid-cols-4 gap-2 p-5 border-b border-gray-100">
        <DrawerStat label="Visits"   value={data.stats.totalVisits} />
        <DrawerStat label="Spent"    value={`₹${data.stats.totalSpend.toLocaleString('en-IN')}`} />
        <DrawerStat label="Avg"      value={`₹${data.stats.avgSpend.toLocaleString('en-IN')}`} />
        <DrawerStat label="No-shows" value={data.stats.noShows} tone={data.stats.noShows > 0 ? 'rose' : 'gray'} />
      </div>

      <div className="p-5">
        <p className="text-xs uppercase tracking-wider font-semibold text-gray-500 mb-3">Last 30 appointments</p>
        {data.appointments.length === 0 ? (
          <p className="text-sm text-gray-500">No appointments on record.</p>
        ) : (
          <ul className="space-y-2">
            {data.appointments.map((a) => {
              const dateStr = new Date(a.date).toISOString().slice(0, 10);
              const statusClass = STATUS_STYLES[a.status] || STATUS_STYLES.PENDING;
              return (
                <li key={a.id} className="border border-gray-100 rounded-lg px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 truncate">{a.service?.name || 'Appointment'}</p>
                      <p className="text-xs text-gray-500">{dateStr} · {a.startTime}–{a.endTime} · with {a.staff?.name || '—'}</p>
                    </div>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${statusClass}`}>
                      {a.status}
                    </span>
                  </div>
                  {a.notes && <p className="text-xs text-gray-600 italic mt-1">"{a.notes}"</p>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

function DrawerStat({ label, value, tone = 'gray' }) {
  const tones = { gray: 'text-gray-900', rose: 'text-rose-700' };
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-500">{label}</p>
      <p className={`text-base font-semibold mt-0.5 ${tones[tone] || tones.gray}`}>{value}</p>
    </div>
  );
}

function Section({ title, count, accent, hideWhenEmpty, children, emptyMsg }) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : !!children;
  if (!hasChildren && hideWhenEmpty) return null;

  const titleCls = accent
    ? 'text-sm font-bold text-gray-900'
    : 'text-sm font-semibold text-gray-700';

  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2">
        <h3 className={titleCls}>{title}</h3>
        {count != null && (
          <span className="text-xs text-gray-400 font-normal">({count})</span>
        )}
        {accent && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 ml-auto" aria-hidden />}
      </div>
      {hasChildren ? (
        <div className="space-y-2">{children}</div>
      ) : emptyMsg ? (
        <div className="border border-dashed border-gray-200 rounded-xl py-6 text-center text-xs text-gray-500">
          {emptyMsg}
        </div>
      ) : null}
    </div>
  );
}

// Formats price as a plain string. Currency symbol is unknown at this layer,
// so we prefix with the business's default (₹). When we wire per-business
// currency into the API response we can swap this to a proper formatter.
function formatPrice(n) {
  if (n == null) return null;
  const num = Number(n);
  if (Number.isNaN(num)) return null;
  return `₹${num.toLocaleString('en-IN')}`;
}

function formatDate(d) {
  const date = new Date(d);
  const today = new Date();
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

function durationMin(appt) {
  const svcDur = appt.service?.duration;
  if (svcDur) return svcDur;
  if (appt.startTime && appt.endTime) {
    const [sh, sm] = appt.startTime.split(':').map(Number);
    const [eh, em] = appt.endTime.split(':').map(Number);
    return (eh * 60 + em) - (sh * 60 + sm);
  }
  return null;
}

function AppointmentRow({ appt, role, pending, canManage, canCancel, canWritePrescription, showStaff, onUpdate, onReschedule, onCustomerTap, onOpenDetail, onWritePrescription, readOnly, selectable, selected, onToggleSelect }) {
  const dateLabel = formatDate(appt.date);
  const statusClass = STATUS_STYLES[appt.status] || STATUS_STYLES.PENDING;
  const canTapCustomer = (role === 'BUSINESS_ADMIN' || role === 'SUPER_ADMIN' || role === 'STAFF') && appt.customer?.id && onCustomerTap;
  const dur = durationMin(appt);
  const price = formatPrice(appt.finalPrice ?? appt.originalPrice ?? appt.service?.price);
  const discounted = appt.discountAmount && Number(appt.discountAmount) > 0;
  const customer = appt.customer || appt.user || {};
  const canWriteDocument = !!onWritePrescription && canWritePrescription && appt.status !== 'CANCELLED' && appt.status !== 'NO_SHOW';

  // Contextual "who" labels
  const leftContent = (() => {
    const customerName = customer.name || 'Customer';
    const NameEl = canTapCustomer
      ? (
        <button
          type="button"
          onClick={() => onCustomerTap(appt.customer.id)}
          className="font-semibold text-gray-900 hover:underline text-left"
          title="View customer history"
        >
          {customerName}
        </button>
      )
      : <p className="font-semibold text-gray-900">{customerName}</p>;

    if (role === 'BUSINESS_ADMIN' || role === 'SUPER_ADMIN' || role === 'STAFF') {
      return (
        <>
          {NameEl}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-gray-500 mt-0.5">
            {customer.email && <span className="truncate">{customer.email}</span>}
            {customer.phone && (
              <a href={`tel:${customer.phone}`} className="hover:text-gray-900 hover:underline">
                {customer.phone}
              </a>
            )}
          </div>
          <p className="text-sm text-gray-700 mt-1.5">
            <span className="font-medium">{appt.service?.name || 'Appointment'}</span>
            {dur && <span className="text-gray-400"> · {dur} min</span>}
            {showStaff && appt.staff?.name && (
              <span className="text-gray-500"> · with {appt.staff.name}</span>
            )}
          </p>
          {role === 'STAFF' && appt.notes && (
            <p className="text-xs text-gray-500 mt-1 italic">"{appt.notes}"</p>
          )}
        </>
      );
    }
    // USER
    return (
      <>
        <p className="font-semibold text-gray-900">{appt.business?.name}</p>
        <p className="text-sm text-gray-700 mt-1">
          <span className="font-medium">{appt.service?.name}</span>
          {dur && <span className="text-gray-400"> · {dur} min</span>}
          {appt.staff?.name && <span className="text-gray-500"> · with {appt.staff.name}</span>}
        </p>
      </>
    );
  })();

  return (
    <div className={`group border rounded-xl p-4 flex flex-col sm:flex-row sm:items-start gap-4 hover:shadow-sm transition-[border-color,box-shadow] ${selected ? 'border-indigo-400 bg-indigo-50/30' : 'border-gray-200 hover:border-gray-300'}`}>
      {selectable && (
        <label className="flex items-start pt-1 shrink-0 cursor-pointer" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={!!selected}
            onChange={onToggleSelect}
            className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            aria-label="Select this appointment for bulk action"
          />
        </label>
      )}
      <div className="flex-1 min-w-0">
        {leftContent}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600 mt-2">
          <span className="flex items-center gap-1">
            <CalendarDot />
            <span className="font-medium text-gray-800">{dateLabel}</span>
          </span>
          <span className="flex items-center gap-1">
            <ClockDot />
            {appt.startTime} — {appt.endTime}
          </span>
          {price && (
            <span className="ml-auto sm:ml-0 flex items-center gap-1">
              <span className={`font-semibold ${discounted ? 'text-emerald-700' : 'text-gray-800'}`}>{price}</span>
              {discounted && (
                <span className="text-[10px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
                  −{formatPrice(appt.discountAmount)}
                </span>
              )}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-col sm:items-end gap-2 flex-shrink-0">
        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${statusClass}`}>
          {STATUS_LABEL[appt.status] || appt.status}
        </span>

        {!readOnly && (
          <div className="flex flex-wrap gap-2 justify-end">
            {canManage && appt.status === 'PENDING' && (
              <Btn onClick={() => onUpdate(appt.id, 'CONFIRMED')} disabled={pending} variant="primary">Confirm</Btn>
            )}
            {canManage && (appt.status === 'PENDING' || appt.status === 'CONFIRMED') && (
              <Btn onClick={() => onReschedule(appt)} disabled={pending} variant="secondary">Reschedule</Btn>
            )}
            {canManage && appt.status === 'CONFIRMED' && (
              <Btn onClick={() => onUpdate(appt.id, 'COMPLETED')} disabled={pending} variant="primary">Mark complete</Btn>
            )}
            {canManage && appt.status === 'CONFIRMED' && (
              <Btn onClick={() => onUpdate(appt.id, 'NO_SHOW')} disabled={pending} variant="warn">No-show</Btn>
            )}
            {canWriteDocument && onWritePrescription && (
              <Btn onClick={() => onWritePrescription(appt)} disabled={pending} variant="primary">{appt.prescription ? 'Edit Rx' : 'Write Rx'}</Btn>
            )}
            {canCancel && (appt.status === 'PENDING' || appt.status === 'CONFIRMED') && (
              <Btn onClick={() => onUpdate(appt.id, 'CANCELLED')} disabled={pending} variant="danger">Cancel</Btn>
            )}
            {onOpenDetail && (
              <Btn onClick={() => onOpenDetail(appt)} variant="ghost">Details</Btn>
            )}
          </div>
        )}
        {readOnly && (onOpenDetail || (canWriteDocument && onWritePrescription)) && (
          <div className="flex justify-end gap-2">
            {canWriteDocument && onWritePrescription && (
              <Btn onClick={() => onWritePrescription(appt)} disabled={pending} variant="primary">{appt.prescription ? 'Edit Rx' : 'Write Rx'}</Btn>
            )}
            {onOpenDetail && <Btn onClick={() => onOpenDetail(appt)} variant="ghost">Details</Btn>}
          </div>
        )}
      </div>
    </div>
  );
}

function CalendarDot() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

function ClockDot() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

function Btn({ onClick, disabled, variant, children }) {
  const base = 'px-3 py-1.5 text-xs font-semibold rounded-lg disabled:opacity-50 transition-colors';
  const style = variant === 'danger'
    ? { className: 'text-red-600 border border-red-300 hover:bg-red-50' }
    : variant === 'warn'
      ? { className: 'text-rose-700 border border-rose-300 hover:bg-rose-50' }
      : variant === 'secondary'
        ? { className: 'text-gray-700 border border-gray-300 hover:bg-gray-50' }
      : variant === 'ghost'
        ? { className: 'text-gray-600 hover:bg-gray-100' }
      : { className: '', style: { backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)' } };
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${style.className || ''}`} style={style.style}>
      {children}
    </button>
  );
}

function RxCompletionPrompt({ appointment, onWriteRx, onCompleteWithoutRx, onCancel }) {
  const patient = appointment.customer || appointment.user || {};
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/50 p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-700">Prescription missing</p>
        <h3 className="mt-2 text-xl font-extrabold text-slate-950">Complete this visit without Rx?</h3>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          {patient.name || 'This patient'} does not have a saved prescription yet. You can write it now, or complete the appointment and send the invoice only.
        </p>
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
          If you add or update the prescription after completion, the patient will receive a separate prescription email.
        </div>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100">
            Cancel
          </button>
          <button type="button" onClick={onCompleteWithoutRx} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50">
            Complete without Rx
          </button>
          <button type="button" onClick={onWriteRx} className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-bold text-white hover:bg-teal-800">
            Write Rx now
          </button>
        </div>
      </div>
    </div>
  );
}

// Doctor-clinic "Complete Consultation" workspace. Doctor identity is
// auto-stamped READ-ONLY from the prescribing staff profile (the doctor can
// never type their own identity) — the backend re-derives the authoritative
// identity on issue. Two actions: "Issue & complete consultation" (POST
// /consultation — Rx + numbered invoice + payment + COMPLETED + patient email)
// and "Save draft" (PUT /prescription — DRAFT, no complete). Gated to
// doctor_clinic by canUsePrescriptionWorkflow at the call site.
function PrescriptionModal({ appointment, onClose, onDraftSaved, onCompleted, completeAfterSave = false }) {
  const patient = appointment.customer || appointment.user || {};
  const savedPrescription = appointment.prescription || null;
  const savedClinical = savedPrescription?.clinical || {};
  const [complaint, setComplaint] = useState(savedClinical.complaint || appointment.notes || '');
  const [diagnosis, setDiagnosis] = useState(savedClinical.diagnosis || '');
  const [vitals, setVitals] = useState(savedClinical.vitalsData || { bp: '', pulse: '', temp: '', spo2: '', weight: '' });
  const [advice, setAdvice] = useState(savedClinical.advice || '');
  const [followUp, setFollowUp] = useState(savedClinical.followUpDate || savedClinical.followUp || '');
  const [tests, setTests] = useState(savedClinical.tests || '');
  const [medicines, setMedicines] = useState(
    Array.isArray(savedPrescription?.medicines) && savedPrescription.medicines.length
      ? savedPrescription.medicines
      : [{ name: '', strength: '', dose: '', frequency: '', duration: '', timing: 'After food', instructions: '' }]
  );

  // ── Payment / invoice ──
  const apptFee = appointment.finalPrice ?? appointment.originalPrice ?? appointment.service?.price ?? appointment.staff?.consultationFee ?? '';
  const [fee, setFee] = useState(apptFee === '' || apptFee == null ? '' : String(apptFee));
  const [payMethod, setPayMethod] = useState(appointment.paymentMethod || 'Cash');
  const [collected, setCollected] = useState(appointment.paymentStatus === 'PAID');
  const [extras, setExtras] = useState([]); // [{ label, amount }]

  // ── Templates + medicine autocomplete ──
  const [templates, setTemplates] = useState([]);
  const [medicineSuggestions, setMedicineSuggestions] = useState([]);

  const [saving, setSaving] = useState(false);   // POST /consultation
  const [savingDraft, setSavingDraft] = useState(false); // PUT /prescription
  const [saveError, setSaveError] = useState('');
  const [draftSavedAt, setDraftSavedAt] = useState(savedPrescription?.updatedAt || savedPrescription?.issuedAt || null);

  // Read-only doctor identity from the appointment's prescribing staff. The
  // panel's appointment list only carries name/subtitle/signature; the full
  // qualification / registration / fee are stamped server-side on issue.
  const doctor = appointment.staff || {};
  const doctorName = doctor.name || 'Doctor';
  const doctorQualification = doctor.qualification || '';
  const doctorReg = doctor.registrationNumber || '';
  const doctorSpeciality = doctor.speciality || doctor.subtitle || '';
  const clinicName = appointment.business?.name || 'Clinic';

  const dateLabel = formatDate(appointment.date);
  const serviceName = appointment.service?.name || 'Consultation';

  // Load the doctor's favourite Rx templates + common-medicine list once.
  useEffect(() => {
    let cancelled = false;
    axios.get('/api/appointments/rx/templates', { withCredentials: true })
      .then(({ data }) => { if (!cancelled) setTemplates(Array.isArray(data.templates) ? data.templates : []); })
      .catch(() => {});
    axios.get('/api/appointments/rx/medicines', { withCredentials: true })
      .then(({ data }) => { if (!cancelled) setMedicineSuggestions(Array.isArray(data.medicines) ? data.medicines : []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  function updateMedicine(index, field, value) {
    setMedicines((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  }
  function addMedicine() {
    setMedicines((rows) => [...rows, { name: '', strength: '', dose: '', frequency: '', duration: '', timing: 'After food', instructions: '' }]);
  }
  function removeMedicine(index) {
    setMedicines((rows) => (rows.length === 1 ? rows : rows.filter((_, i) => i !== index)));
  }
  function updateVitals(field, value) {
    setVitals((prev) => ({ ...prev, [field]: value }));
  }

  // Fetch name suggestions as the doctor types a medicine (autocomplete).
  function onMedicineNameType(index, value) {
    updateMedicine(index, 'name', value);
    const q = String(value || '').trim();
    if (q.length < 2) return;
    axios.get(`/api/appointments/rx/medicines?q=${encodeURIComponent(q)}`, { withCredentials: true })
      .then(({ data }) => { if (Array.isArray(data.medicines)) setMedicineSuggestions(data.medicines); })
      .catch(() => {});
  }

  function addExtra() { setExtras((prev) => [...prev, { label: '', amount: '' }]); }
  function updateExtra(i, field, value) { setExtras((prev) => prev.map((x, idx) => (idx === i ? { ...x, [field]: value } : x))); }
  function removeExtra(i) { setExtras((prev) => prev.filter((_, idx) => idx !== i)); }

  // Only medicines with at least one filled field are sent.
  const nonEmptyMedicines = medicines.filter((m) => m.name || m.strength || m.dose || m.frequency || m.duration || m.instructions);
  const rxRows = nonEmptyMedicines.length ? nonEmptyMedicines : medicines;
  const vitalsText = [
    vitals.bp && `BP ${vitals.bp}`,
    vitals.pulse && `Pulse ${vitals.pulse}`,
    vitals.temp && `Temp ${vitals.temp}`,
    vitals.spo2 && `SpO2 ${vitals.spo2}`,
    vitals.weight && `Wt ${vitals.weight}`,
  ].filter(Boolean).join(' · ');

  // Clinical payload aligned to the backend contract (followUpDate + a vitals
  // string), while also keeping vitalsData/followUp so the DRAFT round-trips.
  function clinicalPayload() {
    return {
      complaint,
      diagnosis,
      vitals: vitalsText,
      vitalsData: vitals,
      tests,
      advice,
      followUpDate: followUp,
      followUp,
    };
  }

  const feeNumber = Number(fee) || 0;
  const extraTotal = extras.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const invoiceTotal = Math.round((feeNumber + extraTotal) * 100) / 100;

  function applyTemplate(template) {
    if (!template) return;
    if (Array.isArray(template.medicines) && template.medicines.length) {
      setMedicines(template.medicines.map((m) => ({
        name: m.name || '', strength: m.strength || '', dose: m.dose || '',
        frequency: m.frequency || '', duration: m.duration || '',
        timing: m.timing || 'After food', instructions: m.instructions || '',
      })));
    }
    const c = template.clinical || {};
    if (c.complaint != null) setComplaint(c.complaint);
    if (c.diagnosis != null) setDiagnosis(c.diagnosis);
    if (c.advice != null) setAdvice(c.advice);
    if (c.tests != null) setTests(c.tests);
    if (c.followUpDate != null || c.followUp != null) setFollowUp(c.followUpDate || c.followUp || '');
    if (c.vitalsData && typeof c.vitalsData === 'object') setVitals({ bp: '', pulse: '', temp: '', spo2: '', weight: '', ...c.vitalsData });
  }

  async function saveTemplate() {
    const name = typeof window !== 'undefined' ? window.prompt('Save this Rx as a template. Name it:') : '';
    if (!name || !name.trim()) return;
    try {
      await axios.post('/api/appointments/rx/templates', {
        name: name.trim(),
        medicines: rxRows,
        clinical: clinicalPayload(),
      }, { withCredentials: true });
      const { data } = await axios.get('/api/appointments/rx/templates', { withCredentials: true });
      setTemplates(Array.isArray(data.templates) ? data.templates : []);
    } catch (err) {
      setSaveError(err.response?.data?.message || 'Could not save template');
    }
  }

  // Secondary: save a DRAFT prescription (no complete, no invoice).
  async function saveDraft() {
    setSavingDraft(true);
    setSaveError('');
    try {
      const { data } = await axios.put(`/api/appointments/${appointment.id}/prescription`, {
        patientName: patient.name || 'Patient name',
        patientContact: patient.phone || patient.email || '',
        clinical: clinicalPayload(),
        medicines: rxRows,
      }, { withCredentials: true });
      setDraftSavedAt(data.prescription?.updatedAt || data.prescription?.issuedAt || new Date().toISOString());
      await onDraftSaved?.(data.prescription);
    } catch (err) {
      setSaveError(err.response?.data?.message || 'Could not save draft');
    } finally {
      setSavingDraft(false);
    }
  }

  // Primary: issue Rx + numbered invoice, record payment, mark COMPLETED,
  // email the patient.
  async function issueAndComplete() {
    setSaving(true);
    setSaveError('');
    try {
      const items = extras
        .map((x) => ({ label: String(x.label || '').trim(), amount: Number(x.amount) || 0 }))
        .filter((x) => x.label && x.amount > 0);
      await axios.post(`/api/appointments/${appointment.id}/consultation`, {
        patientName: patient.name || 'Patient name',
        patientContact: patient.phone || patient.email || '',
        clinical: clinicalPayload(),
        medicines: rxRows,
        fee: feeNumber,
        items,
        payment: { method: payMethod, collected, paidAmount: collected ? invoiceTotal : 0 },
      }, { withCredentials: true });
      await onCompleted?.(appointment.id);
    } catch (err) {
      setSaveError(err.response?.data?.message || 'Could not complete the consultation');
    } finally {
      setSaving(false);
    }
  }

  const previewMedicines = rxRows;

  return (
    <div className="fixed inset-0 z-[60] bg-slate-950/55 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div
        className="bg-slate-50 w-full sm:max-w-7xl max-h-[94vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — title + read-only doctor identity + primary/secondary actions */}
        <div className="sticky top-0 z-10 border-b border-slate-200 bg-white px-5 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-teal-700">Complete Consultation</p>
              <h3 className="text-xl font-extrabold text-slate-950">{appointment.prescription ? 'Edit consultation' : 'Consultation workspace'}</h3>
              <p className="mt-1 text-sm text-slate-600">
                {patient.name || 'Patient'} · {serviceName} · {dateLabel} · {appointment.startTime}-{appointment.endTime}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={saveDraft}
                disabled={savingDraft || saving}
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                {savingDraft ? 'Saving…' : 'Save draft'}
              </button>
              <button
                type="button"
                onClick={issueAndComplete}
                disabled={saving || savingDraft}
                className="rounded-md bg-teal-700 px-4 py-2 text-sm font-bold text-white hover:bg-teal-800 disabled:opacity-60"
              >
                {saving ? 'Issuing…' : 'Issue & complete consultation'}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50"
              >
                Close
              </button>
            </div>
          </div>

          {/* Auto-stamped, read-only doctor identity */}
          <div className="mt-4 rounded-xl border border-teal-200 bg-teal-50/60 px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-[10px] font-black uppercase tracking-[0.14em] text-teal-700">Prescribing doctor</span>
              <span className="text-sm font-extrabold text-slate-950">{doctorName}</span>
              {doctorQualification && <span className="text-sm font-semibold text-slate-600">· {doctorQualification}</span>}
              {doctorReg && <span className="text-sm font-semibold text-slate-600">· Reg. No: {doctorReg}</span>}
              {doctorSpeciality && <span className="text-sm font-semibold text-slate-600">· {doctorSpeciality}</span>}
            </div>
            <p className="mt-1 text-[11px] font-medium text-teal-800/80">
              Identity, signature and registration are pulled from the doctor's profile and printed on the Rx — they can't be edited here.
            </p>
          </div>

          {(draftSavedAt || saveError) && (
            <div className="mt-3">
              {draftSavedAt && !saveError && <p className="text-xs font-semibold text-emerald-700">Draft saved. Patient can see this in their portal.</p>}
              {saveError && <p className="text-xs font-semibold text-red-600">{saveError}</p>}
            </div>
          )}
          {completeAfterSave && !saveError && (
            <div className="mt-3 rounded-xl border border-teal-200 bg-teal-50 px-3 py-2 text-xs font-semibold text-teal-800">
              You came here from Mark complete. "Issue & complete consultation" finalises this visit — it issues the Rx + invoice and emails the patient.
            </div>
          )}
        </div>

        <section className="grid gap-4 p-5 lg:grid-cols-2">
          {/* Templates */}
          <RxCard className="lg:col-span-2" title="Rx templates" kicker="Reusable favourites"
            action={<button type="button" onClick={saveTemplate} className="rounded-md border border-teal-300 bg-white px-3 py-1.5 text-xs font-bold text-teal-700 hover:bg-teal-50">Save as template</button>}
          >
            <label className="block max-w-md">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Load template</span>
              <select
                value=""
                onChange={(e) => { const t = templates.find((x) => x.id === e.target.value); applyTemplate(t); }}
                className="mt-1 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-teal-600"
              >
                <option value="">{templates.length ? 'Select a saved template…' : 'No templates yet — save one below'}</option>
                {templates.map((t) => (<option key={t.id} value={t.id}>{t.name}</option>))}
              </select>
            </label>
            <p className="mt-2 text-xs text-slate-500">Loading a template fills the medicines + clinical fields. You can still edit before issuing.</p>
          </RxCard>

          <RxCard title="Clinical notes" kicker="Consultation">
            <div className="grid gap-4 lg:grid-cols-2">
              <RxField label="Chief complaint" value={complaint} onChange={setComplaint} multiline placeholder="Fever, cough, pain, follow-up concern..." />
              <RxField label="Diagnosis / assessment" value={diagnosis} onChange={setDiagnosis} multiline placeholder="Working diagnosis or clinical impression" />
            </div>
          </RxCard>

          <RxCard title="Vitals" kicker="Optional but recommended">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <RxField label="BP" value={vitals.bp} onChange={(v) => updateVitals('bp', v)} placeholder="120/80" />
              <RxField label="Pulse" value={vitals.pulse} onChange={(v) => updateVitals('pulse', v)} placeholder="78/min" />
              <RxField label="Temp" value={vitals.temp} onChange={(v) => updateVitals('temp', v)} placeholder="98.6 F" />
              <RxField label="SpO2" value={vitals.spo2} onChange={(v) => updateVitals('spo2', v)} placeholder="99%" />
              <RxField label="Weight" value={vitals.weight} onChange={(v) => updateVitals('weight', v)} placeholder="70 kg" />
            </div>
          </RxCard>

          <RxCard
            className="lg:col-span-2"
            title="Medicines"
            kicker={`${medicines.length} row${medicines.length === 1 ? '' : 's'}`}
            action={<button type="button" onClick={addMedicine} className="rounded-md bg-teal-700 px-3 py-1.5 text-xs font-bold text-white">Add medicine</button>}
          >
            <datalist id="sp-rx-medicine-list">
              {medicineSuggestions.map((name) => (<option key={name} value={name} />))}
            </datalist>
            <div className="space-y-3">
              {medicines.map((medicine, index) => (
                <div key={index} className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-sm font-bold text-slate-950">Medicine {index + 1}</p>
                    <button type="button" onClick={() => removeMedicine(index)} className="text-xs font-semibold text-red-600 disabled:text-slate-300" disabled={medicines.length === 1}>Remove</button>
                  </div>
                  <div className="grid gap-3 lg:grid-cols-[1.4fr_0.8fr_0.8fr]">
                    <RxField label="Medicine name" value={medicine.name} onChange={(v) => onMedicineNameType(index, v)} placeholder="e.g. Paracetamol" listId="sp-rx-medicine-list" />
                    <RxField label="Strength" value={medicine.strength} onChange={(v) => updateMedicine(index, 'strength', v)} placeholder="500 mg" />
                    <RxField label="Dose" value={medicine.dose} onChange={(v) => updateMedicine(index, 'dose', v)} placeholder="1 tablet" />
                  </div>
                  <div className="mt-3 grid gap-3 lg:grid-cols-3">
                    <RxSelect label="Frequency" value={medicine.frequency} onChange={(v) => updateMedicine(index, 'frequency', v)}
                      options={['', 'Once daily', 'Twice daily', 'Thrice daily', '1-0-1', '1-1-1', 'SOS']} />
                    <RxField label="Duration" value={medicine.duration} onChange={(v) => updateMedicine(index, 'duration', v)} placeholder="5 days" />
                    <RxSelect label="Timing" value={medicine.timing} onChange={(v) => updateMedicine(index, 'timing', v)}
                      options={['After food', 'Before food', 'At bedtime', 'Morning', 'Evening', 'As directed']} />
                  </div>
                  <div className="mt-3">
                    <RxField label="Special instructions" value={medicine.instructions} onChange={(v) => updateMedicine(index, 'instructions', v)} placeholder="Avoid driving, complete full course..." />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {['After food', 'Before food', 'SOS', '5 days', '7 days'].map((chip) => (
                      <button
                        key={chip}
                        type="button"
                        onClick={() => {
                          if (chip === '5 days' || chip === '7 days') updateMedicine(index, 'duration', chip);
                          else if (chip === 'SOS') updateMedicine(index, 'frequency', chip);
                          else updateMedicine(index, 'timing', chip);
                        }}
                        className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:border-teal-300 hover:text-teal-700"
                      >
                        {chip}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </RxCard>

          <RxCard className="lg:col-span-2" title="Plan" kicker="Patient instructions">
            <div className="grid gap-4 lg:grid-cols-2">
              <RxField label="Tests / investigations" value={tests} onChange={setTests} multiline placeholder="CBC, HbA1c, X-ray, etc." />
              <RxField label="Advice" value={advice} onChange={setAdvice} multiline placeholder="Hydration, rest, diet, warning symptoms..." />
            </div>
            <div className="mt-4 max-w-sm">
              <RxField label="Follow-up" value={followUp} onChange={setFollowUp} placeholder="After 7 days / date" />
            </div>
          </RxCard>

          {/* Payment + invoice */}
          <RxCard className="lg:col-span-2" title="Payment & invoice" kicker="Issued on complete">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <RxField label="Consultation fee" value={fee} onChange={setFee} placeholder="0.00" type="number" />
              <RxSelect label="Payment method" value={payMethod} onChange={setPayMethod}
                options={['Cash', 'Card', 'UPI', 'Online', 'Insurance', 'Other']} />
              <label className="flex items-end gap-2 pb-2">
                <input type="checkbox" checked={collected} onChange={(e) => setCollected(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-teal-700 focus:ring-teal-600" />
                <span className="text-sm font-semibold text-slate-700">Payment collected</span>
              </label>
              <div className="flex items-end pb-1">
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Invoice total</p>
                  <p className="text-sm font-extrabold text-slate-900">{invoiceTotal.toFixed(2)}</p>
                </div>
              </div>
            </div>
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Extra invoice lines (optional)</span>
                <button type="button" onClick={addExtra} className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-slate-700 hover:bg-slate-50">Add line</button>
              </div>
              {extras.length === 0 && <p className="text-xs text-slate-400">e.g. procedure, dressing, lab draw — these are added to the invoice.</p>}
              <div className="space-y-2">
                {extras.map((x, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input value={x.label} onChange={(e) => updateExtra(i, 'label', e.target.value)} placeholder="Line item label" className="flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-teal-600" />
                    <input value={x.amount} onChange={(e) => updateExtra(i, 'amount', e.target.value)} placeholder="0.00" type="number" className="w-28 rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-teal-600" />
                    <button type="button" onClick={() => removeExtra(i)} className="px-2 text-xs font-semibold text-red-600">Remove</button>
                  </div>
                ))}
              </div>
            </div>
          </RxCard>
        </section>

        {/* Clean read-only Rx preview — header generated from doctor + clinic */}
        <section className="border-t border-slate-200 bg-slate-100 p-5">
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Rx preview</p>
          <div className="mx-auto max-w-[680px]">
            <RxPreview
              clinicName={clinicName}
              doctorName={doctorName}
              doctorQualification={doctorQualification}
              doctorReg={doctorReg}
              doctorSpeciality={doctorSpeciality}
              patientName={patient.name || 'Patient name'}
              patientContact={patient.phone || patient.email || ''}
              dateLabel={dateLabel}
              complaint={complaint}
              diagnosis={diagnosis}
              vitalsText={vitalsText}
              tests={tests}
              advice={advice}
              followUp={followUp}
              medicines={previewMedicines}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

// Clean, read-only A4-style Rx preview. The letterhead header is GENERATED
// from the (immutable) doctor identity + clinic — there is no editable
// letterhead in the doctor Rx flow.
function RxPreview({ clinicName, doctorName, doctorQualification, doctorReg, doctorSpeciality, patientName, patientContact, dateLabel, complaint, diagnosis, vitalsText, tests, advice, followUp, medicines = [] }) {
  const teal = '#0F766E';
  return (
    <article className="mx-auto w-full overflow-hidden rounded-xl border border-slate-200 bg-white p-8 shadow-sm" style={{ fontFamily: 'Inter, Arial, sans-serif' }}>
      <div className="flex items-start justify-between gap-4 border-b-2 pb-3" style={{ borderColor: teal }}>
        <div>
          <p className="text-xl font-black tracking-tight text-slate-950">{clinicName}</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-extrabold text-slate-950">{doctorName}</p>
          {(doctorQualification || doctorSpeciality) && (
            <p className="text-xs text-slate-500">{[doctorQualification, doctorSpeciality].filter(Boolean).join(' · ')}</p>
          )}
          {doctorReg && <p className="text-xs text-slate-500">Reg. No: {doctorReg}</p>}
        </div>
      </div>

      <div className="mt-3 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-slate-950">{patientName}</p>
          {patientContact && <p className="text-xs text-slate-500">{patientContact}</p>}
        </div>
        <p className="text-xs text-slate-500">{dateLabel}</p>
      </div>

      <p className="mt-4 font-serif text-3xl" style={{ color: teal }}>℞</p>

      <div className="mt-3 space-y-2 text-sm">
        {complaint && <RxPreviewBlock label="Complaint" value={complaint} />}
        {vitalsText && <RxPreviewBlock label="Vitals" value={vitalsText} />}
        {diagnosis && <RxPreviewBlock label="Diagnosis" value={diagnosis} />}
      </div>

      <div className="mt-5">
        <p className="text-base font-extrabold text-slate-950">Medicines</p>
        <div className="mt-2 overflow-hidden rounded-lg border border-slate-200">
          {medicines.length === 0 && <p className="p-3 text-xs text-slate-400">No medicines added.</p>}
          {medicines.map((medicine, index) => (
            <div key={index} className="border-b border-slate-100 p-3 last:border-b-0">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ backgroundColor: teal }}>{index + 1}</span>
                <div className="min-w-0">
                  <p className="font-bold text-slate-950">
                    {medicine.name || 'Medicine name'} {medicine.strength ? <span className="font-semibold text-slate-600">{medicine.strength}</span> : null}
                  </p>
                  <p className="mt-1 text-xs text-slate-700">
                    {[medicine.dose, medicine.frequency, medicine.duration, medicine.timing].filter(Boolean).join(' · ') || 'Dose · frequency · duration · timing'}
                  </p>
                  {medicine.instructions && <p className="mt-1 text-xs text-slate-500">{medicine.instructions}</p>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {(tests || advice || followUp) && (
        <div className="mt-5 space-y-2 text-sm">
          {tests && <RxPreviewBlock label="Tests" value={tests} />}
          {advice && <RxPreviewBlock label="Advice" value={advice} />}
          {followUp && <RxPreviewBlock label="Follow-up" value={followUp} />}
        </div>
      )}

      <div className="mt-8 flex justify-end">
        <div className="w-44 border-t border-slate-400 pt-2 text-center text-xs font-semibold text-slate-600">
          <span>{doctorName}</span>
          <span className="mt-0.5 block text-[10px] font-medium text-slate-400">Signature on issued Rx</span>
        </div>
      </div>
    </article>
  );
}

function RxPreviewBlock({ label, value }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 whitespace-pre-wrap leading-6 text-slate-900">{value}</p>
    </div>
  );
}

function RxCard({ title, kicker, action, children, className = '' }) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          {kicker && <p className="text-xs font-bold uppercase tracking-wide text-teal-700">{kicker}</p>}
          <h4 className="mt-1 text-base font-extrabold text-slate-950">{title}</h4>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function RxSelect({ label, value, onChange, options }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-teal-600"
      >
        {options.map((option) => (
          <option key={option || 'blank'} value={option}>{option || 'Select'}</option>
        ))}
      </select>
    </label>
  );
}

function RxField({ label, value, onChange, placeholder = '', multiline = false, type = 'text', listId = undefined }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none resize-none focus:border-teal-600"
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          type={type}
          list={listId}
          inputMode={type === 'number' ? 'decimal' : undefined}
          className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-teal-600"
        />
      )}
    </label>
  );
}

function RescheduleModal({ appt, form, saving, onChange, onClose, onSubmit }) {
  const [daySchedule, setDaySchedule] = useState(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState('');

  // Fetch the full day grid every time the selected date changes
  useEffect(() => {
    if (!form.date || !appt.id) return;
    let cancelled = false;
    setScheduleLoading(true);
    setScheduleError('');
    (async () => {
      try {
        const { data } = await axios.get(
          `/api/appointments/${appt.id}/reschedule-slots?date=${encodeURIComponent(form.date)}`,
          { withCredentials: true },
        );
        if (!cancelled) setDaySchedule(data);
      } catch (err) {
        if (!cancelled) setScheduleError(err.response?.data?.message || 'Could not load the schedule for that day');
      } finally {
        if (!cancelled) setScheduleLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [form.date, appt.id]);

  function pickSlot(slot) {
    onChange({ startTime: slot.startTime, endTime: slot.endTime });
  }

  const selectedStart = form.startTime;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl border border-gray-200 shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 pt-6 pb-4 border-b border-gray-100 sticky top-0 bg-white z-10">
          <h3 className="text-lg font-semibold text-gray-900">Reschedule appointment</h3>
          <p className="mt-1 text-sm text-gray-500">
            {appt.service?.name || 'Appointment'} with {appt.customer?.name || appt.user?.name || 'Customer'}
          </p>
        </div>

        <div className="p-6 space-y-5">
          <label className="block max-w-xs">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Date</span>
            <input
              type="date"
              value={form.date}
              min={new Date().toISOString().slice(0, 10)}
              onChange={(e) => onChange({ date: e.target.value, startTime: '', endTime: '' })}
              className="mt-1.5 w-full px-3 py-2.5 border border-gray-300 rounded-xl text-sm"
            />
          </label>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Pick a time</span>
              <Legend />
            </div>

            {scheduleLoading && <div className="py-6 flex justify-center"><Spinner /></div>}
            {scheduleError && <p className="text-sm text-red-600">{scheduleError}</p>}

            {!scheduleLoading && !scheduleError && daySchedule && daySchedule.closed && (
              <div className="border border-dashed border-gray-200 rounded-xl py-8 text-center text-sm text-gray-500">
                {daySchedule.reason || 'Closed on this day.'}
              </div>
            )}

            {!scheduleLoading && !scheduleError && daySchedule && !daySchedule.closed && (
              <SlotGrid slots={daySchedule.slots || []} selectedStart={selectedStart} onPick={pickSlot} duration={daySchedule.serviceDurationMin} />
            )}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex items-center justify-between gap-3 sticky bottom-0">
          <p className="text-xs text-gray-600">
            {form.startTime ? (
              <>New time: <span className="font-semibold text-gray-900">{form.startTime} – {form.endTime}</span></>
            ) : (
              <>Select a green slot above to continue</>
            )}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2.5 rounded-xl border border-gray-300 text-sm font-semibold text-gray-700 hover:border-gray-900 disabled:opacity-50 bg-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSubmit}
              disabled={saving || !form.startTime}
              className="px-4 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
              style={{ backgroundColor: 'var(--theme-primary)' }}
            >
              {saving ? 'Saving…' : 'Save new time'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Legend() {
  const items = [
    { label: 'Free',    cls: 'bg-emerald-50 border-emerald-200 text-emerald-700' },
    { label: 'Booked',  cls: 'bg-gray-100 border-gray-200 text-gray-400 line-through' },
    { label: 'Current', cls: 'bg-indigo-50 border-indigo-300 text-indigo-700' },
    { label: 'Closed',  cls: 'bg-gray-50 border-gray-200 text-gray-300' },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2 text-[10px]">
      {items.map((it) => (
        <span key={it.label} className={`px-2 py-0.5 rounded border font-medium ${it.cls}`}>{it.label}</span>
      ))}
    </div>
  );
}

function SlotGrid({ slots, selectedStart, onPick, duration }) {
  if (!slots.length) {
    return <p className="text-sm text-gray-500">No slots available for this day.</p>;
  }
  // Detect the adjacent-booking hint: if an empty slot is directly
  // before/after a busy one, flag it as "fills a gap" to nudge the
  // operator toward tighter scheduling.
  const busyStarts = new Set(slots.filter((s) => s.status === 'busy').map((s) => s.startTime));
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
      {slots.map((s) => {
        const isSelected = selectedStart === s.startTime && s.status !== 'busy' && s.status !== 'closed' && s.status !== 'lunch';
        const fillsGap = s.status === 'free' && (busyStarts.has(addMinutes(s.startTime, duration)) || busyEndsAt(slots, s.startTime));
        return <SlotCell key={s.startTime} slot={s} isSelected={isSelected} fillsGap={fillsGap} onPick={onPick} />;
      })}
    </div>
  );
}

function SlotCell({ slot, isSelected, fillsGap, onPick }) {
  const base = 'relative rounded-lg border px-2 py-2 text-xs font-semibold text-left transition-colors';
  if (slot.status === 'free') {
    const sel = isSelected
      ? 'bg-indigo-600 text-white border-indigo-600'
      : 'bg-emerald-50 border-emerald-200 text-emerald-800 hover:bg-emerald-100 hover:border-emerald-300';
    return (
      <button type="button" onClick={() => onPick(slot)} className={`${base} ${sel}`} title={fillsGap ? 'Fills a gap — tight schedule' : ''}>
        <span className="block">{slot.startTime}</span>
        {fillsGap && !isSelected && (
          <span className="absolute -top-1 -right-1 bg-amber-500 text-white text-[9px] px-1 rounded-full">fills gap</span>
        )}
      </button>
    );
  }
  if (slot.status === 'current') {
    return (
      <button type="button" onClick={() => onPick(slot)} className={`${base} bg-indigo-50 border-indigo-300 text-indigo-700 hover:bg-indigo-100`} title="Current time">
        <span className="block">{slot.startTime}</span>
        <span className="block text-[9px] font-medium opacity-70">now</span>
      </button>
    );
  }
  if (slot.status === 'busy') {
    return (
      <div
        className={`${base} bg-gray-100 border-gray-200 text-gray-400 line-through cursor-not-allowed`}
        title={slot.appointment ? `${slot.appointment.serviceName || 'Booked'} — ${slot.appointment.customerName}` : 'Booked'}
      >
        <span className="block">{slot.startTime}</span>
        {slot.appointment?.customerName && (
          <span className="block text-[9px] font-normal truncate no-underline text-gray-500">{slot.appointment.customerName}</span>
        )}
      </div>
    );
  }
  if (slot.status === 'lunch') {
    return (
      <div className={`${base} bg-amber-50 border-amber-200 text-amber-700 cursor-not-allowed`} title="Lunch break">
        <span className="block">{slot.startTime}</span>
        <span className="block text-[9px] font-normal opacity-70">lunch</span>
      </div>
    );
  }
  // closed
  return (
    <div className={`${base} bg-gray-50 border-gray-200 text-gray-300 cursor-not-allowed`}>
      <span className="block">{slot.startTime}</span>
    </div>
  );
}

function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + mins;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function busyEndsAt(slots, startTime) {
  // Does any busy slot's endTime equal this free slot's startTime? If so,
  // picking this slot plugs directly against a booked block.
  return slots.some((s) => s.status === 'busy' && s.appointment?.endTime === startTime);
}

function Spinner() {
  return (
    <svg className="animate-spin h-6 w-6 text-indigo-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}
