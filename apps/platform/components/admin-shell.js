'use client';

import { Component, useCallback, useEffect, useMemo, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { COUNTRIES, DEFAULT_COUNTRY, addressPlaceholderFor, timezonesFor, defaultTimezoneFor } from '@/lib/countries';
import { getTenantStorefrontUrl } from '@/lib/platformDomain';
import { fireConfetti } from '@/lib/confetti';
import { useTenant } from '@/components/TenantProvider';
import { useConfirm } from '@/components/ConfirmDialog';
import { resolveVertical } from '@/lib/vertical';
import LogoutButton from '@/components/LogoutButton';
import LanguageSelector from '@/components/LanguageSelector';
import EcommerceLocationSwitcher, { EcommerceLocationProvider } from '@/components/EcommerceLocationSwitcher';
import EcommerceAdminShell from '@/components/EcommerceAdminShell';
import AapkaChatActionWidget from '@/components/AapkaChatActionWidget';
import EcommerceOverviewTab from '@/components/admin-tabs/EcommerceOverviewTab';
import AppointmentsPanel from '@/components/AppointmentsPanel';
import WalkInsPanel from '@/components/WalkInsPanel';
import EmailDeliveryHistoryPanel from '@/components/EmailDeliveryHistoryPanel';
import NotificationInboxPanel from '@/components/NotificationInboxPanel';
import { THEMES, getThemeVars, resolveThemeKey, getThemesByCategory, composeTheme } from '@/lib/themes';
import { STYLES, STYLE_KEYS, DEFAULT_STYLE_KEY } from '@/lib/themeStyles';
import { COLOR_PRESETS, parseThemeColors, sanitizeColorOverrides, isValidHex } from '@/lib/themeColors';
import ContentEditor from '@/components/ContentEditor';
import PagesPanel from '@/components/PagesPanel';
import ProductsPanel from '@/components/ProductsPanel';
import CategoriesPanel from '@/components/CategoriesPanel';
import OrdersPanel from '@/components/OrdersPanel';
import BlogPanel from '@/components/BlogPanel';
import LocationsPanel from '@/components/LocationsPanel';
import StoreSetupHub from '@/components/admin-tabs/StoreSetupHub';
import MessagingPanel from '@/components/MessagingPanel';
import MarketingAutomationPanel from '@/components/MarketingAutomationPanel';
import IntakeFormBuilder from '@/components/IntakeFormBuilder';
import TrialBanner from '@/components/TrialBanner';
import {
  LAYOUT_PRESETS,
  DEFAULT_PRESET_KEY,
  AVAILABLE_VARIANTS,
  VARIANT_LABELS,
  SECTION_LABELS,
} from '@/lib/layoutPresets';
import { redirectToLogin } from '@/lib/loginRedirect';
import { api } from '@/lib/adminApi';
import {
  Spinner, Centered, ErrorBanner, Modal, ModalActions, PrimaryButton,
  TextInput, TextArea,
  formatAdminDate, formatAdminDateTime, formatMoneyMinor,
  billingStatusClass, billingTransactionStatusClass, capitalizeSlug,
} from '@/components/admin-ui';
import LaunchChecklist from '@/components/admin-tabs/LaunchChecklist';
import SubscriptionTab from '@/components/admin-tabs/SubscriptionTab';
import IntegrationsTab from '@/components/admin-tabs/IntegrationsTab';
import HoursAndHolidaysTab from '@/components/admin-tabs/HoursAndHolidaysTab';
import CouponsTab from '@/components/admin-tabs/CouponsTab';
import LeaveRequestsTab from '@/components/admin-tabs/LeaveRequestsTab';
import MyAvailabilityTab from '@/components/admin-tabs/MyAvailabilityTab';
import ReportsTab from '@/components/admin-tabs/ReportsTab';
import WaitlistTab from '@/components/admin-tabs/WaitlistTab';
import EmbedTab from '@/components/admin-tabs/EmbedTab';
import EmailUpdatesTab from '@/components/admin-tabs/EmailUpdatesTab';
import NotificationsInboxTab, { NotificationsBell } from '@/components/admin-tabs/NotificationsInboxTab';
import EnquiriesTab from '@/components/admin-tabs/EnquiriesTab';
import StaffTab from '@/components/admin-tabs/StaffTab';
import ServicesTab from '@/components/admin-tabs/ServicesTab';
import SpecialtiesTab from '@/components/admin-tabs/SpecialtiesTab';
import DoctorReviewsTab from '@/components/admin-tabs/DoctorReviewsTab';
import DoctorSectionsTab from '@/components/admin-tabs/DoctorSectionsTab';
import RemindersTab from '@/components/admin-tabs/RemindersTab';
import TeamTab from '@/components/admin-tabs/TeamTab';
import CustomersTab from '@/components/admin-tabs/CustomersTab';
import RestaurantHostStandPanel from '@/components/admin-tabs/RestaurantHostStandPanel';
import RestaurantTablesPanel from '@/components/admin-tabs/RestaurantTablesPanel';
import RestaurantGuestsPanel from '@/components/admin-tabs/restaurant/GuestsPanel';
import RestaurantRevenuePanel from '@/components/admin-tabs/restaurant/RevenuePanel';
import DoctorPrescriptionsTab from '@/components/admin-tabs/doctor-clinic/PrescriptionsTab';
import LawFirmConflictChecksTab from '@/components/admin-tabs/law-firm/ConflictChecksTab';
import LawFirmDocumentsTab from '@/components/admin-tabs/law-firm/DocumentsTab';
import LawFirmMattersTab from '@/components/admin-tabs/law-firm/MattersTab';
import LawFirmRevenuePanel from '@/components/admin-tabs/law-firm/RevenuePanel';
import WaterContractsTab from '@/components/admin-tabs/water-purifier/ContractsTab';
import WaterServiceVisitsPanel from '@/components/admin-tabs/water-purifier/ServiceVisitsPanel';
import WaterDispatchPanel from '@/components/admin-tabs/water-purifier/DispatchPanel';
import WaterRevenuePanel from '@/components/admin-tabs/water-purifier/RevenuePanel';
// ECOMMERCE Path B (2026-05-01) — grocery seller console panels.
// Stubs today, real implementations port from `Grocery E-Commerce/<slug>.html`.
import InventoryPanel from '@/components/admin-tabs/InventoryPanel';
import EcommerceCouponsPanel from '@/components/admin-tabs/EcommerceCouponsPanel';
import BannersPanel from '@/components/admin-tabs/BannersPanel';
import CmsPanel from '@/components/admin-tabs/CmsPanel';
import EcommerceNotificationsPanel from '@/components/admin-tabs/EcommerceNotificationsPanel';
import DomainsTab from '@/components/admin-tabs/DomainsTab';
import ReviewsPanel from '@/components/admin-tabs/ReviewsPanel';
import PoliciesPanel from '@/components/admin-tabs/PoliciesPanel';
import SlotsPanel from '@/components/admin-tabs/SlotsPanel';
import PickupLocationsPanel from '@/components/admin-tabs/PickupLocationsPanel';
import DispatchPanel from '@/components/admin-tabs/DispatchPanel';
import BrandsPanel from '@/components/admin-tabs/BrandsPanel';
import ReturnsPanel from '@/components/admin-tabs/ReturnsPanel';
import BulkOpsPanel from '@/components/admin-tabs/BulkOpsPanel';
import PaymentsPanel from '@/components/admin-tabs/PaymentsPanel';
import EcommerceReportsPanel from '@/components/admin-tabs/EcommerceReportsPanel';
import TaxPanel from '@/components/admin-tabs/TaxPanel';
import CitiesPanel from '@/components/admin-tabs/CitiesPanel';
import RolesPermissionsPanel from '@/components/admin-tabs/RolesPermissionsPanel';
import EcommerceStaffPanel from '@/components/admin-tabs/EcommerceStaffPanel';
import ActivityLogPanel from '@/components/admin-tabs/ActivityLogPanel';
import VideoIntegrationsCard from '@/components/admin-cards/VideoIntegrationsCard';
import SettingsTab from '@/components/admin-tabs/SettingsTab';
import WebsiteContentTab from '@/components/admin-tabs/WebsiteContentTab';
import EcommerceStorefrontPanel from '@/components/admin-tabs/EcommerceStorefrontPanel';
import { ThemePickerCard, ThemeStylePickerCard, ThemeColorPickerCard, HexInput } from '@/components/admin-pickers';
import { useTranslations } from 'next-intl';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';

// ---------------- Nav metadata (shared by top nav + page header) ----------------
// NAV_ITEMS is built inside BusinessAdminContent using useTranslations('adminNav').

// Hidden keys that are still valid tab values. Keep this vertical-scoped so
// a STATIC/web tenant cannot deep-link into booking-only legacy tabs such as
// coupons or embed.
const HIDDEN_TAB_KEYS_BY_VERTICAL = {
  STATIC: ['notifications', 'reports'],
  APPOINTMENT: ['notifications', 'emails', 'reports', 'coupons', 'embed'],
  // locations/slots/pickup-locations/cities are folded into Store Setup but
  // stay valid keys so the hub's Advanced deep-links + old bookmarks resolve.
  // 'dispatch' is folded into Fulfillment (OrdersPanel already has the dispatch
  // bar + rider routing); it stays a valid key so old ?tab=dispatch links resolve.
  // 'developers' now lives inside Integrations as API & webhooks.
  ECOMMERCE: ['notifications', 'locations', 'slots', 'pickup-locations', 'cities', 'dispatch', 'developers'],
};

// The global location switcher scopes branch-level panels (orders, inventory,
// slots, payments, products, ...). It does nothing on business-level
// tabs that configure or apply across ALL locations at once, so we hide it
// there — otherwise it reads as a filter that silently has no effect. Verified:
// each of these panels does NOT consume useEcommerceLocation().
const LOCATION_SWITCHER_HIDDEN_TABS = new Set([
  'store-setup', 'subscription', 'domains', 'settings', 'tax', 'pages', 'blog', 'content',
]);

function BusinessAdminContent() {
  const {
    tenant,
    loading: tenantLoading,
    error: tenantError,
    refresh: refreshTenant,
  } = useTenant();
  // Billing state machine: 'onboarding' (never paid) | 'active' | 'grace'
  // (overdue, still in the dunning window) | 'expired' (lapsed past grace).
  //  - expired  → lock the whole dashboard to Billing + Data Export.
  //  - grace    → keep full access but show a persistent "pay now" countdown.
  //  - onboarding → bounce to /onboarding (handled by the effect below).
  const billingState = tenant?.billingState || (tenant?.needsRenewal ? 'expired' : null);
  const mustRenew = billingState === 'expired';
  const inGrace = billingState === 'grace';
  const graceUntil = tenant?.graceUntil || null;
  const tNav = useTranslations('adminNav');
  const searchParams = useSearchParams();
  const router = useRouter();
  const confirm = useConfirm();


  // `notifications` is no longer a full sidebar tab — it lives as a bell icon
  // in the header — but the key stays valid so existing bookmarks work.
  // `customers` replaces the old `emails` key.
  // Top-level navigation (2026-04-27 product call):
  //   - waitlist promoted up to right after appointments (related concepts)
  //   - reports merged into overview (analytics now live there)
  //   - coupons + embed demoted into Settings as sub-tabs
  // Old ?tab=reports / ?tab=coupons / ?tab=embed URLs still resolve via
  // HIDDEN_TAB_KEYS — they redirect to the new home.
  // Full set of admin nav items. Each vertical sees a curated subset
  // (VERTICAL_NAV_KEYS below). Vertical isolation is a first-class principle:
  // a STATIC customer never sees Appointments / Services / Team / Waitlist.
  // An ECOMMERCE customer never sees Appointments / Services / Team /
  // Waitlist either (their world is Orders / Products / Categories — those
  // tabs land in Phase E2; until then they see the shared subset only).
  // Theme-driven label override. Backend (/api/tenant/resolve) returns
  // tenant.themeVocab.{appointments,services,team,customers} for themes
  // that ship hand-curated vocabulary (e.g. water_purifier → "Service
  // Visits / Service Plans / Technicians / Subscribers"). Falls back to
  // the i18n label whenever a key is absent — so default-themed tenants
  // see the existing copy unchanged.
  const themeVocab = tenant?.themeVocab || null;
  const navLabel = (key, fallback) => themeVocab?.[key] || fallback;
  const tenantVertical = resolveVertical(tenant?.business?.vertical);
  const themeKey = String(tenant?.subscription?.theme || tenant?.theme || '').toLowerCase();
  const categoryKey = String(tenant?.business?.category || tenant?.business?.profession || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const isRestaurantReservations = themeKey === 'restaurant_reservations' || ['restaurant_bookings', 'restaurant_reservations', 'restaurant'].includes(categoryKey);
  const isLawFirmTheme = themeKey === 'law_firm' || ['law_firm', 'lawyer', 'legal', 'legal_services'].includes(categoryKey);
  // Strict theme match: the Rx / consultation workflow (AppointmentsPanel,
  // SettingsTab) and the backend consultation endpoints are all gated to the
  // 'doctor_clinic' THEME. Matching broader categories (dentist/medical/…) here
  // only ever surfaced a Prescriptions tab the rest of the stack won't deliver.
  const isDoctorClinic = themeKey === 'doctor_clinic';
  const isWaterPurifier = themeKey === 'water_purifier';
  const lawFirmConfig = useMemo(() => ({
    documents: {
      feeBases: ['Fixed fee', 'Hourly rate', 'Conditional (no win, no fee)', 'Retainer', 'Estimate only'],
    },
  }), []);
  // Team-tab vocab per vertical. StaffTab's built-in default is doctor-flavoured
  // with the Rx/clinical-identity section ON — correct ONLY for doctor_clinic.
  // Law / water-purifier / generic booking must get neutral copy with that
  // medical section (documentIdentityEnabled) OFF, or registration-number /
  // qualification / signature fields leak onto non-medical staff editors.
  const genericStaffLabels = useMemo(() => ({
    eyebrow: 'Team access',
    title: 'Team and front desk',
    description: 'Manage who takes bookings, who handles walk-ins and payments, and who appears on your website.',
    invite: '+ Invite team member',
    bookableStat: 'Bookable team',
    frontDeskStat: 'Front desk',
    bookableFilter: 'Bookable',
    emptyTitle: 'Invite your first team member',
    emptyBody: 'Add people who can take bookings, appear on the website, and handle service.',
    emptyButton: 'Invite team member',
    unnamed: 'Unnamed team member',
    bookingsToggle: 'Bookings',
    profileEyebrow: 'Team profile',
    profileFallback: 'New team member',
    titlePlaceholder: 'e.g. Senior Technician, Service Manager',
    aboutPlaceholder: 'Experience, skills, and the services this person handles.',
    inviteModalTitle: 'Invite team member',
    inviteHelp: "We'll email them a link to set their password.",
    defaultRoleNames: ['Staff'],
    documentIdentityEnabled: false,
  }), []);
  const lawStaffLabels = useMemo(() => ({
    ...genericStaffLabels,
    title: 'Solicitors and support staff',
    description: 'Manage who takes consultations, who handles intake and billing, and who appears on your website.',
    bookableStat: 'Client-facing fee earners',
    bookableFilter: 'Client-facing',
    emptyTitle: 'Invite your first solicitor',
    emptyBody: 'Add solicitors, paralegals, and support staff who take consultations and appear on the website.',
    emptyButton: 'Invite solicitor',
    profileEyebrow: 'Practitioner profile',
    profileFallback: 'New practitioner',
    titlePlaceholder: 'e.g. Partner, Associate, Paralegal',
    aboutPlaceholder: 'Practice areas, experience, qualifications, and bar admissions.',
    defaultRoleNames: ['Solicitor', 'Paralegal', 'Support'],
  }), [genericStaffLabels]);

  const ALL_NAV_ITEMS = [
    { key: 'overview',     label: tNav('overview'),                       sub: tNav('overviewSub'),     icon: IconHome },
    { key: 'store-setup',  label: 'Store setup',        sub: 'Stores, fulfilment, delivery & pickup — one window', icon: IconMapPin },
    {
      key: 'appointments',
      label: isRestaurantReservations ? 'Reservations' : navLabel('appointments', tNav('appointments')),
      sub: isRestaurantReservations ? 'Online bookings, phone bookings, and service board' : tNav('appointmentsSub'),
      icon: IconCalendar,
    },
    { key: 'restaurant-tables', label: 'Tables', sub: 'Dining areas, service periods, and online capacity', icon: IconLayout, restaurantOnly: true },
    { key: 'restaurant-guests', label: 'Guests', sub: 'Guest book, regulars, dietary notes & occasions', icon: IconUsers, restaurantOnly: true },
    { key: 'restaurant-revenue', label: 'Revenue', sub: 'Covers, deposits & estimated dining revenue', icon: IconBarChart, restaurantOnly: true },
    { key: 'prescriptions', label: 'Prescriptions', sub: 'Prescription pad & clinical letterhead', icon: IconReceipt, doctorClinicOnly: true },
    { key: 'law-matters', label: 'Matters', sub: 'Matter files, engagement, billing & trust', icon: IconLayout, lawFirmOnly: true },
    { key: 'law-conflicts', label: 'Conflict checks', sub: 'Conflict review before confirmation', icon: IconShield, lawFirmOnly: true },
    { key: 'law-documents', label: 'Legal documents', sub: 'Engagement letters and advice notes', icon: IconLayout, lawFirmOnly: true },
    { key: 'law-revenue', label: 'Revenue', sub: 'Fees billed, collected, WIP & trust', icon: IconBarChart, lawFirmOnly: true },
    { key: 'water-contracts', label: 'AMC Contracts', sub: 'Plans, visits used, renewals', icon: IconReceipt, waterOnly: true },
    { key: 'water-visits', label: 'Service Board', sub: 'AMC visits — schedule, complete & invoice', icon: IconCalendar, waterOnly: true },
    { key: 'water-dispatch', label: 'Dispatch', sub: "Today's run — assign technicians by area", icon: IconMapPin, waterOnly: true },
    { key: 'water-revenue', label: 'Revenue', sub: 'AMC value, MRR, renewals, visit revenue', icon: IconBarChart, waterOnly: true },
    {
      key: 'walkins',
      label: isRestaurantReservations ? 'Host stand' : 'Walk-ins',
      sub: isRestaurantReservations ? 'Walk-in parties, arrivals, and table-ready flow' : 'Front desk arrivals and payment collection',
      icon: IconUsers,
    },
    { key: 'waitlist',     label: tNav('waitlist'),                       sub: tNav('waitlistSub'),     icon: IconClock },
    { key: 'enquiries',    label: tNav('enquiries'),                      sub: tNav('enquiriesSub'),    icon: IconInbox },
    { key: 'team',         label: navLabel('team', tNav('team')),         sub: tNav('teamSub'),         icon: IconUsers },
    { key: 'services',     label: navLabel('services', tNav('services')), sub: tNav('servicesSub'),     icon: IconSparkles },
    { key: 'specialties',  label: 'Specialties',        sub: 'Departments + doctor grouping',           icon: IconSparkles, doctorClinicOnly: true },
    { key: 'doctor-reviews', label: 'Reviews',          sub: 'Customer reviews — moderate + publish',   icon: IconStar },
    { key: 'doctor-sections', label: 'Website sections', sub: 'Show / hide storefront sections',         icon: IconLayout, doctorClinicOnly: true },
    { key: 'reminders',    label: 'Reminders',          sub: 'Automatic appointment reminders',          icon: IconClock },
    { key: 'customers',    label: navLabel('customers', tNav('customers')), sub: tNav('customersSub'),  icon: IconMail },
    { key: 'subscription', label: tNav('subscription'), sub: tNav('subscriptionSub'), icon: IconCreditCard },
    { key: 'domains',      label: 'Domains',            sub: 'Register, transfer, DNS, renewals', icon: IconGlobe },
    { key: 'integrations', label: 'Integrations',       sub: 'Connect delivery, WMS, chat & POS apps', icon: IconLayout },
    {
      key: 'content',
      label: tenantVertical === 'ECOMMERCE' ? 'Storefront' : tNav('website'),
      sub: tenantVertical === 'ECOMMERCE' ? 'Brand header and social links' : tNav('websiteSub'),
      icon: IconLayout,
      wide: true,
    },
    { key: 'pages',        label: 'Pages',              sub: 'Custom sub-pages',      icon: IconLayout },
    { key: 'orders',       label: 'Fulfillment',        sub: 'Orders, dispatch, pickup', icon: IconCalendar },
    { key: 'products',     label: 'Products',           sub: 'Catalog + inventory',   icon: IconSparkles },
    { key: 'categories',   label: 'Categories',         sub: 'Product groupings',     icon: IconLayout },
    { key: 'blog',         label: 'Blog & SEO',         sub: 'Posts, search previews, sitemap', icon: IconLayout },
    { key: 'locations',    label: 'Locations',          sub: 'Multi-branch addresses', icon: IconLayout },
    { key: 'settings',     label: tNav('settings'),     sub: tNav('settingsSub'),     icon: IconCog },
    // ── ECOMMERCE Path B (2026-05-01) — seller console ──
    { key: 'inventory',    label: 'Inventory',          sub: 'Stock by location, GRNs, transfers',     icon: IconBoxes },
    { key: 'brands',       label: 'Brands',             sub: 'Family + brand catalog',                 icon: IconTag },
    { key: 'ecom-coupons', label: 'Coupons',            sub: 'Discount codes + auto-promotions',       icon: IconTag },
    { key: 'banners',      label: 'Banners',            sub: 'Hero carousels + storefront promos',     icon: IconImage },
    { key: 'cms',          label: 'CMS',                sub: 'Storefront content blocks',              icon: IconLayout },
    { key: 'ecom-notifications', label: 'Notifications', sub: 'Email + SMS + WhatsApp templates',     icon: IconBell },
    { key: 'reviews',      label: 'Reviews',            sub: 'Ratings + customer feedback',            icon: IconStar },
    { key: 'policies',     label: 'Policies',           sub: 'Privacy, terms, refunds — footer + signup', icon: IconShield },
    { key: 'slots',        label: 'Delivery slots',     sub: 'Time windows + capacity',                icon: IconClock },
    { key: 'pickup-locations', label: 'Pickup locations', sub: 'Click & Collect counters',             icon: IconMapPin },
    { key: 'dispatch',     label: 'Dispatch',           sub: 'Routes from fulfillment board',          icon: IconTruck },
    { key: 'returns',      label: 'Returns',            sub: 'Refunds + damaged-goods log',            icon: IconRotateCcw },
    { key: 'bulk',         label: 'Bulk ops',           sub: 'CSV import / export jobs',               icon: IconUpload },
    { key: 'payments',     label: 'Payments',           sub: 'Settlements + gateway fees',             icon: IconWallet },
    { key: 'ecom-reports', label: 'Reports',            sub: 'Sales, basket, inventory analytics',     icon: IconBarChart },
    { key: 'tax',          label: 'Tax',                sub: 'UK VAT + Indian GST + invoicing',        icon: IconReceipt },
    { key: 'cities',       label: 'Cities',             sub: 'Service areas + delivery zones',         icon: IconMapPin },
    { key: 'roles',        label: 'Roles & permissions', sub: 'RBAC: 6 roles × 24 permissions',        icon: IconShield },
    { key: 'ecom-staff',   label: 'Staff',              sub: 'Team, role assignments, 2FA',            icon: IconUserCog },
    { key: 'activity',     label: 'Activity log',       sub: 'Who did what, when',                     icon: IconHistory },
  ];

  // ECOMMERCE Path B grouping (2026-05-01). Rider/delivery fleet management
  // now lives in AapkaRider; Sitepresso keeps Fulfillment for order handoff.
  // Keys here MUST be a subset of VERTICAL_NAV_KEYS.ECOMMERCE.
  // Store Setup (2026-06-06) folds Locations + Slots + Pickup + Cities into
  // one layman-friendly window, so those four leave the sidebar (they stay
  // valid as HIDDEN_TAB_KEYS so the hub's "Advanced" deep-links still work).
  const ECOMMERCE_NAV_GROUPS = [
    { label: 'Setup',      keys: ['store-setup'] },
    { label: 'Main',       keys: ['overview', 'orders', 'returns', 'products', 'categories', 'brands', 'inventory', 'bulk', 'customers'] },
    { label: 'Marketing',  keys: ['ecom-coupons', 'banners', 'cms', 'ecom-notifications', 'reviews'] },
    { label: 'Finance',    keys: ['payments', 'ecom-reports', 'tax'] },
    { label: 'System',     keys: ['roles', 'ecom-staff', 'activity', 'subscription', 'integrations', 'enquiries', 'blog', 'domains', 'content', 'policies', 'settings'] },
  ];

  // Per-vertical visibility map. Order in the array reflects sidebar order.
  // STATIC is a marketing site only — Team + Services + Pricing are CONTENT
  // edited via the Website builder section toggles, not records that need
  // their own admin tabs. APPOINTMENT keeps Team + Services because those
  // map to bookable Service[] records and Staff[] schedules.
  // ECOMMERCE adds Phase E2's grocery seller console.
  const VERTICAL_NAV_KEYS = {
    STATIC: ['overview', 'enquiries', 'locations', 'subscription', 'integrations', 'domains', 'content', 'pages', 'blog', 'settings'],
    APPOINTMENT: ['overview', 'appointments', 'prescriptions', 'restaurant-tables', 'restaurant-guests', 'restaurant-revenue', 'law-matters', 'law-conflicts', 'law-documents', 'law-revenue', 'water-contracts', 'water-visits', 'water-dispatch', 'water-revenue', 'walkins', 'waitlist', 'enquiries', 'team', 'services', 'specialties', 'doctor-reviews', 'doctor-sections', 'reminders', 'locations', 'customers', 'subscription', 'integrations', 'domains', 'content', 'pages', 'blog', 'settings'],
    // ECOMMERCE Path B (2026-05-01) — grocery seller console.
    // Order matches ECOMMERCE_NAV_GROUPS above so the horizontal nav reads
    // Main → Marketing → Finance → System left-to-right.
    ECOMMERCE: [
      'store-setup',
      'overview', 'orders', 'returns', 'products', 'categories', 'brands', 'inventory', 'bulk', 'customers',
      'ecom-coupons', 'banners', 'cms', 'ecom-notifications', 'reviews',
      'payments', 'ecom-reports', 'tax',
      'roles', 'ecom-staff', 'activity', 'subscription', 'integrations',
      'enquiries', 'blog', 'domains', 'content', 'policies', 'settings',
    ],
  };

  const allowedKeys = new Set(VERTICAL_NAV_KEYS[tenantVertical] || VERTICAL_NAV_KEYS.APPOINTMENT);
  const NAV_ITEMS = ALL_NAV_ITEMS
    .filter((item) => allowedKeys.has(item.key))
    .filter((item) => !item.restaurantOnly || isRestaurantReservations)
    .filter((item) => !item.lawFirmOnly || isLawFirmTheme)
    .filter((item) => !item.waterOnly || isWaterPurifier)
    .filter((item) => !item.doctorClinicOnly || isDoctorClinic)
    // Restaurants get the bespoke "Guests" CRM instead of the generic Customers tab.
    .filter((item) => !(isRestaurantReservations && item.key === 'customers'))
    .sort((a, b) => {
      const order = VERTICAL_NAV_KEYS[tenantVertical] || VERTICAL_NAV_KEYS.APPOINTMENT;
      return order.indexOf(a.key) - order.indexOf(b.key);
    });
  const tCommon = useTranslations('adminCommon');
  const [me, setMe] = useState(null);
  const [stats, setStats] = useState({ staffCount: 0, serviceCount: 0, appointmentCount: 0 });
  const [status, setStatus] = useState('loading'); // loading | ready | forbidden

  // Derive active tab from URL — falls back to 'overview'
  const hiddenTabKeys = HIDDEN_TAB_KEYS_BY_VERTICAL[tenantVertical] || [];
  const VALID_KEYS = [...NAV_ITEMS.map((n) => n.key), ...hiddenTabKeys];
  const requestedTab = VALID_KEYS.includes(searchParams.get('tab')) ? searchParams.get('tab') : 'overview';
  const normalizedRequestedTab = tenantVertical === 'ECOMMERCE' && requestedTab === 'notifications'
    ? 'ecom-notifications'
    : tenantVertical === 'ECOMMERCE' && requestedTab === 'developers'
      ? 'integrations'
      : requestedTab;
  const [tab, setTabState] = useState(normalizedRequestedTab);
  const [tabResetNonce, setTabResetNonce] = useState(0);
  useEffect(() => {
    setTabState(normalizedRequestedTab);
  }, [normalizedRequestedTab]);
  // Lock to Billing & Plan while a renewal is due — any navigation snaps back.
  useEffect(() => {
    if (mustRenew && tab !== 'subscription') setTabState('subscription');
  }, [mustRenew, tab]);
  // Never-paid tenants belong in onboarding (no admin access until they pay).
  // The onboarding page only bounces back to admin once billing is sorted, so
  // there's no redirect loop.
  useEffect(() => {
    if (billingState === 'onboarding') {
      window.location.href = '/onboarding';
    }
  }, [billingState]);

  const setTab = useCallback((key, options = {}) => {
    const safeKey = VALID_KEYS.includes(key) ? key : 'overview';
    const nextTab = tenantVertical === 'ECOMMERCE' && safeKey === 'notifications'
      ? 'ecom-notifications'
      : safeKey;
    const isSameTabReset = nextTab === tab;
    setTabState(nextTab);
    if (isSameTabReset) setTabResetNonce((value) => value + 1);
    if (typeof window === 'undefined') return;

    const params = new URLSearchParams(window.location.search);
    // Remove loginCode from the URL if present so deep-link sharing is clean
    params.delete('loginCode');
    // Each panel encodes its sub-page (edit / create / detail) as
    // ?view=…&id=… (categories also uses ?parent=…). Switching tabs must
    // clear those — otherwise the new tab inherits stale state and tries
    // to open an edit form keyed on an id from the previous tab.
    params.delete('view');
    params.delete('id');
    params.delete('parent');
    params.delete('section');
    params.delete('sub');
    params.delete('status');
    params.delete('staff');
    params.delete('q');
    params.delete('past');
    params.delete('customer');
    params.delete('segment');
    params.delete('date');
    params.set('tab', safeKey);
    if (options.section) params.set('section', options.section);
    if (options.q) params.set('q', String(options.q).trim());

    const query = params.toString();
    const hash = options.hash ? `#${options.hash}` : (window.location.hash || '');
    // Route through the Next router (NOT window.history.replaceState) so that
    // useSearchParams() in every panel re-reads the cleaned params. replaceState
    // updates the address bar but NOT Next's router cache, which left panels
    // (Products, Categories, …) re-opening a stale ?view/?id edit form — or
    // stuck on "Loading…" keyed to an id from the previous tab — after a tab
    // round-trip. The dashboard page is a client component with no loading.js,
    // so this is a cheap soft navigation with no server flash.
    //
    // PUSH (not replace) on a real tab change so the browser Back button walks
    // back through the tabs you visited instead of leaving the dashboard and
    // landing on the login screen. The URL→tab sync effect above re-reads ?tab
    // on Back/Forward, so history navigation just works. A same-tab reset still
    // replaces, so re-clicking the active tab doesn't pile up history.
    const navigate = isSameTabReset ? router.replace : router.push;
    navigate(`${window.location.pathname}${query ? `?${query}` : ''}${hash}`, { scroll: false });
    if (options.hash) {
      window.setTimeout(() => {
        document.getElementById(options.hash)?.scrollIntoView({ block: 'start' });
      }, 80);
    }
  }, [tenantVertical, VALID_KEYS, router, tab]);
  const [checklist, setChecklist] = useState(null);

  async function loadChecklist() {
    try {
      const data = await api('/api/business/launch-checklist');
      setChecklist(data);
    } catch { /* ignore */ }
  }

  useEffect(() => { if (status === 'ready') loadChecklist(); }, [status]);

  // Refresh checklist whenever the tab changes so the moment the owner
  // finishes an item (e.g. saves the hero headline, then jumps to Overview)
  // the status flips green without a manual page refresh. Cheap enough —
  // /api/business/launch-checklist is a single query batch.
  useEffect(() => { if (status === 'ready') loadChecklist(); }, [tab]);

  // Poll the checklist every 5s while the site is still in draft. The owner
  // might fill in business details or the hero headline from another tab /
  // another device; polling keeps the launch-readiness indicators fresh
  // without them having to reload. Stops the moment the site goes live.
  useEffect(() => {
    if (status !== 'ready' || !checklist || checklist.isLive) return;
    const handle = setInterval(loadChecklist, 5000);
    return () => clearInterval(handle);
  }, [status, checklist?.isLive]);

  async function handlePublish() {
    try {
      await api('/api/business/launch', { method: 'POST' });
      armGoLiveCelebration();
      dismissWelcome();
      await loadChecklist();
      refreshTenant?.();
      window.location.reload();
    } catch (err) { alert(err.message); }
  }

  async function handleUnpublish() {
    const offlineMessage = tenantVertical === 'ECOMMERCE'
      ? 'Take your shop offline? Customers won\'t be able to browse and order.'
      : tenantVertical === 'APPOINTMENT'
        ? 'Take your website offline? Customers won\'t be able to book.'
        : 'Take your website offline? Visitors won\'t be able to view it.';
    if (!await confirm(offlineMessage, { title: tenantVertical === 'ECOMMERCE' ? 'Take shop offline?' : 'Take site offline?', confirmLabel: 'Take offline', tone: 'danger' })) return;
    try {
      await api('/api/business/unpublish', { method: 'POST' });
      window.location.reload();
    } catch (err) { alert(err.message); }
  }

  // ── Go-live celebration + first-run welcome ──────────────────────────────
  const celebrateBizId = tenant?.business?.id || null;
  const [showWelcome, setShowWelcome] = useState(false);
  const [celebrating, setCelebrating] = useState(false);

  function dismissWelcome() {
    setShowWelcome(false);
    try { if (celebrateBizId) localStorage.setItem('sp_welcomed_' + celebrateBizId, '1'); } catch {}
  }
  // Arm the confetti so it fires once after the full page reload that publish does.
  function armGoLiveCelebration() {
    try { if (celebrateBizId) localStorage.setItem('sp_celebrate_' + celebrateBizId, '1'); } catch {}
  }

  // First-run welcome: site still in draft + not welcomed yet → invite the
  // owner to edit + publish, with a gentle confetti pop so it feels like a win.
  useEffect(() => {
    if (status !== 'ready' || !checklist || checklist.isLive || !celebrateBizId) return;
    let welcomed = false;
    try { welcomed = localStorage.getItem('sp_welcomed_' + celebrateBizId) === '1'; } catch {}
    if (welcomed) return;
    setShowWelcome(true);
    const t = setTimeout(() => fireConfetti({ particleCount: 90, durationMs: 2200 }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, checklist?.isLive, celebrateBizId]);

  // Go-live cracker: fires exactly once after publish reloads the app.
  useEffect(() => {
    if (status !== 'ready' || !celebrateBizId) return;
    let armed = false;
    try { armed = localStorage.getItem('sp_celebrate_' + celebrateBizId) === '1'; } catch {}
    if (!armed) return;
    try { localStorage.removeItem('sp_celebrate_' + celebrateBizId); } catch {}
    setCelebrating(true);
    fireConfetti({ particleCount: 240, durationMs: 3400, origins: [{ x: 0.18, y: 0.62 }, { x: 0.5, y: 0.42 }, { x: 0.82, y: 0.62 }] });
    const t = setTimeout(() => setCelebrating(false), 4500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, celebrateBizId]);

  useEffect(() => {
    async function load() {
      try {
        // Check for one-time login code (from platform onboarding redirect)
        const params = new URLSearchParams(window.location.search);
        const loginCode = params.get('loginCode');
        if (loginCode) {
          // Exchange the code for a JWT cookie, then clean the URL
          try {
            await api('/api/auth/exchange-login-code', {
              method: 'POST',
              body: JSON.stringify({ code: loginCode }),
            });
          } catch { /* ignore — will fall through to normal auth check */ }
          // Remove loginCode from URL without reload
          params.delete('loginCode');
          const clean = params.toString();
          window.history.replaceState({}, '', window.location.pathname + (clean ? `?${clean}` : ''));
        }

        const { user } = await api('/api/auth/me');
        if (user.role !== 'BUSINESS_ADMIN' && user.role !== 'SUPER_ADMIN') {
          // Signed in but with no business = onboarding was abandoned
          // before POST /api/business/setup ran (that's what promotes
          // USER → BUSINESS_ADMIN). Send them back to finish onboarding
          // instead of dead-ending on the "Admins only" screen, which is
          // meant for real STAFF members (who DO have a business). The
          // onboarding page resumes cleanly for an authed, business-less
          // user, so there is no redirect loop.
          if (!user.businessId) {
            window.location.href = '/onboarding';
            return;
          }
          setStatus('forbidden');
          return;
        }

        // Tenant-isolation guard. The JWT cookie is valid across the
        // whole platform domain, so an admin of business A visiting
        // sitepresso.com/<businessB>/admin would otherwise see the
        // admin shell for the wrong tenant. Verify the logged-in user's
        // businessId matches the tenant the URL is pointing at (slug
        // comes from the route segment). Mismatch = forbidden with a
        // clear "log in again" path.
        const routeSlug = typeof window !== 'undefined'
          ? (window.location.pathname.split('/')[1] || '')
          : '';
        const tenantRes = routeSlug
          ? await fetch(`/api/tenant/resolve?slug=${encodeURIComponent(routeSlug)}`, {
              credentials: 'include',
            }).then((r) => r.ok ? r.json() : null).catch(() => null)
          : null;
        const tenantBizId = tenantRes?.business?.id;
        if (user.role !== 'SUPER_ADMIN' && tenantBizId && user.businessId && tenantBizId !== user.businessId) {
          // Admin landed on another tenant's slug (stale URL / switched
          // account). Don't dead-end on "Wrong business" — bounce them to
          // their OWN workspace. Falls back to the notice only if we can't
          // resolve their slug.
          if (user.businessSlug && user.businessSlug !== routeSlug) {
            window.location.replace(`/${user.businessSlug}/admin`);
            return;
          }
          setStatus('wrong_tenant');
          setMe(user);
          return;
        }

        setMe(user);
        const { stats: s } = await api('/api/business/me');
        setStats(s);
        setStatus('ready');
      } catch (err) {
        // Any error during the initial auth check (network failure, 401, 5xx,
        // CORS) means we can't verify the user. Send them to login with a
        // redirect-back param so they can resume after re-auth. The "Admins
        // only" forbidden screen is reserved for the role-mismatch case
        // handled above where we know the user IS logged in but with the
        // wrong role. Without this, a Paddle billing round trip that drops
        // the JWT cookie shows "Admins only" instead of "log back in" — the
        // 2026-04-27 reported bug.
        redirectToLogin();
      }
    }
    load();
  }, []);

  async function reloadStats() {
    try {
      const { stats: s } = await api('/api/business/me');
      setStats(s);
    } catch {
      /* ignore */
    }
  }

  if (status === 'loading') return <Centered><Spinner /></Centered>;
  if (status === 'forbidden') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <div className="w-full max-w-md text-center">
          <BrandMark size="lg" />
          <h1 className="mt-6 text-2xl font-bold text-gray-900">{tCommon('errorAdminOnly')}</h1>
          <p className="mt-2 text-sm text-gray-500">
            {tCommon('errorAdminOnlyMsg')}
          </p>
        </div>
      </div>
    );
  }
  if (status === 'wrong_tenant') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <div className="w-full max-w-md text-center bg-white rounded-2xl border border-gray-200 p-8">
          <div className="w-12 h-12 mx-auto rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-2xl">!</div>
          <h1 className="mt-5 text-xl font-bold text-gray-900">{tCommon('errorWrongBusiness')}</h1>
          <p className="mt-2 text-sm text-gray-600">{tCommon('errorWrongBusinessMsg')}</p>
          <div className="mt-5 flex flex-col gap-2">
            <button
              onClick={async () => {
                try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
                redirectToLogin();
              }}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
            >
              {tCommon('signOutTryAgain')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (tenantLoading) {
    return <Centered><Spinner /></Centered>;
  }

  if (!tenant?.business) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <div className="w-full max-w-md text-center bg-white rounded-2xl border border-gray-200 p-8">
          <div className="w-12 h-12 mx-auto rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-2xl">!</div>
          <h1 className="mt-5 text-xl font-bold text-gray-900">{tCommon('errorLoading')}</h1>
          <p className="mt-2 text-sm text-gray-600">
            {tenantError?.message || tCommon('errorLoading')}
          </p>
          <div className="mt-5 flex flex-col gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
            >
              {tCommon('refresh')}
            </button>
            <button
              type="button"
              onClick={async () => {
                try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
                redirectToLogin();
              }}
              className="px-4 py-2 text-sm font-semibold rounded-lg border border-gray-300 text-gray-700 hover:border-gray-400"
            >
              {tCommon('signOutTryAgain')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const business = tenant?.business;
  // "View site" opens the connected custom domain once it's ACTIVE; otherwise
  // the tenant subdomain. Status lives on the business (from /api/tenant/resolve).
  const activeCustomDomain = business?.customDomainStatus === 'ACTIVE' ? (business?.customDomain || null) : null;
  const liveSiteUrl = getTenantStorefrontUrl(business?.slug, '/', activeCustomDomain) || '#';
  const subscription = tenant?.subscription;
  const adminLogoUrl = tenant?.content?.logoUrl || '';
  const adminLogoAspect = tenant?.content?.logoAspect || 'wide';
  const activeKeyForHeader = ['coupons', 'embed'].includes(tab) ? 'settings' : tab;
  const active = NAV_ITEMS.find((n) => n.key === activeKeyForHeader) || NAV_ITEMS[0];
  const isWebsiteTab = tab === 'content';
  const panelResetKey = `${tab}:${tabResetNonce}`;
  // Website tab goes full-bleed so the editor + preview use every pixel.
  const containerWidth = isWebsiteTab ? 'w-full' : 'max-w-screen-2xl';
  const containerPad = isWebsiteTab ? '' : 'px-4 sm:px-6 lg:px-8';
  const activePanel = (
    <>
      {inGrace && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-orange-300 bg-orange-50 p-4 text-sm text-orange-900">
          <span>
            <span className="font-semibold">Payment overdue.</span> Please update payment to keep your site online{graceUntil ? ` — access ends ${new Date(graceUntil).toLocaleDateString()}` : ''}. After that your site goes offline until you pay.
          </span>
          <button onClick={() => setTab('subscription')} className="shrink-0 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-700">Pay now</button>
        </div>
      )}
      {mustRenew && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <span className="font-semibold">Your plan has expired and your site is offline.</span> Pick a plan below or enter a coupon to reactivate — the rest of your dashboard unlocks once you&apos;re active again. Meanwhile you can still{' '}
          <a href="/api/business/data-export" className="font-semibold underline hover:text-amber-950">download all your data</a>.
        </div>
      )}
      {tab === 'store-setup' && tenantVertical === 'ECOMMERCE' && (
        <StoreSetupHub business={business} subscription={tenant?.subscription} refreshTenant={refreshTenant} onTabChange={setTab} />
      )}
      {tab === 'overview' && tenantVertical === 'ECOMMERCE' && <EcommerceOverviewTab me={me} />}
      {tab === 'overview' && tenantVertical !== 'ECOMMERCE' && <OverviewTab stats={stats} themeVocab={themeVocab} vertical={tenantVertical} onNavigate={setTab} />}
      {tab === 'appointments' && isRestaurantReservations && <RestaurantHostStandPanel />}
      {tab === 'appointments' && !isRestaurantReservations && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">{tNav('appointments')}</h2>
          <AppointmentsPanel role={me?.role || 'BUSINESS_ADMIN'} me={me} />
        </div>
      )}
      {tab === 'law-matters' && <LawFirmMattersTab business={business} config={lawFirmConfig} />}
      {tab === 'law-conflicts' && <LawFirmConflictChecksTab config={lawFirmConfig} />}
      {tab === 'law-documents' && <LawFirmDocumentsTab tenant={tenant} config={lawFirmConfig} />}
      {tab === 'law-revenue' && <LawFirmRevenuePanel business={business} config={lawFirmConfig} />}
      {tab === 'water-contracts' && <WaterContractsTab business={business} />}
      {tab === 'water-visits' && <WaterServiceVisitsPanel business={business} />}
      {tab === 'water-dispatch' && <WaterDispatchPanel business={business} />}
      {tab === 'water-revenue' && <WaterRevenuePanel business={business} />}
      {tab === 'walkins' && (isRestaurantReservations ? <RestaurantHostStandPanel /> : <WalkInsPanel />)}
      {tab === 'restaurant-tables' && <RestaurantTablesPanel />}
      {tab === 'restaurant-guests' && <RestaurantGuestsPanel />}
      {tab === 'restaurant-revenue' && <RestaurantRevenuePanel />}
      {tab === 'prescriptions' && <DoctorPrescriptionsTab tenant={tenant} config={{}} />}
      {tab === 'enquiries' && <EnquiriesTab />}
      {tab === 'services' && (
        <ServicesTab
          onChange={reloadStats}
          followUpsEnabled={!isRestaurantReservations}
          labels={isRestaurantReservations ? {
            collection: 'Dining experiences',
            singular: 'dining experience',
            add: '+ Add dining experience',
            empty: 'No dining experiences yet. Add table reservations, chef counter, tasting menu, or private dining.',
            deleteConfirm: 'Delete this dining experience?',
            modalAdd: 'Add dining experience',
            modalEdit: 'Edit dining experience',
            name: 'Experience name *',
            duration: 'Turn time (min) *',
            durationHint: 'How long this table booking normally occupies a table.',
            price: 'Price or minimum spend (optional)',
            priceHint: 'Use this for menu price, deposit reference, or minimum-spend display. Commercial rules live in Tables.',
            features: 'Guest-facing notes',
            featureHint: 'Short points shown on the website, such as tasting menu, private room, deposit, or celebration setup.',
            highlight: 'Highlight this dining experience on the website',
            virtual: 'Online / virtual experience',
            image: 'Dining image (optional)',
            imageTitle: 'Edit dining image',
            saveAdd: 'Add dining experience',
          } : undefined}
        />
      )}
      {tab === 'specialties' && <SpecialtiesTab />}
      {tab === 'doctor-reviews' && <DoctorReviewsTab />}
      {tab === 'doctor-sections' && <DoctorSectionsTab />}
      {tab === 'reminders' && <RemindersTab />}
      {tab === 'domains' && <DomainsTab business={business} vertical={tenantVertical} onTabChange={setTab} />}
      {tab === 'integrations' && <IntegrationsTab initialSection={requestedTab === 'developers' ? 'api' : undefined} />}
      {tab === 'notifications' && <NotificationsInboxTab />}
      {(tab === 'customers' || tab === 'emails') && <CustomersTab initialSubTab={tab === 'emails' ? 'emails' : 'people'} vertical={tenantVertical} business={business} />}
      {/* `reports` was merged into Overview (2026-04-27). Old ?tab=reports
          bookmarks land on Overview without an extra redirect. */}
      {tab === 'reports' && <OverviewTab stats={stats} themeVocab={themeVocab} />}
      {tab === 'waitlist' && <WaitlistTab />}
      {tab === 'pages' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <PagesPanel businessSlug={business?.slug} />
        </div>
      )}
      {tab === 'products' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <ProductsPanel />
        </div>
      )}
      {tab === 'categories' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <CategoriesPanel />
        </div>
      )}
      {tab === 'orders' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <OrdersPanel />
        </div>
      )}
      {tab === 'blog' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <BlogPanel />
        </div>
      )}
      {tab === 'locations' && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <LocationsPanel />
        </div>
      )}
      {tab === 'content' && (
        tenantVertical === 'ECOMMERCE' ? (
          <EcommerceStorefrontPanel refreshTenant={refreshTenant} onTabChange={setTab} />
        ) : (
          <WebsiteContentTab
            refreshTenant={refreshTenant}
            checklist={checklist}
            reloadChecklist={loadChecklist}
            onLaunch={async () => {
              // Called from the Publish-button confirmation modal when the
              // owner hits "Publish & go live". POST /api/business/launch
              // flips isActive=true. Full page refresh so the admin chrome
              // (Live badge, nav state, etc.) rehydrates cleanly.
              await api('/api/business/launch', { method: 'POST' });
              armGoLiveCelebration();
              dismissWelcome();
              await loadChecklist();
              refreshTenant?.();
              // Give the user a moment to see the confirmation close, then
              // reload so the whole app reflects the new live state.
              setTimeout(() => window.location.reload(), 400);
            }}
          />
        )
      )}
      {tab === 'team' && (
        <TeamTab
          business={business}
          refreshTenant={refreshTenant}
          onStaffChange={reloadStats}
          vertical={resolveVertical(tenant?.business?.vertical)}
          staffLabels={isRestaurantReservations ? {
            title: 'Hosts and front of house',
            description: 'Manage hosts, managers, servers, and front-of-house access for reservations, walk-ins, table flow, and payment handling.',
            invite: '+ Invite team member',
            bookableStat: 'Reservation-ready hosts',
            frontDeskStat: 'Front of house',
            bookableFilter: 'Reservation-ready',
            emptyTitle: 'Invite your first host',
            emptyBody: 'Add hosts or front-of-house staff who can manage reservations, seat guests, and handle service flow.',
            emptyButton: 'Invite host',
            unnamed: 'Unnamed team member',
            bookingsToggle: 'Reservations',
            profileEyebrow: 'Hospitality profile',
            profileFallback: 'New team member',
            titlePlaceholder: 'e.g. Host, Restaurant Manager, Server',
            aboutPlaceholder: 'Hospitality experience, service style, languages, and dining-room responsibilities.',
            inviteModalTitle: 'Invite restaurant team member',
            inviteHelp: "We'll email them a link to set their password and join this restaurant workspace.",
            defaultRoleNames: ['Host', 'Front Desk', 'Receptionist', 'Staff'],
            documentIdentityEnabled: false,
          } : isDoctorClinic ? undefined /* StaffTab default is doctor copy + Rx identity */
            : isLawFirmTheme ? lawStaffLabels
            : genericStaffLabels}
        />
      )}
      {tab === 'subscription' && business && (
        <SubscriptionTab refreshTenant={refreshTenant} vertical={resolveVertical(tenant?.business?.vertical)} />
      )}
      {/* `coupons` and `embed` are now Settings sub-tabs (2026-04-27).
          Old ?tab=coupons / ?tab=embed deep-links auto-redirect into the
          Settings tab with the correct sub-tab pre-selected. */}
      {(tab === 'settings' || tab === 'coupons' || tab === 'embed') && business && (
        <SettingsTab
          business={business}
          content={tenant?.content || {}}
          subscription={subscription}
          refreshTenant={refreshTenant}
          reloadChecklist={loadChecklist}
          onTabChange={setTab}
          initialSubTab={tab === 'coupons' ? 'coupons' : tab === 'embed' ? 'embed' : undefined}
        />
      )}
      {/* ── ECOMMERCE Path B panels (stubs today, real impl ports from prototype) ── */}
      {tab === 'inventory' && <InventoryPanel />}
      {tab === 'ecom-coupons' && <EcommerceCouponsPanel />}
      {tab === 'banners' && <BannersPanel />}
      {tab === 'cms' && <CmsPanel />}
      {tab === 'ecom-notifications' && <EcommerceNotificationsPanel />}
      {tab === 'reviews' && <ReviewsPanel />}
      {tab === 'policies' && <PoliciesPanel />}
      {tab === 'slots' && <SlotsPanel />}
      {tab === 'pickup-locations' && <PickupLocationsPanel />}
      {tab === 'dispatch' && <DispatchPanel />}
      {tab === 'brands' && <BrandsPanel />}
      {tab === 'returns' && <ReturnsPanel />}
      {tab === 'bulk' && <BulkOpsPanel />}
      {tab === 'payments' && <PaymentsPanel />}
      {tab === 'ecom-reports' && <EcommerceReportsPanel />}
      {tab === 'tax' && <TaxPanel />}
      {tab === 'cities' && <CitiesPanel />}
      {tab === 'roles' && <RolesPermissionsPanel />}
      {tab === 'ecom-staff' && <EcommerceStaffPanel />}
      {tab === 'activity' && <ActivityLogPanel />}
    </>
  );

  function handleTabCrash() {
    // Navigate to overview on crash — URL state handles the actual reset
  }

  // ECOMMERCE Path B (2026-05-01): wrap the whole shell in a location-context
  // provider so the topbar switcher and every tab below share the active
  // location filter. STATIC + APPOINTMENT skip this entirely — the provider
  // is a no-op for them.
  const shellInner = (
    <div className="min-h-screen" style={{ background: '#FAF9F7' }}>
      {/* Trial countdown banner — shows when tenant is in (or just out of)
          a card-required plan trial. Hidden for paid customers + tenants who never trialed.
          Mounts above the sticky header so the trial state is the very first
          thing the admin sees. */}
      <TrialBanner trial={tenant?.subscription?.trial} slug={tenant?.business?.slug} />

      {/* First-run welcome — celebratory go-live nudge right after onboarding. */}
      {showWelcome && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-gray-900/40 backdrop-blur-sm p-4" onClick={dismissWelcome}>
          <div onClick={(e) => e.stopPropagation()} className="relative w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="h-1.5 w-full bg-gradient-to-r from-indigo-500 via-emerald-400 to-amber-400" />
            <div className="p-6 text-center">
              <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-50 text-3xl">🎉</div>
              <h2 className="text-xl font-bold text-gray-900">Welcome{business?.name ? `, ${business.name}` : ''}!</h2>
              <p className="mt-1.5 text-sm text-gray-600">
                {tenantVertical === 'ECOMMERCE'
                  ? 'Your store is ready. Set up your locations, delivery and payments, then publish to go live.'
                  : 'Your website is ready. Add your finishing touches, then publish to go live — your site will be online in seconds.'}
              </p>
              <div className="mt-5 flex flex-col gap-2">
                <button type="button" onClick={() => { dismissWelcome(); setTab(tenantVertical === 'ECOMMERCE' ? 'store-setup' : 'content'); }} className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-indigo-700">
                  {tenantVertical === 'ECOMMERCE' ? 'Set up your store' : 'Edit your website'}
                </button>
                <button type="button" onClick={() => { handlePublish(); }} className="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50">
                  Publish now &amp; go live →
                </button>
              </div>
              <button type="button" onClick={dismissWelcome} className="mt-3 text-xs text-gray-400 hover:text-gray-600">I&apos;ll explore first</button>
            </div>
          </div>
        </div>
      )}

      {/* Go-live celebration toast — fires once right after publishing. */}
      {celebrating && (
        <div className="fixed left-1/2 top-6 z-[70] w-[min(92vw,420px)] -translate-x-1/2">
          <div className="overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5">
            <div className="h-1.5 w-full bg-gradient-to-r from-emerald-500 via-indigo-400 to-amber-400" />
            <div className="flex items-center gap-3 p-4">
              <div className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-emerald-50 text-2xl">🚀</div>
              <div className="min-w-0">
                <p className="text-sm font-bold text-gray-900">You&apos;re live! Your website is published 🎊</p>
                <a href={liveSiteUrl} target="_blank" rel="noopener" className="mt-0.5 inline-block max-w-full truncate text-xs font-semibold text-indigo-600 hover:underline">
                  View it live ↗
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Brand header — sticky glass panel, Boulevard-style */}
      <header
        className="sticky top-0 z-30 backdrop-blur-md"
        style={{ background: 'rgba(250, 249, 247, 0.85)', borderBottom: '1px solid rgba(0,0,0,0.06)' }}
      >
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-3 min-w-0">
            <AdminBusinessLogo business={business} logoUrl={adminLogoUrl} logoAspect={adminLogoAspect} />
            <div className="min-w-0 hidden sm:block">
              <div className="font-semibold text-gray-900 leading-tight truncate">{business?.name || 'Sitepresso'}</div>
              <div className="text-[10px] font-mono tracking-[0.2em] text-gray-500 uppercase leading-tight mt-0.5">Business admin</div>
            </div>
          </Link>

          <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
            {tenantVertical === 'ECOMMERCE' && !LOCATION_SWITCHER_HIDDEN_TABS.has(tab) && <EcommerceLocationSwitcher />}
            <LanguageSelector
              currentLocale={typeof document !== 'undefined' ? (document.cookie.match(/(?:^|;\s*)NEXT_LOCALE=([^;]+)/)?.[1] || 'en') : 'en'}
              compact
            />
            <NotificationsBell
              onOpen={() => setTab(tenantVertical === 'ECOMMERCE' ? 'ecom-notifications' : 'notifications')}
              active={tab === (tenantVertical === 'ECOMMERCE' ? 'ecom-notifications' : 'notifications')}
            />
            {checklist?.isLive && (
              <span className="hidden sm:inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-[11px] font-mono tracking-wider text-emerald-700">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> LIVE
              </span>
            )}
            {checklist?.isLive && (
              <button onClick={handleUnpublish}
                className="hidden md:inline-flex text-xs text-gray-500 hover:text-red-600 hover:underline">
                Take offline
              </button>
            )}
            <a
              href={liveSiteUrl}
              target="_blank" rel="noopener"
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-medium transition-all hover:shadow-sm"
              style={{ borderColor: 'rgba(0,0,0,0.1)', color: '#374151', background: '#FFFFFF' }}
            >
              View site <span aria-hidden>↗</span>
            </a>
            <LogoutButton />
          </div>
        </div>

        {/* Top nav — pill style, theme-accented active state.
            STATIC + APPOINTMENT use a flat flex-wrap.
            ECOMMERCE Path B uses a grouped layout (Main / Marketing /
            Finance / System) since it has many tabs and a flat
            list becomes unreadable. The grouping mirrors the prototype's
            sidebar from `Grocery E-Commerce/`. */}
        <nav className="max-w-screen-2xl mx-auto px-2 sm:px-4 lg:px-6 pb-2">
          {tenantVertical === 'ECOMMERCE' ? (
            <div className="flex flex-col gap-1.5">
              {ECOMMERCE_NAV_GROUPS.map((group) => {
                const groupItems = NAV_ITEMS.filter((n) => group.keys.includes(n.key));
                if (groupItems.length === 0) return null;
                return (
                  <div key={group.label} className="flex flex-wrap items-center gap-1">
                    <span className="text-[10px] font-mono tracking-[0.2em] uppercase text-gray-400 px-2 min-w-[88px]">
                      {group.label}
                    </span>
                    {groupItems.map((item) => {
                      const Icon = item.icon;
                      const isActive = item.key === tab;
                      return (
                        <button
                          key={item.key}
                          onClick={() => setTab(item.key)}
                          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[13px] font-semibold transition-all whitespace-nowrap"
                          style={isActive
                            ? { background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }
                            : { color: '#6B7280', background: 'transparent' }}
                        >
                          <Icon className="w-3.5 h-3.5" />
                          <span>{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = item.key === tab;
                return (
                  <button
                    key={item.key}
                    onClick={() => setTab(item.key)}
                    className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-semibold transition-all whitespace-nowrap"
                    style={isActive
                      ? { background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }
                      : { color: '#6B7280', background: 'transparent' }}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </nav>
      </header>

      {/* Compact workspace header. Admin screens should feel like tools, not
          landing pages, so keep context visible without spending hero space. */}
      {!isWebsiteTab && (
        <div className={`${containerWidth} mx-auto ${containerPad} pt-4 pb-3`}>
          <div className="rounded-2xl border border-gray-200 bg-white/90 px-4 py-3 shadow-sm">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[11px] text-gray-500">
                  <button
                    type="button"
                    onClick={() => setTab('overview')}
                    className="font-semibold text-gray-600 hover:text-indigo-700"
                  >
                    Dashboard
                  </button>
                  <span aria-hidden className="text-gray-300">/</span>
                  <span className="font-semibold text-gray-900">{active.label}</span>
                </nav>
                <div className="mt-1 flex min-w-0 flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-2">
                  <h1 className="text-xl font-semibold leading-tight text-gray-950">{active.label}</h1>
                  <span aria-hidden className="hidden h-1 w-1 rounded-full bg-gray-300 sm:inline-block" />
                  <p className="min-w-0 text-sm leading-5 text-gray-500 md:truncate">{active.sub}</p>
                </div>
              </div>
              <span className="inline-flex w-fit items-center gap-2 rounded-full border border-gray-200 bg-gray-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--theme-primary)' }} />
                {tenantVertical === 'STATIC' ? 'Website' : tenantVertical === 'APPOINTMENT' ? 'Booking' : 'Store'}
              </span>
            </div>
          </div>
        </div>
      )}

      <main className={`${containerWidth} mx-auto ${containerPad} ${isWebsiteTab ? '' : 'pb-10'}`}>
        {/* Launch checklist removed — owner publishes via the Publish button
            in the website editor, which opens a first-time confirmation modal. */}

        <DashboardTabBoundary
          resetKey={panelResetKey}
          onError={handleTabCrash}
          fallback={(
            <TabCrashFallback
              tabLabel={(NAV_ITEMS.find((item) => item.key === tab)?.label || tCommon('back')).toLowerCase()}
              onReset={() => setTab('overview')}
            />
          )}
        >
          <div key={panelResetKey}>{activePanel}</div>
        </DashboardTabBoundary>
      </main>
      <AapkaChatActionWidget business={business} me={me} context="admin_portal" />
    </div>
  );

  if (tenantVertical === 'ECOMMERCE') {
    // ECOMMERCE Path B Phase 7a (2026-05-01) — render the FreshCart-style
    // sidebar shell instead of the platform's horizontal pill nav.
    // STATIC + APPOINTMENT keep `shellInner` (the original layout).
    return (
      <EcommerceLocationProvider businessSlug={business?.slug}>
        <EcommerceAdminShell
          tenant={tenant}
          business={business}
          me={me}
          navItems={NAV_ITEMS}
          navGroups={ECOMMERCE_NAV_GROUPS}
          activeKey={tab}
          setTab={setTab}
          notificationsBell={<NotificationsBell
            onOpen={() => setTab(tenantVertical === 'ECOMMERCE' ? 'ecom-notifications' : 'notifications')}
            active={tab === (tenantVertical === 'ECOMMERCE' ? 'ecom-notifications' : 'notifications')}
          />}
          isLive={!!checklist?.isLive}
          onPublish={handlePublish}
          onUnpublish={handleUnpublish}
          storefrontUrl={liveSiteUrl}
        >
          <DashboardTabBoundary
            resetKey={panelResetKey}
            onError={handleTabCrash}
            fallback={(
              <TabCrashFallback
                tabLabel={(NAV_ITEMS.find((item) => item.key === tab)?.label || tCommon('back')).toLowerCase()}
                onReset={() => setTab('overview')}
              />
            )}
          >
            <div key={panelResetKey}>{activePanel}</div>
          </DashboardTabBoundary>
        </EcommerceAdminShell>
      </EcommerceLocationProvider>
    );
  }
  return shellInner;
}

export function BusinessAdmin() {
  return (
    <Suspense fallback={<Centered><Spinner /></Centered>}>
      <BusinessAdminContent />
    </Suspense>
  );
}

class DashboardTabBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    this.props.onError?.(error);
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

function TabCrashFallback({ tabLabel, onReset }) {
  return (
    <div className="bg-white rounded-2xl border border-amber-200 p-6 max-w-2xl">
      <div className="flex items-start gap-4">
        <div className="w-11 h-11 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center text-xl flex-shrink-0">!</div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-900">This admin panel hit an error</h2>
          <p className="mt-2 text-sm text-gray-600">
            We kept your login session, but the <strong>{tabLabel}</strong> section failed to load.
            You can jump back to Overview and keep working while we repair the broken panel.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onReset}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
            >
              Open Overview
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 text-sm font-semibold rounded-lg border border-gray-300 text-gray-700 hover:border-gray-400"
            >
              Reload dashboard
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BrandMark({ size = 'md' }) {
  const cls = size === 'lg' ? 'w-14 h-14 text-xl rounded-2xl' : 'w-9 h-9 text-sm rounded-xl';
  return (
    <span
      className={`inline-flex ${cls} items-center justify-center text-white font-bold shadow-sm`}
      style={{ background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)' }}
      aria-hidden
    >
      A
    </span>
  );
}

function logoAspectRatio(value) {
  if (value === 'square') return 1;
  if (value === 'rectangle') return 3;
  return 4;
}

function AdminBusinessLogo({ business, logoUrl, logoAspect }) {
  const fallback = (business?.name || '?').charAt(0).toUpperCase();
  const size = 36;
  const style = logoUrl
    ? { width: Math.min(size * logoAspectRatio(logoAspect), 144), background: '#FFFFFF', border: '1px solid rgba(0,0,0,0.08)' }
    : { width: size, background: 'var(--theme-primary)' };
  return (
    <span
      className="flex h-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl text-sm font-bold text-white shadow-sm"
      style={style}
      aria-hidden
    >
      {logoUrl ? (
        <img src={logoUrl} alt="" className="h-full w-full object-contain p-1" />
      ) : fallback}
    </span>
  );
}

// ---------------- Nav icons ----------------

function IconHome({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l9-9 9 9M5 10v10a1 1 0 001 1h4a1 1 0 001-1v-5h2v5a1 1 0 001 1h4a1 1 0 001-1V10" />
  </svg>);
}
function IconCalendar({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
  </svg>);
}
function IconCalendarCheck({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2zm4-7l2 2 4-4" />
  </svg>);
}
function IconInbox({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 13h4l1.5 3h7L17 13h4M3 13V7a2 2 0 012-2h14a2 2 0 012 2v6M3 13v6a2 2 0 002 2h14a2 2 0 002-2v-6" />
  </svg>);
}
function IconUsers({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H2v-2a4 4 0 013-3.87M9 12a4 4 0 100-8 4 4 0 000 8zm8 0a4 4 0 100-8 4 4 0 000 8z" />
  </svg>);
}
function IconSparkles({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.5 6.5L22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5L13 3z" />
  </svg>);
}
function IconLayout({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 5a2 2 0 012-2h12a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm0 5h16M10 10v11" />
  </svg>);
}
function IconClock({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>);
}
function IconAirplane({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 13l7-2 3-8 3 8 7 2-7 2-3 8-3-8-7-2z" />
  </svg>);
}
function IconTag({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5a2 2 0 011.41.59l7 7a2 2 0 010 2.82l-7 7a2 2 0 01-2.82 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
  </svg>);
}
function IconBarChart({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 20h18M6 16V10m6 6V6m6 10v-4" />
  </svg>);
}
function IconBell({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V4a2 2 0 10-4 0v1.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
  </svg>);
}
function IconCreditCard({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M5 6h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2z" />
  </svg>);
}
function IconMail({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2zm0 1.5l8 6 8-6" />
  </svg>);
}
function IconGlobe({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <circle cx="12" cy="12" r="9" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21M12 3c-2.5 2.6-3.8 5.6-3.8 9s1.3 6.4 3.8 9" />
  </svg>);
}
function IconCog({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>);
}
function IconCode({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
  </svg>);
}
// ── ECOMMERCE Path B icons (2026-05-01) ──
function IconBoxes({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l4-4 4 4-4 4-4-4zm10 0l4-4 4 4-4 4-4-4zM8 16l4-4 4 4-4 4-4-4z" />
  </svg>);
}
function IconImage({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="8.5" cy="10.5" r="1.5" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 15l-5-5-9 9" />
  </svg>);
}
function IconStar({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
  </svg>);
}
function IconTruck({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M1 7h12v10H1zM13 10h5l3 3v4h-8zM5.5 17.5a2 2 0 100 4 2 2 0 000-4zm12 0a2 2 0 100 4 2 2 0 000-4z" />
  </svg>);
}
function IconRotateCcw({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 12a9 9 0 1015 -6.7L21 3M3 3v6h6" />
  </svg>);
}
function IconUpload({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2M16 8l-4-4-4 4M12 4v12" />
  </svg>);
}
function IconWallet({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7zM16 12h2v2h-2z" />
  </svg>);
}
function IconReceipt({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2V3zM8 8h8M8 12h8M8 16h5" />
  </svg>);
}
function IconMapPin({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 21s-7-7-7-12a7 7 0 1114 0c0 5-7 12-7 12z" />
    <circle cx="12" cy="9" r="2.5" />
  </svg>);
}
function IconShield({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-4z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" />
  </svg>);
}
function IconUserCog({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <circle cx="9" cy="7" r="4" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" />
    <circle cx="18" cy="15" r="2.5" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M18 11.5v1m0 5v1m3.4-5l-.7.7m-5.4 5.4l-.7.7m6.8 0l-.7-.7m-5.4-5.4l-.7-.7" />
  </svg>);
}
function IconHistory({ className }) {
  return (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 12a9 9 0 109-9 9 9 0 00-7.5 4M3 3v6h6M12 7v5l3 2" />
  </svg>);
}

// LaunchChecklist extracted to platform/components/admin-tabs/LaunchChecklist.js

// ============================================================================
// Overview
// ============================================================================
// Overview was originally a tiny 3-card "your business at a glance"
// strip; on 2026-04-27 the Reports tab was retired and its rich
// dashboard (revenue trend, completion rate, no-show rate, by-day /
// by-hour / by-service / by-staff breakdowns) folded in here. The
// 3-card strip stays at the top as a quick-glance header, then the
// full reports render below.
function OverviewTab({ stats, themeVocab, vertical, onNavigate }) {
  // STATIC (website) tenants have no bookings — show a web-relevant dashboard
  // (leads, content, domains) instead of staff/services/appointments.
  if (vertical === 'STATIC') return <WebOverview stats={stats} onNavigate={onNavigate} />;

  const cards = [
    { label: themeVocab?.team || 'Staff members',           value: stats.staffCount, tint: 'bg-amber-50 text-amber-700' },
    { label: themeVocab?.services || 'Services',            value: stats.serviceCount, tint: 'bg-indigo-50 text-indigo-700' },
    { label: themeVocab?.appointments || 'Appointments',    value: stats.appointmentCount, tint: 'bg-emerald-50 text-emerald-700' },
  ];
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {cards.map((c) => (
          <div key={c.label} className="bg-white rounded-2xl border border-gray-200 p-6">
            <p className="text-xs uppercase tracking-wide text-gray-500">{c.label}</p>
            <p className={`text-3xl font-bold mt-2 inline-block px-3 py-1 rounded-lg ${c.tint}`}>{c.value}</p>
          </div>
        ))}
      </div>
      <ReportsTab />
    </div>
  );
}

// ── Website (STATIC) overview ────────────────────────────────────────────
function relativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}
const ENQUIRY_STATUS_TINT = {
  NEW: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  READ: 'bg-gray-100 text-gray-600 border-gray-200',
  REPLIED: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  ARCHIVED: 'bg-gray-50 text-gray-400 border-gray-200',
};

function WebOverview({ stats, onNavigate }) {
  const w = stats?.webStats || {
    enquiriesNew: 0, enquiriesTotal: 0,
    pagesPublished: 0, blogPublished: 0, domainsActive: 0,
    recentEnquiries: [], enquiryTrend: [],
  };
  const cards = [
    { key: 'enquiries', label: 'New enquiries', value: w.enquiriesNew, hint: `${w.enquiriesTotal} total`, tint: 'bg-emerald-50 text-emerald-700', go: 'enquiries' },
    { key: 'pages', label: 'Published pages', value: w.pagesPublished, hint: 'live on your site', tint: 'bg-amber-50 text-amber-700', go: 'pages' },
    { key: 'blog', label: 'Blog posts', value: w.blogPublished, hint: 'published', tint: 'bg-sky-50 text-sky-700', go: 'blog' },
    { key: 'domains', label: 'Domains', value: w.domainsActive, hint: 'connected', tint: 'bg-violet-50 text-violet-700', go: 'domains' },
  ];
  const trend = Array.isArray(w.enquiryTrend) ? w.enquiryTrend : [];
  const trendMax = Math.max(1, ...trend.map((d) => d.count));
  const trendTotal = trend.reduce((s, d) => s + d.count, 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => c.go && onNavigate?.(c.go)}
            className="bg-white rounded-2xl border border-gray-200 p-5 text-left transition-all hover:border-gray-300 hover:shadow-sm"
          >
            <p className="text-xs uppercase tracking-wide text-gray-500">{c.label}</p>
            <p className={`text-3xl font-bold mt-2 inline-block px-3 py-1 rounded-lg ${c.tint}`}>{c.value}</p>
            <p className="text-[11px] text-gray-400 mt-2">{c.hint}</p>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Enquiries trend (last 30 days) */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-gray-900">Enquiries · last 30 days</h3>
            <span className="text-xs text-gray-500">{trendTotal} total</span>
          </div>
          {trendTotal === 0 ? (
            <p className="mt-6 text-sm text-gray-400">No enquiries yet. They'll appear here as visitors get in touch.</p>
          ) : (
            <div className="mt-5 flex items-end gap-[3px] h-24">
              {trend.map((d) => (
                <div key={d.date} className="flex-1 rounded-t bg-emerald-200" style={{ height: `${Math.max(4, (d.count / trendMax) * 100)}%` }} title={`${d.date}: ${d.count}`} />
              ))}
            </div>
          )}
        </div>

        {/* Recent enquiries */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-gray-900">Recent enquiries</h3>
            <button type="button" onClick={() => onNavigate?.('enquiries')} className="text-xs font-semibold text-indigo-600 hover:text-indigo-700">View all</button>
          </div>
          {(!w.recentEnquiries || w.recentEnquiries.length === 0) ? (
            <p className="mt-6 text-sm text-gray-400">No enquiries yet.</p>
          ) : (
            <ul className="mt-4 divide-y divide-gray-100">
              {w.recentEnquiries.map((e) => (
                <li key={e.id} className="py-2.5 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{e.name || 'Anonymous'}</p>
                    <p className="text-xs text-gray-500 truncate">{e.subject || e.message || 'No message'}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className={`inline-block text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border ${ENQUIRY_STATUS_TINT[e.status] || ENQUIRY_STATUS_TINT.READ}`}>{e.status}</span>
                    <p className="text-[10px] text-gray-400 mt-1">{relativeTime(e.createdAt)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Staff tab
// ============================================================================
