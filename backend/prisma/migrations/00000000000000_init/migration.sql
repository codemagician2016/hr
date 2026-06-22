-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PAID', 'PACKING', 'OUT_FOR_DELIVERY', 'DELIVERED', 'READY_FOR_PICKUP', 'PICKED_UP', 'CANCELLED', 'REFUNDED', 'FAILED');

-- CreateEnum
CREATE TYPE "EnquiryStatus" AS ENUM ('NEW', 'READ', 'REPLIED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('PENDING', 'NOTIFIED', 'CONVERTED', 'DISMISSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'BUSINESS_ADMIN', 'STAFF', 'USER');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'TRIALING', 'PAST_DUE', 'PAUSED', 'CANCEL_SCHEDULED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BannerType" AS ENUM ('INFO', 'WARNING', 'URGENT', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "BannerTarget" AS ENUM ('ALL', 'PLATFORM', 'BUSINESSES', 'SPECIFIC');

-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('FIXED', 'PERCENTAGE');

-- CreateEnum
CREATE TYPE "AdminCouponBenefitType" AS ENUM ('FREE_PERIOD', 'LIFETIME_FREE', 'PERCENT_OFF', 'FIXED_OFF');

-- CreateEnum
CREATE TYPE "AdminCouponBenefitUnit" AS ENUM ('DAYS', 'MONTHS', 'CYCLES');

-- CreateEnum
CREATE TYPE "TierFeatureType" AS ENUM ('BOOLEAN', 'NUMERIC', 'UNLIMITED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATED', 'UPDATED', 'DELETED', 'SYNCED');

-- CreateEnum
CREATE TYPE "BlogCommentStatus" AS ENUM ('PENDING', 'APPROVED', 'SPAM');

-- CreateEnum
CREATE TYPE "BlogCommentAuthorType" AS ENUM ('GUEST', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "BlogModerationMode" AS ENUM ('NONE', 'PRE_MODERATE');

-- CreateEnum
CREATE TYPE "BlogParticipantPolicy" AS ENUM ('NONE', 'GUEST_ONLY', 'REGISTERED_ONLY', 'BOTH');

-- CreateEnum
CREATE TYPE "PagePlacement" AS ENUM ('TOP', 'DROPDOWN', 'FOOTER', 'HIDDEN');

-- CreateEnum
CREATE TYPE "InventoryAdjustmentReason" AS ENUM ('GRN_RECEIPT', 'ORDER_PICK', 'ORDER_FULFILL', 'ORDER_CANCEL', 'TRANSFER_OUT', 'TRANSFER_IN', 'RETURN_RESTOCK', 'RETURN_SCRAP', 'DAMAGE', 'THEFT', 'EXPIRY', 'COUNT_ADJUSTMENT', 'PROMOTIONAL_GIVEAWAY', 'OTHER');

-- CreateEnum
CREATE TYPE "RiderStatus" AS ENUM ('ACTIVE', 'OFF_SHIFT', 'ON_LEAVE', 'SUSPENDED', 'DEPARTED');

-- CreateEnum
CREATE TYPE "EcomRiderShiftStatus" AS ENUM ('OPEN', 'CLOSED', 'VOID');

-- CreateEnum
CREATE TYPE "DeliveryRequestSource" AS ENUM ('SITEPRESSO', 'API', 'MANUAL');

-- CreateEnum
CREATE TYPE "DeliveryRequestStatus" AS ENUM ('PENDING', 'READY_FOR_DISPATCH', 'ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED', 'ATTEMPTED_FAILED', 'CANCELLED', 'RETURNED');

-- CreateEnum
CREATE TYPE "DeliveryRouteStatus" AS ENUM ('PENDING', 'DISPATCHED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryStopStatus" AS ENUM ('PENDING', 'EN_ROUTE', 'ARRIVED', 'DELIVERED', 'ATTEMPTED_FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "EcomDeliveryCashSettlementStatus" AS ENUM ('DRAFT', 'SETTLED', 'VOID');

-- CreateEnum
CREATE TYPE "DeliverySlotType" AS ENUM ('STANDARD', 'EXPRESS', 'SAME_DAY', 'NEXT_DAY', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "SlotBookingStatus" AS ENUM ('HELD', 'CONFIRMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "EcomReturnStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'COLLECTED', 'REFUNDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "EcomReturnReason" AS ENUM ('DAMAGED', 'WRONG_ITEM', 'EXPIRED', 'CHANGED_MIND', 'POOR_QUALITY', 'NOT_AS_DESCRIBED', 'ARRIVED_LATE', 'OTHER');

-- CreateEnum
CREATE TYPE "EcomReturnDisposition" AS ENUM ('PENDING', 'RESTOCK', 'SCRAP', 'RETURN_TO_SUPPLIER', 'HOLD_FOR_INSPECTION');

-- CreateEnum
CREATE TYPE "EcomReviewStatus" AS ENUM ('PENDING', 'PUBLISHED', 'HIDDEN', 'REJECTED');

-- CreateEnum
CREATE TYPE "EcomBannerPlacement" AS ENUM ('HOMEPAGE_HERO', 'HOMEPAGE_STRIP', 'CATEGORY_HERO', 'CART_UPSELL', 'ACCOUNT_OFFER', 'CHECKOUT_BANNER');

-- CreateEnum
CREATE TYPE "EcomCmsBlockType" AS ENUM ('HERO', 'FEATURED_COLLECTION', 'BESTSELLERS_AUTO', 'EDITORIAL_RICHTEXT', 'RECIPE_LINKED', 'TESTIMONIAL_STRIP', 'CATEGORY_GRID', 'COUPON_CALLOUT');

-- CreateEnum
CREATE TYPE "EcomCmsBlockStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "EntityStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'NON_BINARY', 'UNDISCLOSED', 'OTHER');

-- CreateEnum
CREATE TYPE "MaritalStatus" AS ENUM ('SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'SEPARATED', 'CIVIL_UNION', 'UNDISCLOSED');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('PRE_HIRE', 'PROBATION', 'ACTIVE', 'ON_LEAVE', 'NOTICE_PERIOD', 'SUSPENDED', 'TERMINATED', 'RETIRED');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'FIXED_TERM', 'CONTRACT', 'INTERN', 'APPRENTICE', 'CASUAL', 'CONSULTANT');

-- CreateEnum
CREATE TYPE "WorkerCategory" AS ENUM ('STAFF', 'WORKER');

-- CreateEnum
CREATE TYPE "EmploymentChangeReason" AS ENUM ('HIRE', 'PROMOTION', 'TRANSFER_LOCATION', 'TRANSFER_DEPARTMENT', 'REORG', 'MANAGER_CHANGE', 'TYPE_CHANGE', 'FTE_CHANGE', 'PROBATION_CONFIRM', 'REHIRE');

-- CreateEnum
CREATE TYPE "DependantRelation" AS ENUM ('SPOUSE', 'CHILD', 'PARENT', 'SIBLING', 'OTHER');

-- CreateEnum
CREATE TYPE "ComponentKind" AS ENUM ('BASIC', 'DEARNESS_ALLOWANCE', 'HRA', 'SPECIAL_ALLOWANCE', 'CONVEYANCE', 'MEDICAL', 'LTA', 'BONUS', 'COMMISSION', 'OVERTIME_PAY', 'ARREAR', 'PF_EMPLOYEE', 'ESI_EMPLOYEE', 'PT', 'TDS', 'KIWISAVER_EMPLOYEE', 'PAYE', 'STUDENT_LOAN', 'PF_EMPLOYER', 'ESI_EMPLOYER', 'EPS', 'EDLI', 'PF_ADMIN', 'GRATUITY_PROVISION', 'KIWISAVER_EMPLOYER', 'ESCT', 'ACC_EMPLOYER', 'LOAN_REPAYMENT', 'ADVANCE_RECOVERY', 'LEAVE_ENCASHMENT', 'NOTICE_RECOVERY', 'REIMBURSEMENT_FUEL', 'REIMBURSEMENT_PHONE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ComponentCategory" AS ENUM ('EARNING', 'DEDUCTION', 'EMPLOYER_COST', 'REIMBURSEMENT');

-- CreateEnum
CREATE TYPE "ComponentCalcMethod" AS ENUM ('FLAT', 'PERCENT_OF', 'FORMULA', 'SLAB', 'STATUTORY', 'BALANCING');

-- CreateEnum
CREATE TYPE "ComponentBaseScope" AS ENUM ('SINGLE', 'MULTIPLE', 'GROSS', 'CTC');

-- CreateEnum
CREATE TYPE "ProrationMethod" AS ENUM ('CALENDAR_DAYS', 'WORKING_DAYS', 'THIRTY_DAY_STANDARD', 'NONE');

-- CreateEnum
CREATE TYPE "StructureBasis" AS ENUM ('CTC', 'GROSS', 'NET');

-- CreateEnum
CREATE TYPE "CompRevisionReason" AS ENUM ('HIRE', 'ANNUAL_REVISION', 'PROMOTION', 'CORRECTION', 'RESTRUCTURE', 'STATUTORY_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "INTaxRegime" AS ENUM ('NEW', 'OLD');

-- CreateEnum
CREATE TYPE "KiwiSaverStatus" AS ENUM ('NOT_ENROLLED', 'ACTIVE', 'OPTED_OUT', 'SAVINGS_SUSPENSION', 'CASUAL_AGRICULTURAL');

-- CreateEnum
CREATE TYPE "RegistrationKind" AS ENUM ('EPF', 'ESI', 'PT_STATE', 'TAN', 'LWF', 'SHOPS_ESTABLISHMENT', 'IRD_PAYE', 'ACC');

-- CreateEnum
CREATE TYPE "PayFrequency" AS ENUM ('WEEKLY', 'FORTNIGHTLY', 'SEMI_MONTHLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "PayDayRule" AS ENUM ('LAST_WORKING_DAY', 'FIRST_WORKING_DAY', 'FIXED_DOM', 'N_DAYS_AFTER_PERIOD_END');

-- CreateEnum
CREATE TYPE "PayRunType" AS ENUM ('REGULAR', 'OFF_CYCLE', 'BONUS', 'ARREAR', 'FNF', 'CORRECTION', 'SUPPLEMENTARY');

-- CreateEnum
CREATE TYPE "PayRunStatus" AS ENUM ('DRAFT', 'INPUTS_LOCKED', 'COMPUTING', 'COMPUTED', 'REVIEW', 'LOCKED', 'APPROVED', 'PAID', 'FILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayRunLineStatus" AS ENUM ('PENDING', 'COMPUTED', 'ON_HOLD', 'ERROR', 'EXCLUDED', 'FINALIZED');

-- CreateEnum
CREATE TYPE "PayslipStatus" AS ENUM ('GENERATED', 'PUBLISHED', 'VIEWED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "RemittanceKind" AS ENUM ('IN_TDS', 'IN_PF', 'IN_ESI', 'IN_PT', 'IN_LWF', 'IN_FORM24Q', 'IN_FORM16', 'NZ_PAYE', 'NZ_PAYDAY_FILING', 'NZ_KIWISAVER', 'NZ_ESCT', 'NZ_STUDENT_LOAN', 'NZ_ACC');

-- CreateEnum
CREATE TYPE "RemittanceStatus" AS ENUM ('PENDING', 'DUE', 'FILED', 'PAID', 'OVERDUE', 'WAIVED');

-- CreateEnum
CREATE TYPE "LeaveCategory" AS ENUM ('ANNUAL', 'CASUAL', 'SICK', 'MATERNITY', 'PATERNITY', 'BEREAVEMENT', 'PUBLIC_HOLIDAY', 'ALTERNATIVE_DAY', 'COMP_OFF', 'UNPAID', 'SABBATICAL', 'MARRIAGE', 'ADOPTION', 'FAMILY_VIOLENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "LeaveUnit" AS ENUM ('DAYS', 'HOURS', 'WEEKS');

-- CreateEnum
CREATE TYPE "NZLeavePayBasis" AS ENUM ('RDP', 'ADP', 'AWE_8PCT', 'OWP');

-- CreateEnum
CREATE TYPE "AccrualMethod" AS ENUM ('UPFRONT_ANNUAL', 'MONTHLY_ACCRUAL', 'ANNIVERSARY_GRANT', 'WORKED_HOURS_RATIO', 'CONTINUOUS_NZ');

-- CreateEnum
CREATE TYPE "AccrualFrequency" AS ENUM ('MONTHLY', 'QUARTERLY', 'ANNUAL', 'PER_PAY_PERIOD');

-- CreateEnum
CREATE TYPE "AssignmentScope" AS ENUM ('ENTITY', 'DEPARTMENT', 'GRADE', 'EMPLOYMENT_TYPE', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "LeaveTxnType" AS ENUM ('ACCRUAL', 'APPLICATION', 'CANCELLATION', 'ENCASHMENT', 'LAPSE', 'ADJUSTMENT', 'OPENING_BALANCE');

-- CreateEnum
CREATE TYPE "LeaveTxnStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'WITHDRAWN', 'AVAILED');

-- CreateEnum
CREATE TYPE "DayHalf" AS ENUM ('FIRST_HALF', 'SECOND_HALF');

-- CreateEnum
CREATE TYPE "HolidayType" AS ENUM ('PUBLIC', 'NATIONAL', 'REGIONAL', 'COMPANY', 'RESTRICTED_OPTIONAL');

-- CreateEnum
CREATE TYPE "PunchType" AS ENUM ('IN', 'OUT', 'BREAK_START', 'BREAK_END');

-- CreateEnum
CREATE TYPE "PunchSource" AS ENUM ('WEB', 'MOBILE_APP', 'BIOMETRIC', 'KIOSK', 'GEO_FENCE', 'API', 'IMPORT', 'MANUAL');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'HALF_DAY', 'ON_LEAVE', 'WEEKLY_OFF', 'HOLIDAY', 'WORK_FROM_HOME', 'ON_DUTY', 'HOLIDAY_WORKED', 'MISSING_PUNCH');

-- CreateEnum
CREATE TYPE "TimesheetStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'LOCKED');

-- CreateEnum
CREATE TYPE "ExpenseClaimStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'REIMBURSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LoanType" AS ENUM ('LOAN', 'ADVANCE');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'DISBURSED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InstallmentStatus" AS ENUM ('PENDING', 'PAID', 'WAIVED');

-- CreateEnum
CREATE TYPE "SeparationType" AS ENUM ('RESIGNATION', 'TERMINATION_FOR_CAUSE', 'RETRENCHMENT', 'REDUNDANCY', 'END_OF_CONTRACT', 'RETIREMENT', 'DEATH', 'ABSCONDING', 'PROBATION_FAILURE', 'MUTUAL_SEPARATION');

-- CreateEnum
CREATE TYPE "SeparationStatus" AS ENUM ('INITIATED', 'NOTICE_SERVING', 'CLEARANCE_PENDING', 'FNF_PENDING', 'FNF_COMPUTED', 'FNF_APPROVED', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DocumentCategory" AS ENUM ('ID_PROOF', 'ADDRESS_PROOF', 'PAN', 'AADHAAR', 'PASSPORT', 'VISA', 'WORK_PERMIT', 'EDUCATION', 'EXPERIENCE', 'OFFER_LETTER', 'CONTRACT', 'PAYSLIP_COPY', 'TAX_DECLARATION', 'FORM16', 'BANK_PROOF', 'MEDICAL', 'POLICY_ACK', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentVisibility" AS ENUM ('HR_ONLY', 'MANAGER_AND_HR', 'EMPLOYEE_VISIBLE');

-- CreateEnum
CREATE TYPE "SignatureStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'SIGNED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TemplateKind" AS ENUM ('OFFER_LETTER', 'APPOINTMENT_LETTER', 'CONFIRMATION_LETTER', 'PROMOTION_LETTER', 'RELIEVING_LETTER', 'EXPERIENCE_LETTER', 'SALARY_CERTIFICATE', 'WARNING_LETTER', 'PAYSLIP', 'FORM16', 'FNF_STATEMENT', 'POLICY_ACK', 'OTHER');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AssetCategory" AS ENUM ('LAPTOP', 'DESKTOP', 'MOBILE', 'MONITOR', 'ACCESSORY', 'SIM', 'VEHICLE', 'FURNITURE', 'ID_CARD', 'ACCESS_CARD', 'SOFTWARE_LICENSE', 'OTHER');

-- CreateEnum
CREATE TYPE "AssetCondition" AS ENUM ('NEW', 'GOOD', 'FAIR', 'DAMAGED', 'RETIRED');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('AVAILABLE', 'ASSIGNED', 'IN_REPAIR', 'LOST', 'RETIRED');

-- CreateEnum
CREATE TYPE "AssetAssignmentStatus" AS ENUM ('ASSIGNED', 'RETURNED', 'LOST', 'DAMAGED', 'PENDING_RECOVERY');

-- CreateEnum
CREATE TYPE "ReviewCycleType" AS ENUM ('ANNUAL', 'HALF_YEARLY', 'QUARTERLY', 'PROBATION', 'PROJECT', 'CONTINUOUS');

-- CreateEnum
CREATE TYPE "ReviewCycleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SELF_REVIEW', 'MANAGER_REVIEW', 'CALIBRATION', 'CLOSED');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('NOT_STARTED', 'SELF_SUBMITTED', 'MANAGER_SUBMITTED', 'CALIBRATED', 'ACKNOWLEDGED', 'CLOSED');

-- CreateEnum
CREATE TYPE "GoalCategory" AS ENUM ('ORGANIZATION', 'DEPARTMENT', 'TEAM', 'INDIVIDUAL', 'DEVELOPMENT');

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ON_TRACK', 'AT_RISK', 'ACHIEVED', 'MISSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('DRAFT', 'OPEN', 'ON_HOLD', 'CLOSED', 'CANCELLED', 'FILLED');

-- CreateEnum
CREATE TYPE "StageKind" AS ENUM ('SOURCED', 'SCREENING', 'INTERVIEW', 'ASSESSMENT', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('APPLIED', 'SCREENING', 'INTERVIEWING', 'ASSESSMENT', 'OFFERED', 'HIRED', 'REJECTED', 'WITHDRAWN', 'ON_HOLD');

-- CreateEnum
CREATE TYPE "InterviewMode" AS ENUM ('ONSITE', 'VIDEO', 'PHONE');

-- CreateEnum
CREATE TYPE "InterviewRecommendation" AS ENUM ('STRONG_YES', 'YES', 'NEUTRAL', 'NO', 'STRONG_NO');

-- CreateEnum
CREATE TYPE "InterviewStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED', 'RESCHEDULED');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_ON_EMPLOYEE', 'RESOLVED', 'CLOSED', 'REOPENED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkflowModule" AS ENUM ('LEAVE', 'EXPENSE', 'LOAN', 'COMPENSATION', 'OFFER', 'PROFILE_CHANGE', 'TIMESHEET', 'ATTENDANCE_REGULARIZATION', 'SEPARATION', 'ASSET', 'DOCUMENT_SIGN', 'PAYRUN');

-- CreateEnum
CREATE TYPE "ApproverType" AS ENUM ('REPORTING_MANAGER', 'DEPARTMENT_HEAD', 'HR', 'PAYROLL_MANAGER', 'SPECIFIC_ROLE', 'SPECIFIC_EMPLOYEE', 'AUTO_APPROVE');

-- CreateEnum
CREATE TYPE "TimeoutAction" AS ENUM ('ESCALATE', 'AUTO_APPROVE', 'AUTO_REJECT', 'REMIND');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'ESCALATED', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED', 'REQUESTED_CHANGES', 'DELEGATED', 'ABSTAINED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('PAYSLIP_PUBLISHED', 'LEAVE_REQUESTED', 'LEAVE_APPROVED', 'LEAVE_REJECTED', 'EXPENSE_SUBMITTED', 'EXPENSE_APPROVED', 'LOAN_APPROVED', 'APPROVAL_PENDING', 'DOC_EXPIRING', 'BIRTHDAY', 'ANNIVERSARY', 'REVIEW_DUE', 'TIMESHEET_DUE', 'STATUTORY_DUE', 'ONBOARDING_TASK', 'OFFBOARDING_TASK', 'ASSET_RETURN_DUE');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'READ');

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "businessId" TEXT,
    "resetToken" TEXT,
    "resetTokenExpiry" TIMESTAMP(3),
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "emailOtp" TEXT,
    "emailOtpExpiry" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3),
    "otpAttempts" INTEGER NOT NULL DEFAULT 0,
    "avatarUrl" TEXT,
    "signatureUrl" TEXT,
    "stampUrl" TEXT,
    "pendingDeletionAt" TIMESTAMP(3),
    "anonymisedAt" TIMESTAMP(3),
    "subtitle" TEXT,
    "bio" TEXT,
    "registrationNumber" TEXT,
    "qualification" TEXT,
    "speciality" TEXT,
    "languages" TEXT,
    "experienceYears" INTEGER,
    "consultationFee" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "showOnWebsite" BOOLEAN NOT NULL DEFAULT true,
    "isServiceProvider" BOOLEAN NOT NULL DEFAULT true,
    "termsAcceptedAt" TIMESTAMP(3),
    "termsVersion" TEXT,
    "calendarFeedToken" TEXT,
    "preferredLanguage" TEXT,
    "businessRoleId" TEXT,
    "specialtyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Business" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "slugLastChangedAt" TIMESTAMP(3),
    "shortId" TEXT,
    "description" TEXT,
    "address" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "postalCode" TEXT,
    "state" TEXT,
    "country" TEXT,
    "region" TEXT,
    "timezone" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "category" TEXT,
    "bookingType" TEXT NOT NULL DEFAULT 'POSTPAID',
    "multiStoreMode" TEXT NOT NULL DEFAULT 'OFF',
    "categoryMaxDepth" INTEGER NOT NULL DEFAULT 2,
    "featureFlags" JSONB,
    "appointmentReminderConfig" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "suspendedReason" TEXT,
    "suspendedAt" TIMESTAMP(3),
    "pendingDeletionAt" TIMESTAMP(3),
    "anonymisedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "autoApproveLeave" BOOLEAN NOT NULL DEFAULT false,
    "autoConfirmBookings" BOOLEAN NOT NULL DEFAULT false,
    "reviewRequestEnabled" BOOLEAN NOT NULL DEFAULT true,
    "reviewRequestLink" TEXT,
    "defaultLanguage" TEXT,
    "vertical" TEXT NOT NULL DEFAULT 'APPOINTMENT',
    "defaultCurrency" TEXT,
    "currencyChangedAt" TIMESTAMP(3),
    "billingPurchaserType" TEXT NOT NULL DEFAULT 'INDIVIDUAL',
    "billingBusinessName" TEXT,
    "billingContactName" TEXT,
    "billingEmail" TEXT,
    "billingTaxId" TEXT,
    "billingAddressLine1" TEXT,
    "billingAddressLine2" TEXT,
    "billingCity" TEXT,
    "billingState" TEXT,
    "billingPostalCode" TEXT,
    "billingCountry" TEXT,
    "paddleBillingAddressId" TEXT,
    "paddleBillingBusinessId" TEXT,
    "whatsappOrderNumber" TEXT,
    "whatsappOrdersEnabled" BOOLEAN NOT NULL DEFAULT false,
    "supportedCurrencies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "siteNav" JSONB,
    "announcementBarEnabled" BOOLEAN NOT NULL DEFAULT false,
    "announcementBarText" TEXT,
    "announcementBarBgColor" TEXT NOT NULL DEFAULT '#146A39',
    "announcementBarTextColor" TEXT NOT NULL DEFAULT '#ffffff',
    "wishlistEnabled" BOOLEAN NOT NULL DEFAULT true,
    "wishlistIconType" TEXT NOT NULL DEFAULT 'bookmark',
    "categoryGridDisplay" TEXT NOT NULL DEFAULT 'main',
    "paymentMode" TEXT NOT NULL DEFAULT 'BOTH',
    "pickupEnabled" BOOLEAN NOT NULL DEFAULT false,
    "deliveryMode" TEXT NOT NULL DEFAULT 'ASAP',
    "flatDeliveryFeeMinor" INTEGER NOT NULL DEFAULT 0,
    "flatFreeDeliveryThresholdMinor" INTEGER NOT NULL DEFAULT 0,
    "deliveryEtaMinutes" INTEGER,

    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessPage" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "parentNav" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "content" JSONB NOT NULL DEFAULT '{}',
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "placement" "PagePlacement" NOT NULL DEFAULT 'DROPDOWN',
    "iconKey" TEXT,
    "metaTitle" TEXT,
    "metaDescription" TEXT,
    "metaKeywords" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessSeoSettings" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "siteTitle" TEXT,
    "siteDescription" TEXT,
    "defaultKeywords" TEXT,
    "canonicalDomain" TEXT,
    "defaultOgImageUrl" TEXT,
    "googleAnalyticsId" TEXT,
    "googleTagManagerId" TEXT,
    "googleSearchConsoleVerification" TEXT,
    "metaPixelId" TEXT,
    "bingVerification" TEXT,
    "customChatWidgetScript" TEXT,
    "allowIndexing" BOOLEAN NOT NULL DEFAULT true,
    "aiCrawlerPolicy" TEXT NOT NULL DEFAULT 'allow',
    "enableLlmsTxt" BOOLEAN NOT NULL DEFAULT true,
    "schemaType" TEXT,
    "socialSameAs" TEXT,
    "metaTemplates" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessSeoSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoPageOverride" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "pageType" TEXT NOT NULL,
    "entityId" TEXT,
    "pageTitle" TEXT,
    "metaTitle" TEXT,
    "metaDescription" TEXT,
    "keywords" TEXT,
    "canonicalUrl" TEXT,
    "ogTitle" TEXT,
    "ogDescription" TEXT,
    "ogImageUrl" TEXT,
    "noIndex" BOOLEAN NOT NULL DEFAULT false,
    "includeInSitemap" BOOLEAN NOT NULL DEFAULT true,
    "sitemapPriority" DOUBLE PRECISION,
    "changeFrequency" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoPageOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "categoryId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "brand" TEXT,
    "description" TEXT,
    "shortDescription" TEXT,
    "sku" TEXT,
    "barcode" TEXT,
    "qrCode" TEXT,
    "priceMinor" INTEGER NOT NULL,
    "comparePriceMinor" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "discountDisplayMode" TEXT NOT NULL DEFAULT 'PERCENTAGE',
    "stockQty" INTEGER,
    "weightGrams" INTEGER,
    "weightDisplay" TEXT,
    "soldByWeight" BOOLEAN NOT NULL DEFAULT false,
    "pricePerKgMinor" INTEGER,
    "imageUrls" JSONB NOT NULL DEFAULT '[]',
    "specs" JSONB,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "metaTitle" TEXT,
    "metaDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "storeBrandId" TEXT,
    "brandId" TEXT,
    "isSample" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductPrice" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "comparePriceMinor" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sku" TEXT,
    "priceMinor" INTEGER NOT NULL,
    "comparePriceMinor" INTEGER,
    "stockQty" INTEGER,
    "option1Name" TEXT,
    "option1Value" TEXT,
    "option2Name" TEXT,
    "option2Value" TEXT,
    "swatchHex" TEXT,
    "imageUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wishlist" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wishlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WishlistItem" (
    "id" TEXT NOT NULL,
    "wishlistId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WishlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCategory" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "isSample" BOOLEAN NOT NULL DEFAULT false,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cart" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "sessionId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "locationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CartItem" (
    "id" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "quantity" INTEGER NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "substitutionPref" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CartItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "customerEmail" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT,
    "shippingAddress" JSONB NOT NULL,
    "paymentMethod" TEXT,
    "locationId" TEXT,
    "fulfillmentType" TEXT NOT NULL DEFAULT 'DELIVERY',
    "pickupLocationId" TEXT,
    "pickupCode" TEXT,
    "pickupReadyAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "subtotalMinor" INTEGER NOT NULL,
    "shippingMinor" INTEGER NOT NULL DEFAULT 0,
    "taxMinor" INTEGER NOT NULL DEFAULT 0,
    "totalMinor" INTEGER NOT NULL,
    "paymentProvider" TEXT,
    "paymentRef" TEXT,
    "couponCode" TEXT,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "adjustedTotalMinor" INTEGER,
    "refundedMinor" INTEGER NOT NULL DEFAULT 0,
    "substitutionPolicy" TEXT,
    "promisedAt" TIMESTAMP(3),
    "deliverySlotId" TEXT,
    "deliveryDate" TIMESTAMP(3),
    "deliverySlotLabel" TEXT,
    "deliverySlotSurchargeMinor" INTEGER NOT NULL DEFAULT 0,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT NOT NULL,
    "productSlug" TEXT,
    "quantity" INTEGER NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "lineTotalMinor" INTEGER NOT NULL,
    "soldByWeight" BOOLEAN NOT NULL DEFAULT false,
    "pricePerKgMinor" INTEGER,
    "orderedWeightGrams" INTEGER,
    "pickedWeightGrams" INTEGER,
    "fulfillmentStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "exceptionReason" TEXT,
    "shortedQuantity" INTEGER NOT NULL DEFAULT 0,
    "substitutionStatus" TEXT,
    "substituteProductId" TEXT,
    "substituteProductName" TEXT,
    "substitutePriceMinor" INTEGER,
    "substituteQuantity" INTEGER,
    "substituteWeightGrams" INTEGER,
    "substitutionPref" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessIntegration" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "scopes" TEXT,
    "externalAccountId" TEXT,
    "externalAccountEmail" TEXT,
    "refreshTokenEncrypted" TEXT,
    "accessTokenEncrypted" TEXT,
    "accessTokenExpiry" TIMESTAMP(3),
    "connectedByUserId" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enquiry" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "subject" TEXT,
    "message" TEXT NOT NULL,
    "status" "EnquiryStatus" NOT NULL DEFAULT 'NEW',
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Enquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessHours" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "openTime" TEXT NOT NULL,
    "closeTime" TEXT NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BusinessHours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessHoliday" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "locationId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "googleId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "pendingDeletionAt" TIMESTAMP(3),
    "anonymisedAt" TIMESTAMP(3),
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "emailOtp" TEXT,
    "emailOtpExpiry" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3),
    "otpAttempts" INTEGER NOT NULL DEFAULT 0,
    "hasPassword" BOOLEAN NOT NULL DEFAULT true,
    "termsAcceptedAt" TIMESTAMP(3),
    "termsVersion" TEXT,
    "calendarFeedToken" TEXT,
    "avatarUrl" TEXT,
    "preferredLanguage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "notificationPrefs" JSONB,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerIdentity" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "CustomerIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerAddress" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "label" TEXT,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT,
    "postalCode" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessContent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "heroHeadline" TEXT,
    "heroSubheading" TEXT,
    "heroCtaText" TEXT,
    "aboutTitle" TEXT,
    "aboutBody" TEXT,
    "logoUrl" TEXT,
    "logoSourceUrl" TEXT,
    "logoAspect" TEXT,
    "faviconUrl" TEXT,
    "tagline" TEXT,
    "servicesIntro" TEXT,
    "showStats" BOOLEAN NOT NULL DEFAULT true,
    "showServices" BOOLEAN NOT NULL DEFAULT true,
    "showAbout" BOOLEAN NOT NULL DEFAULT true,
    "showTeam" BOOLEAN NOT NULL DEFAULT true,
    "showTestimonials" BOOLEAN NOT NULL DEFAULT true,
    "showContact" BOOLEAN NOT NULL DEFAULT true,
    "showCta" BOOLEAN NOT NULL DEFAULT true,
    "testimonials" TEXT,
    "cmsServices" TEXT,
    "cmsTeam" TEXT,
    "letterheadSettings" TEXT,
    "letterhead2Settings" TEXT,
    "followUpSettings" TEXT,
    "contactTitle" TEXT,
    "contactBody" TEXT,
    "businessEmail" TEXT,
    "businessHoursText" TEXT,
    "businessAddressOverride" TEXT,
    "businessPhoneOverride" TEXT,
    "showTopBar" BOOLEAN NOT NULL DEFAULT true,
    "showTopBarEmail" BOOLEAN NOT NULL DEFAULT true,
    "showTopBarAddress" BOOLEAN NOT NULL DEFAULT true,
    "showTopBarHours" BOOLEAN NOT NULL DEFAULT true,
    "showTopBarPhone" BOOLEAN NOT NULL DEFAULT true,
    "socialFacebook" TEXT,
    "socialInstagram" TEXT,
    "socialTwitter" TEXT,
    "socialLinkedin" TEXT,
    "socialYoutube" TEXT,
    "showSocialFacebook" BOOLEAN NOT NULL DEFAULT true,
    "showSocialInstagram" BOOLEAN NOT NULL DEFAULT true,
    "showSocialTwitter" BOOLEAN NOT NULL DEFAULT true,
    "showSocialLinkedin" BOOLEAN NOT NULL DEFAULT true,
    "showSocialYoutube" BOOLEAN NOT NULL DEFAULT true,
    "heroBannerUrl" TEXT,
    "heroLine3" TEXT,
    "showHero" BOOLEAN NOT NULL DEFAULT true,
    "heroBannerPosX" INTEGER,
    "heroBannerPosY" INTEGER,
    "heroBannerZoom" INTEGER,
    "heroTrust1" TEXT,
    "heroTrust2" TEXT,
    "heroTrust3" TEXT,
    "showHeroTrust" BOOLEAN NOT NULL DEFAULT true,
    "showNavHome" BOOLEAN NOT NULL DEFAULT true,
    "showNavServices" BOOLEAN NOT NULL DEFAULT true,
    "showNavAbout" BOOLEAN NOT NULL DEFAULT true,
    "showNavContact" BOOLEAN NOT NULL DEFAULT true,
    "navbarBusinessName" TEXT,
    "showLogo" BOOLEAN NOT NULL DEFAULT true,
    "showBusinessName" BOOLEAN NOT NULL DEFAULT true,
    "showTagline" BOOLEAN NOT NULL DEFAULT true,
    "ctaHeadline" TEXT,
    "ctaBody" TEXT,
    "ctaBackgroundUrl" TEXT,
    "ctaBackgroundPosX" INTEGER,
    "ctaBackgroundPosY" INTEGER,
    "ctaBackgroundZoom" INTEGER,
    "aboutImageUrl" TEXT,
    "aboutImagePosition" TEXT,
    "aboutImagePosX" INTEGER,
    "aboutImagePosY" INTEGER,
    "aboutImageZoom" INTEGER,
    "teamTitle" TEXT,
    "teamIntro" TEXT,
    "statsItems" TEXT,
    "policies" TEXT,
    "pricingTiers" TEXT,
    "showPricing" BOOLEAN NOT NULL DEFAULT false,
    "pricingEyebrow" TEXT,
    "pricingTitle" TEXT,
    "pricingIntro" TEXT,
    "servicesImageUrl" TEXT,
    "servicesImagePosX" INTEGER,
    "servicesImagePosY" INTEGER,
    "servicesImageZoom" INTEGER,
    "footerDescription" TEXT,
    "footerCopyright" TEXT,
    "footerQuickLinksTitle" TEXT,
    "footerContactTitle" TEXT,
    "showFooter" BOOLEAN NOT NULL DEFAULT true,
    "showFooterQuickLinks" BOOLEAN NOT NULL DEFAULT true,
    "showFooterContact" BOOLEAN NOT NULL DEFAULT true,
    "navHomeLabel" TEXT,
    "navServicesLabel" TEXT,
    "navPricingLabel" TEXT,
    "navAboutLabel" TEXT,
    "navTeamLabel" TEXT,
    "navGalleryLabel" TEXT,
    "navTestimonialsLabel" TEXT,
    "navBookingLabel" TEXT,
    "navFaqLabel" TEXT,
    "navContactLabel" TEXT,
    "contactCardTitle" TEXT,
    "contactCardBody" TEXT,
    "aboutAddressLabel" TEXT,
    "aboutPhoneLabel" TEXT,
    "footerLinkBookLabel" TEXT,
    "footerLinkBookingsLabel" TEXT,
    "footerLinkAboutLabel" TEXT,
    "footerLinkServicesLabel" TEXT,
    "footerLinkContactLabel" TEXT,
    "footerLinkSignInLabel" TEXT,
    "inactiveNoticeTitle" TEXT,
    "inactiveNoticeBody" TEXT,
    "aboutEyebrow" TEXT,
    "aboutHighlights" TEXT,
    "servicesEyebrow" TEXT,
    "servicesTitle" TEXT,
    "teamEyebrow" TEXT,
    "teamMemberLabel" TEXT,
    "testimonialsEyebrow" TEXT,
    "testimonialsTitle" TEXT,
    "contactEyebrow" TEXT,
    "sectionOrder" TEXT,
    "hiddenSections" TEXT,
    "layoutText" TEXT,
    "customPrimary" TEXT,
    "customBg" TEXT,
    "customSurface" TEXT,
    "customText" TEXT,
    "customMuted" TEXT,
    "customAccent" TEXT,
    "showGallery" BOOLEAN NOT NULL DEFAULT false,
    "galleryEyebrow" TEXT,
    "galleryTitle" TEXT,
    "gallerySub" TEXT,
    "galleryItems" TEXT,
    "showFaq" BOOLEAN NOT NULL DEFAULT false,
    "faqEyebrow" TEXT,
    "faqTitle" TEXT,
    "faqIntro" TEXT,
    "faqItems" TEXT,
    "showLocations" BOOLEAN NOT NULL DEFAULT false,
    "locationsEyebrow" TEXT,
    "locationsTitle" TEXT,
    "locationsIntro" TEXT,
    "navLocationsLabel" TEXT,
    "showBooking" BOOLEAN NOT NULL DEFAULT true,
    "bookingEyebrow" TEXT,
    "bookingTitle" TEXT,
    "bookingSub" TEXT,
    "bookingCta" TEXT,
    "enquiryFormTitle" TEXT,
    "enquiryFormBody" TEXT,
    "enquiryFormCta" TEXT,
    "enquiryThanksTitle" TEXT,
    "enquiryThanksBody" TEXT,
    "showBlogServices" BOOLEAN NOT NULL DEFAULT false,
    "showBlogAbout" BOOLEAN NOT NULL DEFAULT false,
    "showBlogTestimonials" BOOLEAN NOT NULL DEFAULT false,
    "showBlogContact" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentPeriodEnd" TIMESTAMP(3),
    "seatsUsed" INTEGER NOT NULL DEFAULT 1,
    "billingCycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY',
    "theme" TEXT NOT NULL DEFAULT 'default',
    "themeStyle" TEXT NOT NULL DEFAULT 'light',
    "themeColors" TEXT,
    "designPreset" TEXT,
    "sectionVariants" TEXT,
    "paddleCustomerId" TEXT,
    "paddleSubscriptionId" TEXT,
    "paddleTransactionId" TEXT,
    "gateway" TEXT NOT NULL DEFAULT 'PADDLE',
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "razorpayCustomerId" TEXT,
    "razorpaySubscriptionId" TEXT,
    "billingModel" TEXT NOT NULL DEFAULT 'SUBSCRIPTION',
    "razorpayTokenId" TEXT,
    "mandateMaxAmount" INTEGER,
    "mandateStatus" TEXT,
    "mandateMethod" TEXT,
    "nextChargeAt" TIMESTAMP(3),
    "preDebitNotifiedAt" TIMESTAMP(3),
    "lastChargeAttemptAt" TIMESTAMP(3),
    "pendingTierSlug" TEXT,
    "pendingBillingCycle" "BillingCycle",
    "pendingChangeEffectiveAt" TIMESTAMP(3),
    "pendingVertical" TEXT,
    "customDomain" TEXT,
    "customDomainVerified" BOOLEAN NOT NULL DEFAULT false,
    "customHostnameId" TEXT,
    "customDomainStatus" TEXT DEFAULT 'NONE',
    "customDomainStatusMessage" TEXT,
    "customDomainCheckedAt" TIMESTAMP(3),
    "trialPlanSlug" TEXT,
    "trialStartedAt" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "trialConvertedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "lastPaddleEventAt" TIMESTAMP(3),
    "lastPaddleEventId" TEXT,
    "pastDueSince" TIMESTAMP(3),
    "accessGraceUntil" TIMESTAMP(3),
    "themeChangedAt" TIMESTAMP(3),
    "themeChangeMonthCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaddleWebhookEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "businessId" TEXT,
    "objectId" TEXT,
    "notificationId" TEXT,
    "occurredAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaddleWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeWebhookEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "businessId" TEXT,
    "objectId" TEXT,
    "occurredAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RazorpayWebhookEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "businessId" TEXT,
    "objectId" TEXT,
    "occurredAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RazorpayWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaddleBillingSubscription" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productKind" TEXT NOT NULL,
    "productRef" TEXT,
    "status" TEXT NOT NULL,
    "billingCycle" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "currencyCode" TEXT,
    "unitAmountMinor" INTEGER,
    "paddleCustomerId" TEXT,
    "paddleSubscriptionId" TEXT,
    "paddleTransactionId" TEXT,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "nextBilledAt" TIMESTAMP(3),
    "scheduledChangeAction" TEXT,
    "lastPaddleEventAt" TIMESTAMP(3),
    "lastPaddleEventId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaddleBillingSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPurchase" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productKind" TEXT NOT NULL,
    "checkoutKind" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CHECKOUT_CREATED',
    "expectedPriceId" TEXT,
    "expectedCurrencyCode" TEXT,
    "expectedAmountMinor" INTEGER,
    "actualCurrencyCode" TEXT,
    "actualSubtotalMinor" INTEGER,
    "actualTaxMinor" INTEGER,
    "actualTotalMinor" INTEGER,
    "paddleCustomerId" TEXT,
    "paddleTransactionId" TEXT,
    "paddleSubscriptionId" TEXT,
    "invoiceId" TEXT,
    "invoiceNumber" TEXT,
    "invoiceUrl" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessagingTopupGrant" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "purchaseId" TEXT,
    "cycle" TEXT NOT NULL,
    "amountUsd" DECIMAL(10,2) NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "paddleTransactionId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessagingTopupGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "purchaseId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'paddle',
    "status" TEXT NOT NULL,
    "amountMinor" INTEGER,
    "currencyCode" TEXT,
    "paddleTransactionId" TEXT,
    "invoiceNumber" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceCounter" (
    "series" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceCounter_pkey" PRIMARY KEY ("series")
);

-- CreateTable
CREATE TABLE "AdjustmentLedger" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "purchaseId" TEXT,
    "paddleAdjustmentId" TEXT,
    "paddleTransactionId" TEXT,
    "paddleSubscriptionId" TEXT,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "currencyCode" TEXT,
    "amountMinor" INTEGER,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdjustmentLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "duration" INTEGER NOT NULL,
    "price" DOUBLE PRECISION,
    "imageUrl" TEXT,
    "features" TEXT,
    "highlighted" BOOLEAN NOT NULL DEFAULT false,
    "isVirtual" BOOLEAN NOT NULL DEFAULT false,
    "virtualMeetingUrl" TEXT,
    "businessId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "requiresPrepayment" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "intakeFormId" TEXT,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffSchedule" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "lunchStart" TEXT,
    "lunchEnd" TEXT,
    "locationId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Waitlist" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "serviceId" TEXT,
    "staffId" TEXT,
    "preferredDate" TIMESTAMP(3) NOT NULL,
    "preferredStartTime" TEXT,
    "preferredEndTime" TEXT,
    "notes" TEXT,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Waitlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "userId" TEXT,
    "customerId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "originalPrice" DOUBLE PRECISION,
    "discountAmount" DOUBLE PRECISION,
    "finalPrice" DOUBLE PRECISION,
    "couponCode" TEXT,
    "bookingChannel" TEXT NOT NULL DEFAULT 'ONLINE',
    "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID',
    "paymentMethod" TEXT,
    "paidAmount" DOUBLE PRECISION DEFAULT 0,
    "paidAt" TIMESTAMP(3),
    "paymentReference" TEXT,
    "paymentReceivedById" TEXT,
    "paymentGateway" TEXT,
    "gatewayOrderId" TEXT,
    "meetingUrl" TEXT,
    "locationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Specialty" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Specialty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentReminder" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'DAY_BEFORE',
    "channel" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT true,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "customerId" TEXT,
    "staffId" TEXT,
    "rating" INTEGER NOT NULL,
    "body" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentPrescription" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "createdById" TEXT,
    "patientName" TEXT,
    "patientContact" TEXT,
    "clinicalJson" TEXT NOT NULL,
    "medicinesJson" TEXT NOT NULL,
    "letterheadJson" TEXT,
    "doctorSnapshotJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentPrescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentInvoice" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "currency" TEXT,
    "lineItemsJson" TEXT NOT NULL,
    "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxLabel" TEXT,
    "patientName" TEXT,
    "patientContact" TEXT,
    "snapshotJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RxTemplate" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "createdById" TEXT,
    "name" TEXT NOT NULL,
    "medicinesJson" TEXT NOT NULL,
    "clinicalJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RxTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentDocument" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "createdById" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT,
    "recipientName" TEXT,
    "recipientContact" TEXT,
    "payloadJson" TEXT NOT NULL,
    "letterheadJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "issuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffLeave" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "startTime" TEXT,
    "endTime" TEXT,
    "isFullDay" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "autoApproved" BOOLEAN NOT NULL DEFAULT false,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffLeave_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationBanner" (
    "id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" "BannerType" NOT NULL DEFAULT 'INFO',
    "target" "BannerTarget" NOT NULL DEFAULT 'ALL',
    "businessId" TEXT,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "dismissible" BOOLEAN NOT NULL DEFAULT true,
    "linkUrl" TEXT,
    "linkText" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationBanner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxNotification" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT,
    "customerId" TEXT,
    "appointmentId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "ctaLabel" TEXT,
    "ctaUrl" TEXT,
    "metadata" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportConversation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "projectKey" TEXT NOT NULL DEFAULT 'sitepresso',
    "channel" TEXT NOT NULL DEFAULT 'CUSTOMER_SUPPORT',
    "sourceUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "subject" TEXT,
    "visitorName" TEXT,
    "visitorEmail" TEXT,
    "visitorPhone" TEXT,
    "visitorToken" TEXT,
    "customerId" TEXT,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantReadAt" TIMESTAMP(3),
    "platformReadAt" TIMESTAMP(3),
    "visitorReadAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "senderType" TEXT NOT NULL,
    "userId" TEXT,
    "customerId" TEXT,
    "senderName" TEXT,
    "senderEmail" TEXT,
    "body" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailDelivery" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "category" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'AWS_SES',
    "senderEmail" TEXT,
    "recipientEmail" TEXT NOT NULL,
    "actualRecipientEmail" TEXT,
    "recipientName" TEXT,
    "subject" TEXT NOT NULL,
    "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "businessId" TEXT,
    "userId" TEXT,
    "customerId" TEXT,
    "appointmentId" TEXT,
    "subscriptionId" TEXT,
    "metadata" JSONB,
    "providerMessageId" TEXT,
    "errorMessage" TEXT,
    "overrideApplied" BOOLEAN NOT NULL DEFAULT false,
    "attemptedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "discountType" "DiscountType" NOT NULL,
    "discountValue" DOUBLE PRECISION NOT NULL,
    "minOrderAmount" DOUBLE PRECISION,
    "maxDiscount" DOUBLE PRECISION,
    "maxUses" INTEGER,
    "maxUsesPerCustomer" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "applicableServiceIds" TEXT[],
    "applicableCategoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isFirstBookingOnly" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouponRedemption" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "customerId" TEXT,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "sessionId" TEXT,
    "appointmentId" TEXT,
    "orderId" TEXT,
    "discountAmount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminCoupon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "benefitType" "AdminCouponBenefitType" NOT NULL,
    "benefitValue" DOUBLE PRECISION,
    "benefitUnit" "AdminCouponBenefitUnit",
    "benefitCurrency" TEXT,
    "allowedCountries" TEXT[],
    "allowedEmails" TEXT[],
    "allowedBusinessIds" TEXT[],
    "applicableTiers" TEXT[],
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "maxTotalUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "maxPerUser" INTEGER,
    "firstSubscriptionOnly" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "paddleDiscountId" TEXT,
    "paddleDiscountStatus" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminCoupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminCouponRedemption" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "benefitSnapshot" JSONB NOT NULL,
    "appliedFreeDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminCouponRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingTier" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "vertical" TEXT NOT NULL DEFAULT 'APPOINTMENT',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "badge" TEXT,
    "tagline" TEXT,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ctaLabel" TEXT,
    "ctaHref" TEXT,
    "highlighted" BOOLEAN NOT NULL DEFAULT false,
    "includedStaff" INTEGER,
    "includedBranches" INTEGER,
    "contactSalesAboveBranches" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isCustomPriced" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "trialDays" INTEGER,
    "messagingBudgetPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingZone" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "multiplier" DECIMAL(5,4) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CountryZoneAssignment" (
    "id" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "countryName" TEXT NOT NULL,
    "region" TEXT,
    "currencyCode" TEXT NOT NULL,
    "currencySymbol" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "isOverride" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CountryZoneAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TierPrice" (
    "id" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "countryCode" TEXT,
    "currencyCode" TEXT NOT NULL,
    "amountMonthlyMinor" INTEGER NOT NULL,
    "amountAnnualMinor" INTEGER NOT NULL,
    "overageStaffPriceMinor" INTEGER NOT NULL DEFAULT 0,
    "overageBranchPriceMinor" INTEGER NOT NULL DEFAULT 0,
    "isOverride" BOOLEAN NOT NULL DEFAULT false,
    "paddlePriceIdMonthly" TEXT,
    "paddlePriceIdAnnual" TEXT,
    "stripePriceIdMonthly" TEXT,
    "stripePriceIdAnnual" TEXT,
    "razorpayPlanIdMonthly" TEXT,
    "razorpayPlanIdAnnual" TEXT,
    "lastSyncedToPaddleAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TierPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TierFeature" (
    "id" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "featureType" "TierFeatureType" NOT NULL,
    "featureValue" TEXT NOT NULL,
    "displayLabel" TEXT NOT NULL,
    "description" TEXT,
    "isHighlighted" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TierFeature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingAuditLog" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "changedBy" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderPriceCache" (
    "id" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "providerCostUsd" DECIMAL(10,6) NOT NULL,
    "source" TEXT NOT NULL,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "lastRefreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderPriceCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationConfig" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "managedSmsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "managedWhatsappEnabled" BOOLEAN NOT NULL DEFAULT false,
    "budgetOverridePercent" DECIMAL(5,2),
    "requestAccessStatus" TEXT NOT NULL DEFAULT 'NONE',
    "requestAccessNote" TEXT,
    "requestAccessAt" TIMESTAMP(3),
    "requestReviewedAt" TIMESTAMP(3),
    "requestReviewedBy" TEXT,
    "eventChannels" JSONB NOT NULL DEFAULT '{}',
    "quotaExhaustedAction" TEXT NOT NULL DEFAULT 'PAUSE',
    "quotaExhaustedNotified" BOOLEAN NOT NULL DEFAULT false,
    "smsTermsAcceptedAt" TIMESTAMP(3),
    "smsTermsVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "vertical" TEXT NOT NULL DEFAULT 'ALL',
    "body" TEXT NOT NULL,
    "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "msg91TemplateId" TEXT,
    "twilioContentSid" TEXT,
    "approvalStatus" TEXT NOT NULL DEFAULT 'DRAFT',
    "approvalNote" TEXT,
    "approvedAt" TIMESTAMP(3),
    "smsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "whatsappEnabled" BOOLEAN NOT NULL DEFAULT false,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageDelivery" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "recipientPhone" TEXT,
    "recipientEmail" TEXT,
    "recipientCountry" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "templateId" TEXT,
    "bodySnapshot" TEXT NOT NULL,
    "variables" JSONB,
    "providerCostUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "triggeredBy" TEXT NOT NULL,
    "appointmentId" TEXT,
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "MessageDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetUsage" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "cycle" TEXT NOT NULL,
    "smsSpentUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "whatsappSpentUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "smsCount" INTEGER NOT NULL DEFAULT 0,
    "whatsappCount" INTEGER NOT NULL DEFAULT 0,
    "overagePurchasedUsd" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsOptOut" (
    "id" TEXT NOT NULL,
    "recipientPhone" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "optedOutAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "triggeredByBusinessId" TEXT,

    CONSTRAINT "SmsOptOut_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationCampaign" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "campaignKey" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "channels" JSONB NOT NULL DEFAULT '{"email":true,"sms":false,"whatsapp":false}',
    "customSubject" TEXT,
    "customBody" TEXT,
    "customCouponCode" TEXT,
    "delayHoursOverride" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationEnrollment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "customerId" TEXT,
    "recipientEmail" TEXT,
    "recipientPhone" TEXT,
    "recipientName" TEXT,
    "triggeredAt" TIMESTAMP(3) NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "variables" JSONB,
    "messageDeliveryId" TEXT,
    "openedAt" TIMESTAMP(3),
    "clickedAt" TIMESTAMP(3),
    "unsubscribedAt" TIMESTAMP(3),
    "triggerSourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerMarketingOptOut" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "recipientEmail" TEXT,
    "source" TEXT NOT NULL,
    "campaignKey" TEXT,
    "optedOutAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerMarketingOptOut_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeForm" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeForm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlogPost" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "excerpt" TEXT,
    "content" TEXT NOT NULL,
    "coverImageUrl" TEXT,
    "authorName" TEXT,
    "tagsCsv" TEXT,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "metaTitle" TEXT,
    "metaDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "categoryId" TEXT,

    CONSTRAINT "BlogPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlogCategory" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlogCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlogComment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "parentId" TEXT,
    "authorType" "BlogCommentAuthorType" NOT NULL,
    "customerId" TEXT,
    "authorName" TEXT NOT NULL,
    "authorEmail" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "BlogCommentStatus" NOT NULL DEFAULT 'PENDING',
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlogComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlogLike" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "customerId" TEXT,
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlogLike_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlogSettings" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "commentsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "likesEnabled" BOOLEAN NOT NULL DEFAULT true,
    "commentPolicy" "BlogParticipantPolicy" NOT NULL DEFAULT 'BOTH',
    "likePolicy" "BlogParticipantPolicy" NOT NULL DEFAULT 'BOTH',
    "moderationMode" "BlogModerationMode" NOT NULL DEFAULT 'PRE_MODERATE',
    "notifyAdminOnNewComment" BOOLEAN NOT NULL DEFAULT true,
    "guestRequiresEmail" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlogSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosIntegration" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "merchantId" TEXT,
    "syncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreBrand" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "logoUrl" TEXT,
    "customDomain" TEXT,
    "themeColors" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreBrand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessPaymentAccount" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "keyId" TEXT,
    "keySecretEnc" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "platformFeePct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessPaymentAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceConnection" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKeyEnc" TEXT,
    "webhookSecret" TEXT,
    "manifest" JSONB,
    "workspaceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentCountryPolicy" (
    "countryCode" TEXT NOT NULL,
    "integratedEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentCountryPolicy_pkey" PRIMARY KEY ("countryCode")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyLast4" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scopes" JSONB NOT NULL DEFAULT '{"read":[],"write":[]}',
    "lastUsedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookSubscription" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" JSONB NOT NULL DEFAULT '[]',
    "secret" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "nextRetryAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessRole" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessLocation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "phone" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantSettings" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "slotIntervalMinutes" INTEGER NOT NULL DEFAULT 15,
    "defaultTurnMinutes" INTEGER NOT NULL DEFAULT 90,
    "minAdvanceMinutes" INTEGER NOT NULL DEFAULT 60,
    "maxPartySizeOnline" INTEGER NOT NULL DEFAULT 12,
    "graceMinutes" INTEGER NOT NULL DEFAULT 15,
    "holdMinutes" INTEGER NOT NULL DEFAULT 10,
    "onlineBookingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "depositRequired" BOOLEAN NOT NULL DEFAULT false,
    "depositAmount" DOUBLE PRECISION,
    "depositMode" TEXT NOT NULL DEFAULT 'NONE',
    "minimumSpendEnabled" BOOLEAN NOT NULL DEFAULT false,
    "minimumSpendAmount" DOUBLE PRECISION,
    "minimumSpendPerPerson" BOOLEAN NOT NULL DEFAULT false,
    "prepaidEnabled" BOOLEAN NOT NULL DEFAULT false,
    "prepaidAmount" DOUBLE PRECISION,
    "cancellationFeeAmount" DOUBLE PRECISION,
    "noShowFeeAmount" DOUBLE PRECISION,
    "policyText" TEXT,
    "preorderEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantDiningArea" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "locationId" TEXT,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "onlineBookable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantDiningArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantTable" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "minCovers" INTEGER NOT NULL DEFAULT 1,
    "maxCovers" INTEGER NOT NULL,
    "shape" TEXT NOT NULL DEFAULT 'ROUND',
    "x" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "y" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "width" DOUBLE PRECISION NOT NULL DEFAULT 80,
    "height" DOUBLE PRECISION NOT NULL DEFAULT 80,
    "rotation" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "onlineBookable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantServicePeriod" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "locationId" TEXT,
    "areaId" TEXT,
    "dayOfWeek" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "slotIntervalMinutes" INTEGER NOT NULL DEFAULT 15,
    "turnMinutes" INTEGER NOT NULL DEFAULT 90,
    "flowCoverLimit" INTEGER,
    "onlineInventoryPercent" INTEGER NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantServicePeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantReservation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "locationId" TEXT,
    "partySize" INTEGER NOT NULL,
    "guestName" TEXT NOT NULL,
    "guestEmail" TEXT,
    "guestPhone" TEXT,
    "seatingPreference" TEXT,
    "occasion" TEXT,
    "dietaryNotes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'ONLINE',
    "arrivalStatus" TEXT NOT NULL DEFAULT 'RESERVED',
    "tableNote" TEXT,
    "reservationType" TEXT NOT NULL DEFAULT 'STANDARD',
    "experienceName" TEXT,
    "depositAmount" DOUBLE PRECISION,
    "minimumSpendAmount" DOUBLE PRECISION,
    "minimumSpendPerPerson" BOOLEAN NOT NULL DEFAULT false,
    "prepaidAmount" DOUBLE PRECISION,
    "policyAcceptedAt" TIMESTAMP(3),
    "preorderItems" JSONB,
    "paymentNote" TEXT,
    "quotedWaitMinutes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantReservationTable" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RestaurantReservationTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LawFirmIntake" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'IN_PERSON',
    "matterType" TEXT,
    "matterSummary" TEXT,
    "opposingParty" TEXT,
    "deadline" TEXT,
    "existingClient" TEXT,
    "idDocumentType" TEXT,
    "referralSource" TEXT,
    "source" TEXT NOT NULL DEFAULT 'ONLINE',
    "conflictStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "conflictNotes" TEXT,
    "conflictCheckedById" TEXT,
    "conflictCheckedAt" TIMESTAMP(3),
    "conflictConsentAt" TIMESTAMP(3),
    "amlConsentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LawFirmIntake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerTag" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerTagAssignment" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerTagAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerSegment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filter" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeSubmission" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "customerId" TEXT,
    "customerEmail" TEXT,
    "customerName" TEXT,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "fieldsSnapshot" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomPermission" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomRolePermissionGrant" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "locationId" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "EcomRolePermissionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryStock" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "reorderPoint" INTEGER NOT NULL DEFAULT 0,
    "reorderQty" INTEGER NOT NULL DEFAULT 0,
    "unitCostMinor" INTEGER,
    "supplierSku" TEXT,
    "localPickCode" TEXT,
    "aisleCode" TEXT,
    "rackCode" TEXT,
    "shelfCode" TEXT,
    "binLocation" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastCountedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryAdjustment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "InventoryAdjustmentReason" NOT NULL,
    "note" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "onHandAfter" INTEGER NOT NULL,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductLocationOverride" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "priceMinor" INTEGER,
    "comparePriceMinor" INTEGER,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductLocationOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomRider" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT,
    "fullName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "vehicleType" TEXT NOT NULL,
    "vehicleReg" TEXT,
    "licenseNo" TEXT,
    "licenseExpiresAt" TIMESTAMP(3),
    "insuranceExpiresAt" TIMESTAMP(3),
    "homeLocationId" TEXT,
    "serviceZones" JSONB NOT NULL DEFAULT '[]',
    "status" "RiderStatus" NOT NULL DEFAULT 'ACTIVE',
    "cashFloatMinor" INTEGER NOT NULL DEFAULT 0,
    "totalDeliveries" INTEGER NOT NULL DEFAULT 0,
    "onTimeRate" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "avgRating" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomRider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomRiderShift" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "locationId" TEXT,
    "status" "EcomRiderShiftStatus" NOT NULL DEFAULT 'OPEN',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "startLat" DOUBLE PRECISION,
    "startLng" DOUBLE PRECISION,
    "endLat" DOUBLE PRECISION,
    "endLng" DOUBLE PRECISION,
    "cashFloatMinor" INTEGER NOT NULL DEFAULT 0,
    "cashInHandMinor" INTEGER NOT NULL DEFAULT 0,
    "startBatteryPct" INTEGER,
    "endBatteryPct" INTEGER,
    "startNote" TEXT,
    "endNote" TEXT,
    "startedByUserId" TEXT,
    "endedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomRiderShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomDeliveryRequest" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "locationId" TEXT,
    "orderId" TEXT,
    "source" "DeliveryRequestSource" NOT NULL DEFAULT 'MANUAL',
    "sourceRef" TEXT,
    "channel" TEXT,
    "status" "DeliveryRequestStatus" NOT NULL DEFAULT 'PENDING',
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "riderId" TEXT,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT,
    "customerEmail" TEXT,
    "pickupName" TEXT,
    "pickupAddress1" TEXT,
    "pickupAddress2" TEXT,
    "pickupCity" TEXT,
    "pickupState" TEXT,
    "pickupPostalCode" TEXT,
    "pickupCountry" TEXT,
    "pickupLat" DOUBLE PRECISION,
    "pickupLng" DOUBLE PRECISION,
    "dropoffName" TEXT,
    "dropoffAddress1" TEXT,
    "dropoffAddress2" TEXT,
    "dropoffCity" TEXT,
    "dropoffState" TEXT,
    "dropoffPostalCode" TEXT,
    "dropoffCountry" TEXT,
    "dropoffLat" DOUBLE PRECISION,
    "dropoffLng" DOUBLE PRECISION,
    "items" JSONB NOT NULL DEFAULT '[]',
    "packageNote" TEXT,
    "deliverySlotLabel" TEXT,
    "requestedPickupAt" TIMESTAMP(3),
    "requestedDropoffAt" TIMESTAMP(3),
    "promisedAt" TIMESTAMP(3),
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "paymentMethod" TEXT,
    "cashToCollectMinor" INTEGER NOT NULL DEFAULT 0,
    "cashCollectedMinor" INTEGER NOT NULL DEFAULT 0,
    "cashReceivedMinor" INTEGER NOT NULL DEFAULT 0,
    "cashChangeDueMinor" INTEGER NOT NULL DEFAULT 0,
    "paymentReference" TEXT,
    "paymentNote" TEXT,
    "trackingToken" TEXT NOT NULL,
    "proofPhotoUrl" TEXT,
    "proofSignatureUrl" TEXT,
    "proofOtp" TEXT,
    "customerRating" INTEGER,
    "customerFeedback" TEXT,
    "failureReason" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "exceptionCode" TEXT,
    "exceptionStatus" TEXT,
    "exceptionNote" TEXT,
    "exceptionOpenedAt" TIMESTAMP(3),
    "exceptionEscalatedAt" TIMESTAMP(3),
    "exceptionResolvedAt" TIMESTAMP(3),
    "exceptionResolutionNote" TEXT,
    "notes" TEXT,
    "assignedAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomDeliveryRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomDeliveryRequestEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "deliveryRequestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "message" TEXT,
    "payload" JSONB,
    "actorUserId" TEXT,
    "actorSource" TEXT NOT NULL DEFAULT 'SYSTEM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EcomDeliveryRequestEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomDeliveryRoute" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "riderId" TEXT,
    "code" TEXT NOT NULL,
    "status" "DeliveryRouteStatus" NOT NULL DEFAULT 'PENDING',
    "scheduledAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "totalStops" INTEGER NOT NULL DEFAULT 0,
    "totalDistanceMeters" INTEGER,
    "plannedDurationMin" INTEGER,
    "cashToCollectMinor" INTEGER NOT NULL DEFAULT 0,
    "cashCollectedMinor" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomDeliveryRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomDeliveryRouteStop" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "orderId" TEXT,
    "deliveryRequestId" TEXT,
    "sequence" INTEGER NOT NULL,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "postalCode" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "status" "DeliveryStopStatus" NOT NULL DEFAULT 'PENDING',
    "arrivedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "proofPhotoUrl" TEXT,
    "proofSignatureUrl" TEXT,
    "customerRating" INTEGER,
    "customerFeedback" TEXT,
    "cashCollectedMinor" INTEGER NOT NULL DEFAULT 0,
    "cashReceivedMinor" INTEGER NOT NULL DEFAULT 0,
    "cashChangeDueMinor" INTEGER NOT NULL DEFAULT 0,
    "paymentReference" TEXT,
    "paymentNote" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomDeliveryRouteStop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomDeliveryLocationPing" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "deliveryRequestId" TEXT,
    "riderId" TEXT,
    "routeId" TEXT,
    "routeStopId" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracyMeters" DOUBLE PRECISION,
    "headingDegrees" DOUBLE PRECISION,
    "speedMetersPerSecond" DOUBLE PRECISION,
    "batteryPct" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'RIDER_APP',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EcomDeliveryLocationPing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomDeliveryCashSettlement" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "riderId" TEXT,
    "locationId" TEXT,
    "status" "EcomDeliveryCashSettlementStatus" NOT NULL DEFAULT 'SETTLED',
    "settlementDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fromAt" TIMESTAMP(3) NOT NULL,
    "toAt" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "expectedCashMinor" INTEGER NOT NULL DEFAULT 0,
    "countedCashMinor" INTEGER NOT NULL DEFAULT 0,
    "varianceMinor" INTEGER NOT NULL DEFAULT 0,
    "deliveryCount" INTEGER NOT NULL DEFAULT 0,
    "deliveryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reference" TEXT,
    "notes" TEXT,
    "settledByUserId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedByUserId" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomDeliveryCashSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomDeliverySlot" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "dayOfWeek" INTEGER,
    "specificDate" TIMESTAMP(3),
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 20,
    "surchargeMinor" INTEGER NOT NULL DEFAULT 0,
    "slotType" "DeliverySlotType" NOT NULL DEFAULT 'STANDARD',
    "freeDeliveryThresholdMinor" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomDeliverySlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomDeliverySlotBooking" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "deliveryDate" TIMESTAMP(3) NOT NULL,
    "orderId" TEXT,
    "surchargeAppliedMinor" INTEGER NOT NULL DEFAULT 0,
    "status" "SlotBookingStatus" NOT NULL DEFAULT 'HELD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomDeliverySlotBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomReturn" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "orderId" TEXT,
    "orderCode" TEXT,
    "customerId" TEXT,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "status" "EcomReturnStatus" NOT NULL DEFAULT 'REQUESTED',
    "reasonCategory" "EcomReturnReason" NOT NULL,
    "reasonNote" TEXT,
    "refundMethod" TEXT,
    "totalRefundMinor" INTEGER NOT NULL DEFAULT 0,
    "refundedAt" TIMESTAMP(3),
    "refundProviderRef" TEXT,
    "pickupAddress" JSONB,
    "pickupSlotId" TEXT,
    "collectedAt" TIMESTAMP(3),
    "closedByUserId" TEXT,
    "closedAt" TIMESTAMP(3),
    "evidenceUrls" JSONB NOT NULL DEFAULT '[]',
    "internalNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomReturnItem" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "productId" TEXT,
    "productName" TEXT NOT NULL,
    "productSlug" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "refundAmountMinor" INTEGER NOT NULL,
    "disposition" "EcomReturnDisposition" NOT NULL DEFAULT 'PENDING',
    "reason" "EcomReturnReason",
    "note" TEXT,
    "adjustmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomReturnItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomReturnEvent" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromStatus" "EcomReturnStatus",
    "toStatus" "EcomReturnStatus",
    "message" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EcomReturnEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerWallet" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "balanceMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerShoppingList" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'My list',
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerShoppingList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShoppingListItem" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShoppingListItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderIssueReport" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "customerId" TEXT,
    "customerEmail" TEXT,
    "reasonCode" TEXT NOT NULL,
    "description" TEXT,
    "photoUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedMinor" INTEGER NOT NULL DEFAULT 0,
    "creditedMinor" INTEGER NOT NULL DEFAULT 0,
    "walletEntryId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderIssueReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recipe" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "servings" INTEGER,
    "prepMinutes" INTEGER,
    "cookMinutes" INTEGER,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeIngredient" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RecipeIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerSubscription" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "intervalKind" TEXT NOT NULL DEFAULT 'WEEKLY',
    "intervalCount" INTEGER NOT NULL DEFAULT 1,
    "discountPct" INTEGER NOT NULL DEFAULT 5,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "nextDeliveryAt" TIMESTAMP(3),
    "lastDeliveryAt" TIMESTAMP(3),
    "pausedUntil" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletLedgerEntry" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "deltaMinor" INTEGER NOT NULL,
    "balanceAfterMinor" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomReview" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT,
    "riderId" TEXT,
    "orderId" TEXT,
    "customerId" TEXT,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "mediaUrls" JSONB NOT NULL DEFAULT '[]',
    "status" "EcomReviewStatus" NOT NULL DEFAULT 'PENDING',
    "flagReason" TEXT,
    "merchantReply" TEXT,
    "merchantReplyByUserId" TEXT,
    "merchantReplyAt" TIMESTAMP(3),
    "helpfulCount" INTEGER NOT NULL DEFAULT 0,
    "unhelpfulCount" INTEGER NOT NULL DEFAULT 0,
    "verifiedBuyer" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomBanner" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "placement" "EcomBannerPlacement" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "locationId" TEXT,
    "audience" TEXT NOT NULL DEFAULT 'ALL',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "scheduleJson" JSONB,
    "desktopImageUrl" TEXT,
    "mobileImageUrl" TEXT,
    "altText" TEXT,
    "headline" TEXT,
    "subheadline" TEXT,
    "ctaLabel" TEXT,
    "linkType" TEXT NOT NULL DEFAULT 'NONE',
    "linkProductId" TEXT,
    "linkCategoryId" TEXT,
    "linkPageId" TEXT,
    "linkUrl" TEXT,
    "groupKey" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomBanner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomCmsBlock" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "slotKey" TEXT NOT NULL,
    "blockType" "EcomCmsBlockType" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "locationId" TEXT,
    "audience" TEXT NOT NULL DEFAULT 'ALL',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "i18nOverrides" JSONB,
    "status" "EcomCmsBlockStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "publishedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomCmsBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomOrderEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "message" TEXT,
    "payload" JSONB,
    "actorUserId" TEXT,
    "actorSource" TEXT NOT NULL DEFAULT 'ADMIN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EcomOrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomServiceCity" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "region" TEXT,
    "timezone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'LIVE',
    "taxJurisdiction" TEXT,
    "currency" TEXT,
    "defaultLocale" TEXT,
    "brandOverrides" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomServiceCity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomDeliveryZone" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "cityId" TEXT NOT NULL,
    "primaryLocationId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "postcodes" JSONB NOT NULL DEFAULT '[]',
    "polygon" JSONB,
    "deliveryFeeMinor" INTEGER NOT NULL DEFAULT 0,
    "freeDeliveryThresholdMinor" INTEGER NOT NULL DEFAULT 0,
    "expressSurchargeMinor" INTEGER NOT NULL DEFAULT 0,
    "maxInFlightOrders" INTEGER NOT NULL DEFAULT 0,
    "promiseMinutes" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomDeliveryZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomPickupLocation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "locationId" TEXT,
    "name" TEXT NOT NULL,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "region" TEXT,
    "postalCode" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "hours" JSONB NOT NULL DEFAULT '{}',
    "prepTimeMinutes" INTEGER NOT NULL DEFAULT 30,
    "pickupInstructions" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomPickupLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductBrandFamily" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoUrl" TEXT,
    "description" TEXT,
    "countryCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isSample" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ProductBrandFamily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductBrand" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "brandFamilyId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoUrl" TEXT,
    "description" TEXT,
    "countryCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isSample" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ProductBrand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomSupplier" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postalCode" TEXT,
    "countryCode" TEXT,
    "taxIdType" TEXT,
    "taxId" TEXT,
    "bankAccountName" TEXT,
    "bankAccountNumber" TEXT,
    "bankSortCode" TEXT,
    "bankIfsc" TEXT,
    "paymentTerms" TEXT,
    "currency" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomSupplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomGoodsReceiptNote" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "supplierId" TEXT,
    "locationId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "supplierInvoiceNo" TEXT,
    "purchaseOrderRef" TEXT,
    "invoiceTotalMinor" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "postedAt" TIMESTAMP(3),
    "postedByUserId" TEXT,
    "attachmentUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomGoodsReceiptNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomGoodsReceiptItem" (
    "id" TEXT NOT NULL,
    "grnId" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT NOT NULL,
    "productSku" TEXT,
    "quantityOrdered" INTEGER NOT NULL DEFAULT 0,
    "quantityReceived" INTEGER NOT NULL,
    "unitCostMinor" INTEGER NOT NULL DEFAULT 0,
    "taxMinor" INTEGER NOT NULL DEFAULT 0,
    "lineTotalMinor" INTEGER NOT NULL DEFAULT 0,
    "batchNumber" TEXT,
    "expiresAt" TIMESTAMP(3),
    "adjustmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomGoodsReceiptItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomInventoryTransfer" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "riderId" TEXT,
    "shippedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "initiatedByUserId" TEXT,
    "receivedByUserId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomInventoryTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomInventoryTransferItem" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT NOT NULL,
    "productSku" TEXT,
    "quantityShipped" INTEGER NOT NULL,
    "quantityReceived" INTEGER NOT NULL DEFAULT 0,
    "shipAdjustmentId" TEXT,
    "receiveAdjustmentId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EcomInventoryTransferItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomActivityEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "actorUserId" TEXT,
    "actorName" TEXT,
    "actorRole" TEXT,
    "actorSource" TEXT NOT NULL DEFAULT 'ADMIN',
    "targetType" TEXT,
    "targetId" TEXT,
    "targetCode" TEXT,
    "locationId" TEXT,
    "message" TEXT,
    "payload" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'SUCCESS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EcomActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EcomLoyaltyLedger" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "orderId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EcomLoyaltyLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountAuditLog" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventType" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetSlug" TEXT,
    "originalEmail" TEXT,
    "originalEmailHash" TEXT,
    "originalName" TEXT,
    "originalPhone" TEXT,
    "ownerCountry" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "reason" TEXT,
    "payload" JSONB,

    CONSTRAINT "AccountAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Redirect" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "fromPath" TEXT NOT NULL,
    "toPath" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL DEFAULT 301,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Redirect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorePolicy" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "showInFooter" BOOLEAN NOT NULL DEFAULT true,
    "showAtSignup" BOOLEAN NOT NULL DEFAULT false,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Matter" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "matterNumber" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "practiceArea" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "feeBasis" TEXT NOT NULL DEFAULT 'HOURLY',
    "defaultRate" DOUBLE PRECISION,
    "fixedFee" DOUBLE PRECISION,
    "currency" TEXT,
    "engagementStatus" TEXT NOT NULL DEFAULT 'NONE',
    "engagementDocId" TEXT,
    "engagementSentAt" TIMESTAMP(3),
    "engagementAcceptedAt" TIMESTAMP(3),
    "customerId" TEXT,
    "responsibleLawyerId" TEXT,
    "originAppointmentId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Matter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatterInvoice" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "matterId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "currency" TEXT,
    "lineItemsJson" TEXT NOT NULL,
    "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxLabel" TEXT,
    "amountPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "dueDate" TIMESTAMP(3),
    "clientName" TEXT,
    "clientContact" TEXT,
    "snapshotJson" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatterInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatterTimeEntry" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "matterId" TEXT NOT NULL,
    "userId" TEXT,
    "workedOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "minutes" INTEGER NOT NULL DEFAULT 0,
    "rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "narrative" TEXT,
    "billed" BOOLEAN NOT NULL DEFAULT false,
    "invoiceId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatterTimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatterDisbursement" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "matterId" TEXT NOT NULL,
    "incurredOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "description" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "billed" BOOLEAN NOT NULL DEFAULT false,
    "invoiceId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatterDisbursement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustTransaction" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "matterId" TEXT,
    "customerId" TEXT,
    "type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "balanceAfter" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "relatedInvoiceId" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrustTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstalledUnit" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "brand" TEXT,
    "model" TEXT,
    "serial" TEXT,
    "purifierType" TEXT,
    "waterSource" TEXT,
    "installedAt" TIMESTAMP(3),
    "warrantyUntil" TIMESTAMP(3),
    "addressLine" TEXT,
    "pincode" TEXT,
    "lastTds" INTEGER,
    "notes" TEXT,
    "originAppointmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstalledUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmcContract" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "contractNumber" TEXT NOT NULL,
    "customerId" TEXT,
    "installedUnitId" TEXT,
    "tier" TEXT NOT NULL DEFAULT 'BASIC',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "price" DOUBLE PRECISION,
    "currency" TEXT,
    "visitsIncluded" INTEGER NOT NULL DEFAULT 0,
    "visitsUsed" INTEGER NOT NULL DEFAULT 0,
    "nextVisitDueAt" TIMESTAMP(3),
    "responsibleTechnicianId" TEXT,
    "originAppointmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmcContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceVisit" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "amcContractId" TEXT,
    "installedUnitId" TEXT,
    "appointmentId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'PREVENTIVE',
    "scheduledFor" TIMESTAMP(3),
    "dueBy" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "technicianId" TEXT,
    "tdsBefore" INTEGER,
    "tdsAfter" INTEGER,
    "partsReplacedJson" TEXT,
    "reportDocId" TEXT,
    "notes" TEXT,
    "billed" BOOLEAN NOT NULL DEFAULT false,
    "invoiceId" TEXT,
    "completedAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmcInvoice" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "amcContractId" TEXT,
    "customerId" TEXT,
    "invoiceNumber" TEXT NOT NULL,
    "currency" TEXT,
    "lineItemsJson" TEXT NOT NULL,
    "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxLabel" TEXT,
    "amountPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "dueDate" TIMESTAMP(3),
    "clientName" TEXT,
    "clientContact" TEXT,
    "snapshotJson" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmcInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QaUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "passwordChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QaUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QaProject" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "nextIssueNumber" INTEGER NOT NULL DEFAULT 1001,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QaProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QaProjectVertical" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QaProjectVertical_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QaProjectMember" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "canTest" BOOLEAN NOT NULL DEFAULT true,
    "canApproveRecommendations" BOOLEAN NOT NULL DEFAULT false,
    "canDevelop" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QaProjectMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QaAgentKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "createdById" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QaAgentKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QaIssue" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "projectIssueNumber" INTEGER NOT NULL,
    "verticalId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'BUG',
    "severity" TEXT NOT NULL DEFAULT 'LOW',
    "description" TEXT NOT NULL,
    "imageUrl" TEXT,
    "imageDataUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DEVELOPMENT',
    "createdById" TEXT,
    "agentClaimedAt" TIMESTAMP(3),
    "agentClaimedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QaIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QaIssueComment" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'USER',
    "body" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QaIssueComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Entity" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradeName" TEXT,
    "countryCode" CHAR(2) NOT NULL,
    "payCurrency" CHAR(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "taxYearStartMonth" INTEGER NOT NULL DEFAULT 4,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "stateCode" TEXT,
    "postalCode" TEXT,
    "pan" CHAR(10),
    "tan" CHAR(10),
    "gstin" VARCHAR(15),
    "cin" TEXT,
    "nzbn" TEXT,
    "irdEntityNumber" VARCHAR(11),
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "activeFrom" TIMESTAMP(3) NOT NULL,
    "activeTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "addressLine1" TEXT,
    "city" TEXT,
    "stateCode" TEXT,
    "postalCode" TEXT,
    "countryCode" CHAR(2) NOT NULL,
    "timezone" TEXT NOT NULL,
    "geoLat" DECIMAL(9,6),
    "geoLng" DECIMAL(9,6),
    "geofenceM" INTEGER,
    "ptRegistrationId" TEXT,
    "accClassUnit" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "headEmployeeId" TEXT,
    "costCenter" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Designation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "gradeId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Designation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Grade" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "bandId" TEXT,
    "minSalary" DECIMAL(15,2),
    "maxSalary" DECIMAL(15,2),
    "currencyCode" CHAR(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Grade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Band" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Band_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "userId" TEXT,
    "firstName" TEXT NOT NULL,
    "middleName" TEXT,
    "lastName" TEXT NOT NULL,
    "preferredName" TEXT,
    "dateOfBirth" DATE,
    "gender" "Gender",
    "maritalStatus" "MaritalStatus",
    "nationality" TEXT,
    "personalEmail" TEXT,
    "workEmail" TEXT,
    "phone" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "stateCode" TEXT,
    "postalCode" TEXT,
    "countryCode" CHAR(2),
    "photoUrl" TEXT,
    "disabilityStatus" TEXT,
    "bloodGroup" TEXT,
    "preferredLanguage" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'PRE_HIRE',
    "hireDate" DATE,
    "probationEndDate" DATE,
    "terminationDate" DATE,
    "currentEmploymentRecordId" TEXT,
    "currentCompensationId" TEXT,
    "managerEmployeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "anonymisedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmploymentRecord" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "locationId" TEXT,
    "departmentId" TEXT,
    "designationId" TEXT,
    "gradeId" TEXT,
    "managerEmployeeId" TEXT,
    "employmentType" "EmploymentType" NOT NULL,
    "workerCategory" "WorkerCategory" NOT NULL,
    "payCalendarId" TEXT,
    "noticeDays" INTEGER,
    "fteRatio" DECIMAL(5,4) NOT NULL DEFAULT 1.0000,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "changeReason" "EmploymentChangeReason" NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "EmploymentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "ifsc" CHAR(11),
    "nzBankAccount" TEXT,
    "bankName" TEXT,
    "currencyCode" CHAR(3) NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "splitPercent" DECIMAL(5,2),
    "verifiedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyContact" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmergencyContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dependant" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relationship" "DependantRelation" NOT NULL,
    "dateOfBirth" DATE,
    "isNominee" BOOLEAN NOT NULL DEFAULT false,
    "nomineePercent" DECIMAL(5,2),
    "isInsured" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dependant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryComponent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ComponentKind" NOT NULL,
    "category" "ComponentCategory" NOT NULL,
    "calcMethod" "ComponentCalcMethod" NOT NULL,
    "calcValue" DECIMAL(15,4),
    "calcBaseCode" TEXT,
    "calcBaseScope" "ComponentBaseScope" NOT NULL DEFAULT 'SINGLE',
    "isWageForPF" BOOLEAN NOT NULL DEFAULT false,
    "isWageForESI" BOOLEAN NOT NULL DEFAULT false,
    "isWageForPT" BOOLEAN NOT NULL DEFAULT false,
    "isWageForGratuity" BOOLEAN NOT NULL DEFAULT false,
    "isTaxable" BOOLEAN NOT NULL DEFAULT true,
    "taxSection" TEXT,
    "isKiwiSaverable" BOOLEAN NOT NULL DEFAULT false,
    "isPayeable" BOOLEAN NOT NULL DEFAULT true,
    "isRecurring" BOOLEAN NOT NULL DEFAULT true,
    "prorationMethod" "ProrationMethod" NOT NULL DEFAULT 'CALENDAR_DAYS',
    "glCode" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SalaryComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryStructure" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "currencyCode" CHAR(3) NOT NULL,
    "basis" "StructureBasis" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SalaryStructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryComponentLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "structureId" TEXT,
    "compensationId" TEXT,
    "componentId" TEXT NOT NULL,
    "calcMethod" "ComponentCalcMethod" NOT NULL,
    "calcValue" DECIMAL(15,4),
    "amountMonthly" DECIMAL(15,2),
    "amountAnnual" DECIMAL(15,2),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SalaryComponentLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompensationRevision" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "structureId" TEXT,
    "currencyCode" CHAR(3) NOT NULL,
    "basis" "StructureBasis" NOT NULL,
    "ctcAnnual" DECIMAL(15,2),
    "grossMonthly" DECIMAL(15,2),
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "revisionReason" "CompRevisionReason" NOT NULL,
    "approvalRequestId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CompensationRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatutoryProfile" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "pan" CHAR(10),
    "uan" VARCHAR(12),
    "pfMemberId" TEXT,
    "pfOptIn" BOOLEAN,
    "pfJoinDate" DATE,
    "esicIp" TEXT,
    "esiApplicable" BOOLEAN DEFAULT false,
    "ptStateCode" TEXT,
    "aadhaarVerified" BOOLEAN DEFAULT false,
    "taxRegime" "INTaxRegime" DEFAULT 'NEW',
    "section80CDeclared" DECIMAL(15,2),
    "hraExemptionClaimed" BOOLEAN DEFAULT false,
    "abryEligible" BOOLEAN DEFAULT false,
    "irdNumber" VARCHAR(11),
    "taxCode" VARCHAR(8),
    "kiwiSaverStatus" "KiwiSaverStatus" DEFAULT 'NOT_ENROLLED',
    "kiwiSaverEmployeeRate" DECIMAL(5,4),
    "kiwiSaverOptOutDate" DATE,
    "kiwiSaverSavingsSuspension" BOOLEAN DEFAULT false,
    "esctRate" DECIMAL(5,4),
    "studentLoan" BOOLEAN DEFAULT false,
    "studentLoanExtraDeduction" DECIMAL(5,2),
    "hasSpecialTaxCode" BOOLEAN DEFAULT false,
    "specialTaxRate" DECIMAL(5,4),
    "accExempt" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StatutoryProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatutoryElectionHistory" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "statutoryProfileId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "changedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatutoryElectionHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatutoryRegistration" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" "RegistrationKind" NOT NULL,
    "number" TEXT NOT NULL,
    "stateCode" TEXT,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StatutoryRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayCalendar" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "frequency" "PayFrequency" NOT NULL,
    "payDayRule" "PayDayRule" NOT NULL,
    "payDayValue" INTEGER,
    "cutoffDayRule" "PayDayRule" NOT NULL,
    "cutoffDayValue" INTEGER,
    "prorationMethod" "ProrationMethod" NOT NULL DEFAULT 'CALENDAR_DAYS',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PayCalendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayRun" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payCalendarId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "payDate" DATE NOT NULL,
    "sequenceInYear" INTEGER NOT NULL,
    "taxYear" TEXT NOT NULL,
    "type" "PayRunType" NOT NULL DEFAULT 'REGULAR',
    "status" "PayRunStatus" NOT NULL DEFAULT 'DRAFT',
    "currencyCode" CHAR(3) NOT NULL,
    "complianceVersionId" TEXT,
    "headcount" INTEGER NOT NULL DEFAULT 0,
    "totalGross" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalDeductions" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalNet" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalEmployerCost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3),
    "computedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "paidAt" TIMESTAMP(3),
    "approvalRequestId" TEXT,
    "parentPayRunId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PayRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendancePayInput" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "payRunId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "calendarDays" DECIMAL(8,4) NOT NULL DEFAULT 0,
    "payableDays" DECIMAL(8,4) NOT NULL DEFAULT 0,
    "lopDays" DECIMAL(8,4) NOT NULL DEFAULT 0,
    "paidLeaveDays" DECIMAL(8,4) NOT NULL DEFAULT 0,
    "weeklyOffDays" DECIMAL(8,4) NOT NULL DEFAULT 0,
    "holidayDays" DECIMAL(8,4) NOT NULL DEFAULT 0,
    "overtimeHours" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "frozenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendancePayInput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayRunLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "payRunId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "compensationId" TEXT NOT NULL,
    "payableDays" DECIMAL(8,4) NOT NULL,
    "lopDays" DECIMAL(8,4) NOT NULL DEFAULT 0,
    "overtimeHours" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "grossEarnings" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "totalDeductions" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "netPay" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "employerCost" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "currencyCode" CHAR(3) NOT NULL,
    "pfEmployee" DECIMAL(15,2),
    "pfEmployer" DECIMAL(15,2),
    "esiEmployee" DECIMAL(15,2),
    "esiEmployer" DECIMAL(15,2),
    "pt" DECIMAL(15,2),
    "tds" DECIMAL(15,2),
    "paye" DECIMAL(15,2),
    "kiwiSaverEmployee" DECIMAL(15,2),
    "kiwiSaverEmployer" DECIMAL(15,2),
    "esct" DECIMAL(15,2),
    "accLevy" DECIMAL(15,2),
    "studentLoan" DECIMAL(15,2),
    "status" "PayRunLineStatus" NOT NULL DEFAULT 'PENDING',
    "errorJson" JSONB,
    "computeTrace" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PayRunLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayRunLineComponent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "payRunLineId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "componentId" TEXT NOT NULL,
    "componentCode" TEXT NOT NULL,
    "componentName" TEXT NOT NULL,
    "category" "ComponentCategory" NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "baseAmount" DECIMAL(15,2),
    "rateApplied" DECIMAL(9,6),
    "isStatutory" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PayRunLineComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payslip" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "payRunId" TEXT NOT NULL,
    "payRunLineId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "payDate" DATE NOT NULL,
    "currencyCode" CHAR(3) NOT NULL,
    "grossEarnings" DECIMAL(15,2) NOT NULL,
    "totalDeductions" DECIMAL(15,2) NOT NULL,
    "netPay" DECIMAL(15,2) NOT NULL,
    "snapshotJson" JSONB NOT NULL,
    "pdfUrl" TEXT,
    "pdfHash" TEXT,
    "yptdJson" JSONB,
    "publishedAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "emailedAt" TIMESTAMP(3),
    "status" "PayslipStatus" NOT NULL DEFAULT 'GENERATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Payslip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatutoryRemittance" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payRunId" TEXT,
    "kind" "RemittanceKind" NOT NULL,
    "taxPeriod" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currencyCode" CHAR(3) NOT NULL,
    "dueDate" DATE NOT NULL,
    "filedDate" TIMESTAMP(3),
    "paidDate" TIMESTAMP(3),
    "challanRef" TEXT,
    "status" "RemittanceStatus" NOT NULL DEFAULT 'PENDING',
    "fileUrl" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StatutoryRemittance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveType" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "countryCode" CHAR(2),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "LeaveCategory" NOT NULL,
    "unit" "LeaveUnit" NOT NULL DEFAULT 'DAYS',
    "isPaid" BOOLEAN NOT NULL DEFAULT true,
    "isStatutory" BOOLEAN NOT NULL DEFAULT false,
    "nzPayBasis" "NZLeavePayBasis",
    "requiresReason" BOOLEAN NOT NULL DEFAULT false,
    "affectsLOP" BOOLEAN NOT NULL DEFAULT false,
    "isEncashable" BOOLEAN NOT NULL DEFAULT false,
    "color" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LeaveType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeavePolicy" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "entityId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accrualMethod" "AccrualMethod" NOT NULL,
    "entitlementPerYear" DECIMAL(8,4),
    "accrualFrequency" "AccrualFrequency" NOT NULL DEFAULT 'MONTHLY',
    "accrualProrateOnJoin" BOOLEAN NOT NULL DEFAULT true,
    "carryForwardCap" DECIMAL(8,4),
    "carryForwardExpiryMonths" INTEGER,
    "maxBalanceCap" DECIMAL(8,4),
    "maxConsecutive" INTEGER,
    "minNoticeDays" INTEGER,
    "allowNegative" BOOLEAN NOT NULL DEFAULT false,
    "negativeCap" DECIMAL(8,4),
    "minTenureMonths" INTEGER NOT NULL DEFAULT 0,
    "appliesToEmploymentTypes" TEXT,
    "genderRestriction" "Gender",
    "encashOnExit" BOOLEAN NOT NULL DEFAULT false,
    "encashFormula" TEXT,
    "workflowDefinitionId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LeavePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccrualRule" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "leavePolicyId" TEXT NOT NULL,
    "minTenureMonths" INTEGER NOT NULL,
    "maxTenureMonths" INTEGER,
    "ratePerPeriod" DECIMAL(8,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccrualRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeavePolicyAssignment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "leavePolicyId" TEXT NOT NULL,
    "scope" "AssignmentScope" NOT NULL,
    "scopeRefId" TEXT,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeavePolicyAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveBalance" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "periodCode" TEXT NOT NULL,
    "unit" "LeaveUnit" NOT NULL,
    "opening" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "accrued" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "taken" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "pendingApproval" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "encashed" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "lapsed" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "adjusted" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "closing" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "nzAccruedGrossEarnings" DECIMAL(15,2),
    "lastAccrualAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LeaveBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveTransaction" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "leaveBalanceId" TEXT,
    "txnType" "LeaveTxnType" NOT NULL,
    "unit" "LeaveUnit" NOT NULL,
    "quantity" DECIMAL(10,4) NOT NULL,
    "startDate" DATE,
    "endDate" DATE,
    "startHalf" "DayHalf",
    "endHalf" "DayHalf",
    "reason" TEXT,
    "nzPayBasisUsed" "NZLeavePayBasis",
    "paidAmount" DECIMAL(15,2),
    "status" "LeaveTxnStatus" NOT NULL DEFAULT 'DRAFT',
    "approvalRequestId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "payRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LeaveTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftPattern" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "breakMinutes" INTEGER NOT NULL DEFAULT 60,
    "graceInMinutes" INTEGER NOT NULL DEFAULT 10,
    "halfDayThresholdMinutes" INTEGER,
    "fullDayMinutes" INTEGER NOT NULL DEFAULT 480,
    "isNightShift" BOOLEAN NOT NULL DEFAULT false,
    "crossesMidnight" BOOLEAN NOT NULL DEFAULT false,
    "weeklyOffDays" TEXT NOT NULL DEFAULT '0',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ShiftPattern_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftAssignment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "shiftPatternId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Holiday" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT,
    "locationId" TEXT,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "type" "HolidayType" NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "isPaid" BOOLEAN NOT NULL DEFAULT true,
    "isRestricted" BOOLEAN NOT NULL DEFAULT false,
    "scopeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendancePunch" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "locationId" TEXT,
    "punchType" "PunchType" NOT NULL,
    "punchAt" TIMESTAMP(3) NOT NULL,
    "source" "PunchSource" NOT NULL,
    "geoLat" DECIMAL(9,6),
    "geoLng" DECIMAL(9,6),
    "ipAddress" TEXT,
    "deviceId" TEXT,
    "selfieUrl" TEXT,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "regularizationRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendancePunch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "shiftPatternId" TEXT,
    "firstIn" TIMESTAMP(3),
    "lastOut" TIMESTAMP(3),
    "workedMinutes" INTEGER NOT NULL DEFAULT 0,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "status" "AttendanceStatus" NOT NULL,
    "lopFraction" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "exceptionsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Timesheet" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "totalHours" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "billableHours" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "overtimeHours" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "status" "TimesheetStatus" NOT NULL DEFAULT 'DRAFT',
    "approvalRequestId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Timesheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimesheetEntry" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "timesheetId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "projectCode" TEXT,
    "taskCode" TEXT,
    "hours" DECIMAL(6,2) NOT NULL,
    "isBillable" BOOLEAN NOT NULL DEFAULT false,
    "isOvertime" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimesheetEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "glCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpensePolicy" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "maxPerClaim" DECIMAL(15,2),
    "maxPerMonth" DECIMAL(15,2),
    "requireReceipt" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ExpensePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseClaim" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "categoryId" TEXT,
    "claimNumber" TEXT,
    "amount" DECIMAL(15,2) NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'INR',
    "description" TEXT,
    "receiptUrl" TEXT,
    "expenseDate" DATE,
    "status" "ExpenseClaimStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "rejectReason" TEXT,
    "reimbursedAt" TIMESTAMP(3),
    "reimbursedBy" TEXT,
    "paymentRef" TEXT,
    "payRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ExpenseClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseClaimLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(15,2) NOT NULL,
    "receiptUrl" TEXT,
    "expenseDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseClaimLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanScheme" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "loanType" "LoanType" NOT NULL DEFAULT 'LOAN',
    "interestRate" DECIMAL(5,2),
    "maxPrincipal" DECIMAL(15,2),
    "maxTenureMonths" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LoanScheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "schemeId" TEXT,
    "loanNumber" TEXT,
    "loanType" "LoanType" NOT NULL DEFAULT 'LOAN',
    "principal" DECIMAL(15,2) NOT NULL,
    "interestRate" DECIMAL(5,2),
    "currencyCode" TEXT NOT NULL DEFAULT 'INR',
    "tenureMonths" INTEGER NOT NULL,
    "emiAmount" DECIMAL(15,2),
    "startDate" DATE NOT NULL,
    "reason" TEXT,
    "status" "LoanStatus" NOT NULL DEFAULT 'DRAFT',
    "totalPayable" DECIMAL(15,2),
    "amountRepaid" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "outstanding" DECIMAL(15,2),
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "disbursedAt" TIMESTAMP(3),
    "disbursedBy" TEXT,
    "disbursementRef" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanInstallment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "principalComponent" DECIMAL(15,2) NOT NULL,
    "interestComponent" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(15,2) NOT NULL,
    "status" "InstallmentStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "payRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoanInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeparationCase" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "SeparationType" NOT NULL,
    "reason" TEXT,
    "initiatedAt" DATE NOT NULL,
    "resignationDate" DATE,
    "noticePeriodDays" INTEGER,
    "noticeShortfallDays" INTEGER NOT NULL DEFAULT 0,
    "lastWorkingDay" DATE,
    "relievingDate" DATE,
    "gratuityAmount" DECIMAL(15,2),
    "leaveEncashmentDays" DECIMAL(8,4),
    "leaveEncashmentAmount" DECIMAL(15,2),
    "nzHolidayPayoutAmount" DECIMAL(15,2),
    "noticeRecoveryAmount" DECIMAL(15,2),
    "loanForeclosureAmount" DECIMAL(15,2),
    "assetRecoveryAmount" DECIMAL(15,2),
    "netSettlement" DECIMAL(15,2),
    "currencyCode" CHAR(3) NOT NULL,
    "fnfPayRunId" TEXT,
    "clearanceJson" JSONB,
    "status" "SeparationStatus" NOT NULL DEFAULT 'INITIATED',
    "approvalRequestId" TEXT,
    "exitInterviewJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SeparationCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeDocument" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "category" "DocumentCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileHash" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "documentNumber" TEXT,
    "expiresAt" DATE,
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "visibility" "DocumentVisibility" NOT NULL DEFAULT 'HR_ONLY',
    "isEmployeeUploaded" BOOLEAN NOT NULL DEFAULT false,
    "signatureStatus" "SignatureStatus",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "EmployeeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentTemplate" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "TemplateKind" NOT NULL,
    "layoutKey" TEXT NOT NULL,
    "countryCode" CHAR(2),
    "bodyMarkdown" TEXT NOT NULL,
    "mergeFieldsJson" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DocumentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileChangeRequest" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "approvalRequestId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProfileChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentRequest" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "templateKind" "TemplateKind" NOT NULL,
    "purpose" TEXT,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "generatedDocumentId" TEXT,
    "approvalRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceRegularizationRequest" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "requestedInAt" TIMESTAMP(3),
    "requestedOutAt" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "approvalRequestId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceRegularizationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "AssetCategory" NOT NULL,
    "serialNumber" TEXT,
    "purchaseDate" DATE,
    "purchaseCost" DECIMAL(15,2),
    "currencyCode" CHAR(3),
    "condition" "AssetCondition" NOT NULL DEFAULT 'GOOD',
    "status" "AssetStatus" NOT NULL DEFAULT 'AVAILABLE',
    "warrantyExpiry" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetAssignment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "assignedAt" DATE NOT NULL,
    "returnedAt" DATE,
    "conditionOut" "AssetCondition",
    "conditionIn" "AssetCondition",
    "acknowledgmentSignedAt" TIMESTAMP(3),
    "recoveryAmount" DECIMAL(15,2),
    "notes" TEXT,
    "status" "AssetAssignmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewCycle" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ReviewCycleType" NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" "ReviewCycleStatus" NOT NULL DEFAULT 'DRAFT',
    "ratingScaleJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceReview" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "reviewCycleId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "selfRating" DECIMAL(4,2),
    "managerRating" DECIMAL(4,2),
    "finalRating" DECIMAL(4,2),
    "selfComments" TEXT,
    "managerComments" TEXT,
    "status" "ReviewStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "outcomeJson" JSONB,
    "linkedCompensationId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PerformanceReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "reviewCycleId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "GoalCategory" NOT NULL DEFAULT 'INDIVIDUAL',
    "weight" DECIMAL(5,2),
    "target" TEXT,
    "progress" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "status" "GoalStatus" NOT NULL DEFAULT 'DRAFT',
    "dueDate" DATE,
    "parentGoalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeSkill" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "proficiency" INTEGER NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "endorsedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "departmentId" TEXT,
    "designationId" TEXT,
    "locationId" TEXT,
    "countryCode" CHAR(2) NOT NULL,
    "employmentType" "EmploymentType" NOT NULL,
    "openings" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "minSalary" DECIMAL(15,2),
    "maxSalary" DECIMAL(15,2),
    "currencyCode" CHAR(3),
    "hiringManagerId" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobStage" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "StageKind" NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "resumeUrl" TEXT,
    "source" TEXT,
    "linkedinUrl" TEXT,
    "consentAt" TIMESTAMP(3),
    "consentExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "currentStageId" TEXT,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'APPLIED',
    "rating" DECIMAL(4,2),
    "rejectReason" TEXT,
    "convertedEmployeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Interview" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "mode" "InterviewMode" NOT NULL,
    "interviewerIds" TEXT NOT NULL,
    "feedbackJson" JSONB,
    "recommendation" "InterviewRecommendation",
    "status" "InterviewStatus" NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Interview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "ctcAnnual" DECIMAL(15,2),
    "grossMonthly" DECIMAL(15,2),
    "currencyCode" CHAR(3) NOT NULL,
    "joiningDate" DATE,
    "structureId" TEXT,
    "status" "OfferStatus" NOT NULL DEFAULT 'DRAFT',
    "letterUrl" TEXT,
    "sentAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "approvalRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HelpdeskCategory" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slaHours" INTEGER,
    "defaultAssigneeId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HelpdeskCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HelpdeskTicket" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "categoryId" TEXT,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "assigneeId" TEXT,
    "slaDueAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "satisfactionRating" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "HelpdeskTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HelpdeskMessage" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "attachmentsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HelpdeskMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowDefinition" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "module" "WorkflowModule" NOT NULL,
    "entityId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WorkflowDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowStep" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "workflowDefinitionId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "approverType" "ApproverType" NOT NULL,
    "approverRefId" TEXT,
    "conditionJson" JSONB,
    "isParallel" BOOLEAN NOT NULL DEFAULT false,
    "minApprovals" INTEGER NOT NULL DEFAULT 1,
    "slaHours" INTEGER,
    "onTimeoutAction" "TimeoutAction" NOT NULL DEFAULT 'ESCALATE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "workflowDefinitionId" TEXT,
    "module" "WorkflowModule" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "requesterEmployeeId" TEXT,
    "currentStepOrder" INTEGER NOT NULL DEFAULT 1,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "payloadJson" JSONB,
    "slaDueAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalAction" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "approvalRequestId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "approverUserId" TEXT NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "comment" TEXT,
    "actedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delegatedFromUserId" TEXT,

    CONSTRAINT "ApprovalAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "dataJson" JSONB,
    "entityType" TEXT,
    "entityId" TEXT,
    "readAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NumberSequence" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT,
    "scope" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "nextValue" INTEGER NOT NULL DEFAULT 1,
    "padding" INTEGER NOT NULL DEFAULT 6,
    "periodKey" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NumberSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantBrand" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entityId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "faviconUrl" TEXT,
    "primaryColor" TEXT,
    "secondaryColor" TEXT,
    "accentColor" TEXT,
    "emailFromName" TEXT,
    "emailFooter" TEXT,
    "supportEmail" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TenantBrand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrRolePermissionGrant" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "entityId" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrRolePermissionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_calendarFeedToken_key" ON "User"("calendarFeedToken");

-- CreateIndex
CREATE INDEX "User_businessRoleId_idx" ON "User"("businessRoleId");

-- CreateIndex
CREATE INDEX "User_specialtyId_idx" ON "User"("specialtyId");

-- CreateIndex
CREATE UNIQUE INDEX "Business_slug_key" ON "Business"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Business_shortId_key" ON "Business"("shortId");

-- CreateIndex
CREATE INDEX "BusinessPage_businessId_parentNav_isPublished_sortOrder_idx" ON "BusinessPage"("businessId", "parentNav", "isPublished", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessPage_businessId_parentNav_slug_key" ON "BusinessPage"("businessId", "parentNav", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessSeoSettings_businessId_key" ON "BusinessSeoSettings"("businessId");

-- CreateIndex
CREATE INDEX "SeoPageOverride_businessId_pageType_idx" ON "SeoPageOverride"("businessId", "pageType");

-- CreateIndex
CREATE UNIQUE INDEX "SeoPageOverride_businessId_url_key" ON "SeoPageOverride"("businessId", "url");

-- CreateIndex
CREATE INDEX "Product_businessId_isPublished_sortOrder_idx" ON "Product"("businessId", "isPublished", "sortOrder");

-- CreateIndex
CREATE INDEX "Product_businessId_barcode_idx" ON "Product"("businessId", "barcode");

-- CreateIndex
CREATE INDEX "Product_categoryId_isPublished_sortOrder_idx" ON "Product"("categoryId", "isPublished", "sortOrder");

-- CreateIndex
CREATE INDEX "Product_storeBrandId_idx" ON "Product"("storeBrandId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_businessId_slug_key" ON "Product"("businessId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPrice_productId_currencyCode_key" ON "ProductPrice"("productId", "currencyCode");

-- CreateIndex
CREATE INDEX "ProductVariant_productId_sortOrder_idx" ON "ProductVariant"("productId", "sortOrder");

-- CreateIndex
CREATE INDEX "Wishlist_businessId_customerId_idx" ON "Wishlist"("businessId", "customerId");

-- CreateIndex
CREATE INDEX "Wishlist_businessId_sessionId_idx" ON "Wishlist"("businessId", "sessionId");

-- CreateIndex
CREATE INDEX "WishlistItem_wishlistId_productId_idx" ON "WishlistItem"("wishlistId", "productId");

-- CreateIndex
CREATE INDEX "WishlistItem_variantId_idx" ON "WishlistItem"("variantId");

-- CreateIndex
CREATE INDEX "ProductCategory_businessId_isPublished_sortOrder_idx" ON "ProductCategory"("businessId", "isPublished", "sortOrder");

-- CreateIndex
CREATE INDEX "ProductCategory_parentId_idx" ON "ProductCategory"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_businessId_slug_key" ON "ProductCategory"("businessId", "slug");

-- CreateIndex
CREATE INDEX "Cart_businessId_customerId_idx" ON "Cart"("businessId", "customerId");

-- CreateIndex
CREATE INDEX "Cart_businessId_sessionId_idx" ON "Cart"("businessId", "sessionId");

-- CreateIndex
CREATE INDEX "Cart_businessId_locationId_idx" ON "Cart"("businessId", "locationId");

-- CreateIndex
CREATE INDEX "Cart_updatedAt_idx" ON "Cart"("updatedAt");

-- CreateIndex
CREATE INDEX "CartItem_cartId_productId_variantId_idx" ON "CartItem"("cartId", "productId", "variantId");

-- CreateIndex
CREATE INDEX "CartItem_productId_idx" ON "CartItem"("productId");

-- CreateIndex
CREATE INDEX "CartItem_variantId_idx" ON "CartItem"("variantId");

-- CreateIndex
CREATE INDEX "Order_businessId_status_placedAt_idx" ON "Order"("businessId", "status", "placedAt");

-- CreateIndex
CREATE INDEX "Order_businessId_customerEmail_idx" ON "Order"("businessId", "customerEmail");

-- CreateIndex
CREATE INDEX "Order_businessId_locationId_status_idx" ON "Order"("businessId", "locationId", "status");

-- CreateIndex
CREATE INDEX "Order_customerId_idx" ON "Order"("customerId");

-- CreateIndex
CREATE INDEX "Order_deliverySlotId_deliveryDate_idx" ON "Order"("deliverySlotId", "deliveryDate");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_productId_idx" ON "OrderItem"("productId");

-- CreateIndex
CREATE INDEX "BusinessIntegration_provider_idx" ON "BusinessIntegration"("provider");

-- CreateIndex
CREATE INDEX "BusinessIntegration_status_idx" ON "BusinessIntegration"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessIntegration_businessId_provider_key" ON "BusinessIntegration"("businessId", "provider");

-- CreateIndex
CREATE INDEX "Enquiry_businessId_status_createdAt_idx" ON "Enquiry"("businessId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessHours_businessId_dayOfWeek_key" ON "BusinessHours"("businessId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "BusinessHoliday_businessId_locationId_idx" ON "BusinessHoliday"("businessId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessHoliday_businessId_locationId_date_key" ON "BusinessHoliday"("businessId", "locationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_calendarFeedToken_key" ON "Customer"("calendarFeedToken");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_businessId_email_key" ON "Customer"("businessId", "email");

-- CreateIndex
CREATE INDEX "CustomerIdentity_customerId_idx" ON "CustomerIdentity"("customerId");

-- CreateIndex
CREATE INDEX "CustomerIdentity_businessId_idx" ON "CustomerIdentity"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerIdentity_businessId_provider_subject_key" ON "CustomerIdentity"("businessId", "provider", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerIdentity_customerId_provider_key" ON "CustomerIdentity"("customerId", "provider");

-- CreateIndex
CREATE INDEX "CustomerAddress_customerId_isDefault_idx" ON "CustomerAddress"("customerId", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessContent_businessId_key" ON "BusinessContent"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_businessId_key" ON "Subscription"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_paddleSubscriptionId_key" ON "Subscription"("paddleSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_stripeSubscriptionId_key" ON "Subscription"("stripeSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_razorpaySubscriptionId_key" ON "Subscription"("razorpaySubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_razorpayTokenId_key" ON "Subscription"("razorpayTokenId");

-- CreateIndex
CREATE UNIQUE INDEX "PaddleWebhookEvent_eventId_key" ON "PaddleWebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "PaddleWebhookEvent_status_createdAt_idx" ON "PaddleWebhookEvent"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PaddleWebhookEvent_eventType_createdAt_idx" ON "PaddleWebhookEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "PaddleWebhookEvent_businessId_createdAt_idx" ON "PaddleWebhookEvent"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "PaddleWebhookEvent_objectId_eventType_idx" ON "PaddleWebhookEvent"("objectId", "eventType");

-- CreateIndex
CREATE UNIQUE INDEX "StripeWebhookEvent_eventId_key" ON "StripeWebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "StripeWebhookEvent_status_createdAt_idx" ON "StripeWebhookEvent"("status", "createdAt");

-- CreateIndex
CREATE INDEX "StripeWebhookEvent_eventType_createdAt_idx" ON "StripeWebhookEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "StripeWebhookEvent_businessId_createdAt_idx" ON "StripeWebhookEvent"("businessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RazorpayWebhookEvent_eventId_key" ON "RazorpayWebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "RazorpayWebhookEvent_status_createdAt_idx" ON "RazorpayWebhookEvent"("status", "createdAt");

-- CreateIndex
CREATE INDEX "RazorpayWebhookEvent_eventType_createdAt_idx" ON "RazorpayWebhookEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "RazorpayWebhookEvent_businessId_createdAt_idx" ON "RazorpayWebhookEvent"("businessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaddleBillingSubscription_paddleSubscriptionId_key" ON "PaddleBillingSubscription"("paddleSubscriptionId");

-- CreateIndex
CREATE INDEX "PaddleBillingSubscription_businessId_productKind_idx" ON "PaddleBillingSubscription"("businessId", "productKind");

-- CreateIndex
CREATE INDEX "PaddleBillingSubscription_paddleCustomerId_idx" ON "PaddleBillingSubscription"("paddleCustomerId");

-- CreateIndex
CREATE INDEX "PaddleBillingSubscription_paddleTransactionId_idx" ON "PaddleBillingSubscription"("paddleTransactionId");

-- CreateIndex
CREATE INDEX "PaddleBillingSubscription_status_updatedAt_idx" ON "PaddleBillingSubscription"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaddleBillingSubscription_businessId_productKind_productRef_key" ON "PaddleBillingSubscription"("businessId", "productKind", "productRef");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPurchase_paddleTransactionId_key" ON "BillingPurchase"("paddleTransactionId");

-- CreateIndex
CREATE INDEX "BillingPurchase_businessId_createdAt_idx" ON "BillingPurchase"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingPurchase_productKind_status_idx" ON "BillingPurchase"("productKind", "status");

-- CreateIndex
CREATE INDEX "BillingPurchase_paddleSubscriptionId_idx" ON "BillingPurchase"("paddleSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "MessagingTopupGrant_paddleTransactionId_key" ON "MessagingTopupGrant"("paddleTransactionId");

-- CreateIndex
CREATE INDEX "MessagingTopupGrant_businessId_cycle_idx" ON "MessagingTopupGrant"("businessId", "cycle");

-- CreateIndex
CREATE INDEX "MessagingTopupGrant_purchaseId_idx" ON "MessagingTopupGrant"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_invoiceNumber_key" ON "PaymentAttempt"("invoiceNumber");

-- CreateIndex
CREATE INDEX "PaymentAttempt_businessId_createdAt_idx" ON "PaymentAttempt"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentAttempt_purchaseId_idx" ON "PaymentAttempt"("purchaseId");

-- CreateIndex
CREATE INDEX "PaymentAttempt_paddleTransactionId_idx" ON "PaymentAttempt"("paddleTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_businessId_paddleTransactionId_status_key" ON "PaymentAttempt"("businessId", "paddleTransactionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AdjustmentLedger_paddleAdjustmentId_key" ON "AdjustmentLedger"("paddleAdjustmentId");

-- CreateIndex
CREATE INDEX "AdjustmentLedger_businessId_createdAt_idx" ON "AdjustmentLedger"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "AdjustmentLedger_purchaseId_idx" ON "AdjustmentLedger"("purchaseId");

-- CreateIndex
CREATE INDEX "AdjustmentLedger_paddleTransactionId_idx" ON "AdjustmentLedger"("paddleTransactionId");

-- CreateIndex
CREATE INDEX "AdjustmentLedger_paddleSubscriptionId_idx" ON "AdjustmentLedger"("paddleSubscriptionId");

-- CreateIndex
CREATE INDEX "StaffSchedule_locationId_idx" ON "StaffSchedule"("locationId");

-- CreateIndex
CREATE INDEX "Waitlist_businessId_status_preferredDate_idx" ON "Waitlist"("businessId", "status", "preferredDate");

-- CreateIndex
CREATE INDEX "Waitlist_customerId_idx" ON "Waitlist"("customerId");

-- CreateIndex
CREATE INDEX "Appointment_locationId_idx" ON "Appointment"("locationId");

-- CreateIndex
CREATE INDEX "Appointment_businessId_bookingChannel_date_idx" ON "Appointment"("businessId", "bookingChannel", "date");

-- CreateIndex
CREATE INDEX "Appointment_businessId_paymentStatus_date_idx" ON "Appointment"("businessId", "paymentStatus", "date");

-- CreateIndex
CREATE INDEX "Specialty_businessId_isActive_sortOrder_idx" ON "Specialty"("businessId", "isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Specialty_businessId_slug_key" ON "Specialty"("businessId", "slug");

-- CreateIndex
CREATE INDEX "AppointmentReminder_status_scheduledFor_idx" ON "AppointmentReminder"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "AppointmentReminder_appointmentId_idx" ON "AppointmentReminder"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentReminder_appointmentId_kind_key" ON "AppointmentReminder"("appointmentId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentRecord_businessId_customerId_purpose_key" ON "ConsentRecord"("businessId", "customerId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "Review_appointmentId_key" ON "Review"("appointmentId");

-- CreateIndex
CREATE INDEX "Review_businessId_status_createdAt_idx" ON "Review"("businessId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Review_staffId_idx" ON "Review"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentPrescription_appointmentId_key" ON "AppointmentPrescription"("appointmentId");

-- CreateIndex
CREATE INDEX "AppointmentPrescription_businessId_issuedAt_idx" ON "AppointmentPrescription"("businessId", "issuedAt");

-- CreateIndex
CREATE INDEX "AppointmentPrescription_createdById_idx" ON "AppointmentPrescription"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentInvoice_appointmentId_key" ON "AppointmentInvoice"("appointmentId");

-- CreateIndex
CREATE INDEX "AppointmentInvoice_businessId_issuedAt_idx" ON "AppointmentInvoice"("businessId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentInvoice_businessId_invoiceNumber_key" ON "AppointmentInvoice"("businessId", "invoiceNumber");

-- CreateIndex
CREATE INDEX "RxTemplate_businessId_idx" ON "RxTemplate"("businessId");

-- CreateIndex
CREATE INDEX "AppointmentDocument_businessId_createdAt_idx" ON "AppointmentDocument"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "AppointmentDocument_createdById_idx" ON "AppointmentDocument"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentDocument_appointmentId_type_key" ON "AppointmentDocument"("appointmentId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "StaffLeave_staffId_date_key" ON "StaffLeave"("staffId", "date");

-- CreateIndex
CREATE INDEX "InboxNotification_userId_readAt_createdAt_idx" ON "InboxNotification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "InboxNotification_customerId_readAt_createdAt_idx" ON "InboxNotification"("customerId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "InboxNotification_businessId_createdAt_idx" ON "InboxNotification"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "InboxNotification_appointmentId_createdAt_idx" ON "InboxNotification"("appointmentId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportConversation_businessId_kind_status_lastMessageAt_idx" ON "SupportConversation"("businessId", "kind", "status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "SupportConversation_projectKey_channel_lastMessageAt_idx" ON "SupportConversation"("projectKey", "channel", "lastMessageAt");

-- CreateIndex
CREATE INDEX "SupportConversation_customerId_lastMessageAt_idx" ON "SupportConversation"("customerId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "SupportMessage_conversationId_createdAt_idx" ON "SupportMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportMessage_businessId_createdAt_idx" ON "SupportMessage"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_eventKey_createdAt_idx" ON "EmailDelivery"("eventKey", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_status_createdAt_idx" ON "EmailDelivery"("status", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_recipientEmail_createdAt_idx" ON "EmailDelivery"("recipientEmail", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_businessId_createdAt_idx" ON "EmailDelivery"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_userId_createdAt_idx" ON "EmailDelivery"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_customerId_createdAt_idx" ON "EmailDelivery"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_appointmentId_createdAt_idx" ON "EmailDelivery"("appointmentId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_subscriptionId_createdAt_idx" ON "EmailDelivery"("subscriptionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_businessId_code_key" ON "Coupon"("businessId", "code");

-- CreateIndex
CREATE INDEX "CouponRedemption_couponId_customerEmail_idx" ON "CouponRedemption"("couponId", "customerEmail");

-- CreateIndex
CREATE INDEX "CouponRedemption_couponId_customerPhone_idx" ON "CouponRedemption"("couponId", "customerPhone");

-- CreateIndex
CREATE INDEX "CouponRedemption_couponId_sessionId_idx" ON "CouponRedemption"("couponId", "sessionId");

-- CreateIndex
CREATE INDEX "CouponRedemption_orderId_idx" ON "CouponRedemption"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminCoupon_code_key" ON "AdminCoupon"("code");

-- CreateIndex
CREATE INDEX "AdminCouponRedemption_businessId_idx" ON "AdminCouponRedemption"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminCouponRedemption_couponId_businessId_key" ON "AdminCouponRedemption"("couponId", "businessId");

-- CreateIndex
CREATE UNIQUE INDEX "PricingTier_slug_key" ON "PricingTier"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "PricingZone_slug_key" ON "PricingZone"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "CountryZoneAssignment_countryCode_key" ON "CountryZoneAssignment"("countryCode");

-- CreateIndex
CREATE INDEX "CountryZoneAssignment_zoneId_idx" ON "CountryZoneAssignment"("zoneId");

-- CreateIndex
CREATE INDEX "TierPrice_countryCode_idx" ON "TierPrice"("countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "TierPrice_tierId_countryCode_key" ON "TierPrice"("tierId", "countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "TierFeature_tierId_featureKey_key" ON "TierFeature"("tierId", "featureKey");

-- CreateIndex
CREATE INDEX "PricingAuditLog_entityType_entityId_idx" ON "PricingAuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "PricingAuditLog_changedBy_createdAt_idx" ON "PricingAuditLog"("changedBy", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderPriceCache_countryCode_idx" ON "ProviderPriceCache"("countryCode");

-- CreateIndex
CREATE INDEX "ProviderPriceCache_channel_isAvailable_idx" ON "ProviderPriceCache"("channel", "isAvailable");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderPriceCache_countryCode_channel_key" ON "ProviderPriceCache"("countryCode", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationConfig_businessId_key" ON "NotificationConfig"("businessId");

-- CreateIndex
CREATE INDEX "NotificationConfig_requestAccessStatus_idx" ON "NotificationConfig"("requestAccessStatus");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_templateKey_key" ON "MessageTemplate"("templateKey");

-- CreateIndex
CREATE INDEX "MessageTemplate_vertical_isActive_sortOrder_idx" ON "MessageTemplate"("vertical", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "MessageDelivery_businessId_createdAt_idx" ON "MessageDelivery"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "MessageDelivery_recipientPhone_channel_idx" ON "MessageDelivery"("recipientPhone", "channel");

-- CreateIndex
CREATE INDEX "MessageDelivery_status_idx" ON "MessageDelivery"("status");

-- CreateIndex
CREATE INDEX "MessageDelivery_triggeredBy_idx" ON "MessageDelivery"("triggeredBy");

-- CreateIndex
CREATE INDEX "BudgetUsage_cycle_idx" ON "BudgetUsage"("cycle");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetUsage_businessId_cycle_key" ON "BudgetUsage"("businessId", "cycle");

-- CreateIndex
CREATE UNIQUE INDEX "SmsOptOut_recipientPhone_key" ON "SmsOptOut"("recipientPhone");

-- CreateIndex
CREATE INDEX "SmsOptOut_recipientPhone_idx" ON "SmsOptOut"("recipientPhone");

-- CreateIndex
CREATE INDEX "AutomationCampaign_businessId_isEnabled_idx" ON "AutomationCampaign"("businessId", "isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationCampaign_businessId_campaignKey_key" ON "AutomationCampaign"("businessId", "campaignKey");

-- CreateIndex
CREATE INDEX "AutomationEnrollment_businessId_campaignId_status_idx" ON "AutomationEnrollment"("businessId", "campaignId", "status");

-- CreateIndex
CREATE INDEX "AutomationEnrollment_scheduledFor_status_idx" ON "AutomationEnrollment"("scheduledFor", "status");

-- CreateIndex
CREATE INDEX "AutomationEnrollment_customerId_idx" ON "AutomationEnrollment"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationEnrollment_businessId_campaignId_customerId_trigg_key" ON "AutomationEnrollment"("businessId", "campaignId", "customerId", "triggeredAt", "triggerSourceId");

-- CreateIndex
CREATE INDEX "CustomerMarketingOptOut_businessId_customerId_idx" ON "CustomerMarketingOptOut"("businessId", "customerId");

-- CreateIndex
CREATE INDEX "CustomerMarketingOptOut_businessId_recipientEmail_idx" ON "CustomerMarketingOptOut"("businessId", "recipientEmail");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerMarketingOptOut_businessId_customerId_campaignKey_key" ON "CustomerMarketingOptOut"("businessId", "customerId", "campaignKey");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerMarketingOptOut_businessId_recipientEmail_campaignK_key" ON "CustomerMarketingOptOut"("businessId", "recipientEmail", "campaignKey");

-- CreateIndex
CREATE INDEX "IntakeForm_businessId_isActive_idx" ON "IntakeForm"("businessId", "isActive");

-- CreateIndex
CREATE INDEX "BlogPost_businessId_isPublished_publishedAt_idx" ON "BlogPost"("businessId", "isPublished", "publishedAt");

-- CreateIndex
CREATE INDEX "BlogPost_categoryId_isPublished_publishedAt_idx" ON "BlogPost"("categoryId", "isPublished", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BlogPost_businessId_slug_key" ON "BlogPost"("businessId", "slug");

-- CreateIndex
CREATE INDEX "BlogCategory_businessId_sortOrder_idx" ON "BlogCategory"("businessId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "BlogCategory_businessId_slug_key" ON "BlogCategory"("businessId", "slug");

-- CreateIndex
CREATE INDEX "BlogComment_postId_status_createdAt_idx" ON "BlogComment"("postId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "BlogComment_businessId_status_createdAt_idx" ON "BlogComment"("businessId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "BlogComment_parentId_idx" ON "BlogComment"("parentId");

-- CreateIndex
CREATE INDEX "BlogLike_businessId_createdAt_idx" ON "BlogLike"("businessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BlogLike_postId_customerId_key" ON "BlogLike"("postId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "BlogLike_postId_sessionId_key" ON "BlogLike"("postId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "BlogSettings_businessId_key" ON "BlogSettings"("businessId");

-- CreateIndex
CREATE INDEX "PosIntegration_businessId_idx" ON "PosIntegration"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "PosIntegration_businessId_provider_key" ON "PosIntegration"("businessId", "provider");

-- CreateIndex
CREATE INDEX "StoreBrand_businessId_isActive_idx" ON "StoreBrand"("businessId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "StoreBrand_businessId_slug_key" ON "StoreBrand"("businessId", "slug");

-- CreateIndex
CREATE INDEX "BusinessPaymentAccount_businessId_idx" ON "BusinessPaymentAccount"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessPaymentAccount_businessId_provider_key" ON "BusinessPaymentAccount"("businessId", "provider");

-- CreateIndex
CREATE INDEX "ServiceConnection_businessId_idx" ON "ServiceConnection"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceConnection_businessId_category_key" ON "ServiceConnection"("businessId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_businessId_isActive_idx" ON "ApiKey"("businessId", "isActive");

-- CreateIndex
CREATE INDEX "ApiKey_keyHash_idx" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "WebhookSubscription_businessId_isActive_idx" ON "WebhookSubscription"("businessId", "isActive");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextRetryAt_idx" ON "WebhookDelivery"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_businessId_createdAt_idx" ON "WebhookDelivery"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_subscriptionId_idx" ON "WebhookDelivery"("subscriptionId");

-- CreateIndex
CREATE INDEX "BusinessRole_businessId_idx" ON "BusinessRole"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessRole_businessId_name_key" ON "BusinessRole"("businessId", "name");

-- CreateIndex
CREATE INDEX "BusinessLocation_businessId_isActive_idx" ON "BusinessLocation"("businessId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantSettings_businessId_key" ON "RestaurantSettings"("businessId");

-- CreateIndex
CREATE INDEX "RestaurantDiningArea_businessId_locationId_isActive_idx" ON "RestaurantDiningArea"("businessId", "locationId", "isActive");

-- CreateIndex
CREATE INDEX "RestaurantTable_businessId_isActive_onlineBookable_idx" ON "RestaurantTable"("businessId", "isActive", "onlineBookable");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantTable_businessId_areaId_label_key" ON "RestaurantTable"("businessId", "areaId", "label");

-- CreateIndex
CREATE INDEX "RestaurantServicePeriod_businessId_locationId_dayOfWeek_isA_idx" ON "RestaurantServicePeriod"("businessId", "locationId", "dayOfWeek", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantReservation_appointmentId_key" ON "RestaurantReservation"("appointmentId");

-- CreateIndex
CREATE INDEX "RestaurantReservation_businessId_arrivalStatus_createdAt_idx" ON "RestaurantReservation"("businessId", "arrivalStatus", "createdAt");

-- CreateIndex
CREATE INDEX "RestaurantReservation_businessId_locationId_partySize_idx" ON "RestaurantReservation"("businessId", "locationId", "partySize");

-- CreateIndex
CREATE INDEX "RestaurantReservationTable_tableId_idx" ON "RestaurantReservationTable"("tableId");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantReservationTable_reservationId_tableId_key" ON "RestaurantReservationTable"("reservationId", "tableId");

-- CreateIndex
CREATE UNIQUE INDEX "LawFirmIntake_appointmentId_key" ON "LawFirmIntake"("appointmentId");

-- CreateIndex
CREATE INDEX "LawFirmIntake_businessId_conflictStatus_createdAt_idx" ON "LawFirmIntake"("businessId", "conflictStatus", "createdAt");

-- CreateIndex
CREATE INDEX "CustomerTag_businessId_idx" ON "CustomerTag"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerTag_businessId_name_key" ON "CustomerTag"("businessId", "name");

-- CreateIndex
CREATE INDEX "CustomerTagAssignment_tagId_idx" ON "CustomerTagAssignment"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerTagAssignment_customerId_tagId_key" ON "CustomerTagAssignment"("customerId", "tagId");

-- CreateIndex
CREATE INDEX "CustomerSegment_businessId_idx" ON "CustomerSegment"("businessId");

-- CreateIndex
CREATE INDEX "IntakeSubmission_businessId_createdAt_idx" ON "IntakeSubmission"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "IntakeSubmission_appointmentId_idx" ON "IntakeSubmission"("appointmentId");

-- CreateIndex
CREATE INDEX "IntakeSubmission_formId_idx" ON "IntakeSubmission"("formId");

-- CreateIndex
CREATE INDEX "IntakeSubmission_customerId_idx" ON "IntakeSubmission"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "EcomPermission_key_key" ON "EcomPermission"("key");

-- CreateIndex
CREATE INDEX "EcomPermission_area_weight_idx" ON "EcomPermission"("area", "weight");

-- CreateIndex
CREATE INDEX "EcomRolePermissionGrant_businessId_idx" ON "EcomRolePermissionGrant"("businessId");

-- CreateIndex
CREATE INDEX "EcomRolePermissionGrant_locationId_idx" ON "EcomRolePermissionGrant"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "EcomRolePermissionGrant_roleId_permissionId_locationId_key" ON "EcomRolePermissionGrant"("roleId", "permissionId", "locationId");

-- CreateIndex
CREATE INDEX "InventoryStock_businessId_locationId_idx" ON "InventoryStock"("businessId", "locationId");

-- CreateIndex
CREATE INDEX "InventoryStock_businessId_onHand_idx" ON "InventoryStock"("businessId", "onHand");

-- CreateIndex
CREATE INDEX "InventoryStock_businessId_supplierSku_idx" ON "InventoryStock"("businessId", "supplierSku");

-- CreateIndex
CREATE INDEX "InventoryStock_businessId_localPickCode_idx" ON "InventoryStock"("businessId", "localPickCode");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryStock_productId_locationId_key" ON "InventoryStock"("productId", "locationId");

-- CreateIndex
CREATE INDEX "InventoryAdjustment_businessId_createdAt_idx" ON "InventoryAdjustment"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryAdjustment_stockId_createdAt_idx" ON "InventoryAdjustment"("stockId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryAdjustment_sourceType_sourceId_idx" ON "InventoryAdjustment"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "ProductLocationOverride_businessId_locationId_isAvailable_idx" ON "ProductLocationOverride"("businessId", "locationId", "isAvailable");

-- CreateIndex
CREATE INDEX "ProductLocationOverride_locationId_isAvailable_idx" ON "ProductLocationOverride"("locationId", "isAvailable");

-- CreateIndex
CREATE UNIQUE INDEX "ProductLocationOverride_productId_locationId_key" ON "ProductLocationOverride"("productId", "locationId");

-- CreateIndex
CREATE INDEX "EcomRider_businessId_status_idx" ON "EcomRider"("businessId", "status");

-- CreateIndex
CREATE INDEX "EcomRider_homeLocationId_idx" ON "EcomRider"("homeLocationId");

-- CreateIndex
CREATE INDEX "EcomRiderShift_businessId_riderId_status_idx" ON "EcomRiderShift"("businessId", "riderId", "status");

-- CreateIndex
CREATE INDEX "EcomRiderShift_businessId_locationId_startedAt_idx" ON "EcomRiderShift"("businessId", "locationId", "startedAt");

-- CreateIndex
CREATE INDEX "EcomRiderShift_businessId_status_startedAt_idx" ON "EcomRiderShift"("businessId", "status", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EcomDeliveryRequest_trackingToken_key" ON "EcomDeliveryRequest"("trackingToken");

-- CreateIndex
CREATE INDEX "EcomDeliveryRequest_businessId_status_createdAt_idx" ON "EcomDeliveryRequest"("businessId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "EcomDeliveryRequest_businessId_locationId_status_idx" ON "EcomDeliveryRequest"("businessId", "locationId", "status");

-- CreateIndex
CREATE INDEX "EcomDeliveryRequest_businessId_riderId_status_idx" ON "EcomDeliveryRequest"("businessId", "riderId", "status");

-- CreateIndex
CREATE INDEX "EcomDeliveryRequest_businessId_exceptionStatus_createdAt_idx" ON "EcomDeliveryRequest"("businessId", "exceptionStatus", "createdAt");

-- CreateIndex
CREATE INDEX "EcomDeliveryRequest_businessId_exceptionCode_createdAt_idx" ON "EcomDeliveryRequest"("businessId", "exceptionCode", "createdAt");

-- CreateIndex
CREATE INDEX "EcomDeliveryRequest_orderId_idx" ON "EcomDeliveryRequest"("orderId");

-- CreateIndex
CREATE INDEX "EcomDeliveryRequest_sourceRef_idx" ON "EcomDeliveryRequest"("sourceRef");

-- CreateIndex
CREATE UNIQUE INDEX "EcomDeliveryRequest_businessId_source_sourceRef_key" ON "EcomDeliveryRequest"("businessId", "source", "sourceRef");

-- CreateIndex
CREATE INDEX "EcomDeliveryRequestEvent_businessId_deliveryRequestId_creat_idx" ON "EcomDeliveryRequestEvent"("businessId", "deliveryRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "EcomDeliveryRequestEvent_deliveryRequestId_createdAt_idx" ON "EcomDeliveryRequestEvent"("deliveryRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "EcomDeliveryRequestEvent_businessId_createdAt_idx" ON "EcomDeliveryRequestEvent"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "EcomDeliveryRequestEvent_businessId_kind_createdAt_idx" ON "EcomDeliveryRequestEvent"("businessId", "kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EcomDeliveryRoute_code_key" ON "EcomDeliveryRoute"("code");

-- CreateIndex
CREATE INDEX "EcomDeliveryRoute_businessId_status_scheduledAt_idx" ON "EcomDeliveryRoute"("businessId", "status", "scheduledAt");

-- CreateIndex
CREATE INDEX "EcomDeliveryRoute_locationId_scheduledAt_idx" ON "EcomDeliveryRoute"("locationId", "scheduledAt");

-- CreateIndex
CREATE INDEX "EcomDeliveryRoute_riderId_scheduledAt_idx" ON "EcomDeliveryRoute"("riderId", "scheduledAt");

-- CreateIndex
CREATE INDEX "EcomDeliveryRouteStop_orderId_idx" ON "EcomDeliveryRouteStop"("orderId");

-- CreateIndex
CREATE INDEX "EcomDeliveryRouteStop_deliveryRequestId_idx" ON "EcomDeliveryRouteStop"("deliveryRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "EcomDeliveryRouteStop_routeId_sequence_key" ON "EcomDeliveryRouteStop"("routeId", "sequence");

-- CreateIndex
CREATE INDEX "EcomDeliveryLocationPing_businessId_createdAt_idx" ON "EcomDeliveryLocationPing"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "EcomDeliveryLocationPing_deliveryRequestId_createdAt_idx" ON "EcomDeliveryLocationPing"("deliveryRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "EcomDeliveryLocationPing_riderId_createdAt_idx" ON "EcomDeliveryLocationPing"("riderId", "createdAt");

-- CreateIndex
CREATE INDEX "EcomDeliveryLocationPing_routeId_createdAt_idx" ON "EcomDeliveryLocationPing"("routeId", "createdAt");

-- CreateIndex
CREATE INDEX "EcomDeliveryLocationPing_routeStopId_createdAt_idx" ON "EcomDeliveryLocationPing"("routeStopId", "createdAt");

-- CreateIndex
CREATE INDEX "EcomDeliveryCashSettlement_businessId_riderId_settlementDat_idx" ON "EcomDeliveryCashSettlement"("businessId", "riderId", "settlementDate");

-- CreateIndex
CREATE INDEX "EcomDeliveryCashSettlement_businessId_locationId_settlement_idx" ON "EcomDeliveryCashSettlement"("businessId", "locationId", "settlementDate");

-- CreateIndex
CREATE INDEX "EcomDeliveryCashSettlement_businessId_status_createdAt_idx" ON "EcomDeliveryCashSettlement"("businessId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "EcomDeliverySlot_businessId_locationId_dayOfWeek_idx" ON "EcomDeliverySlot"("businessId", "locationId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "EcomDeliverySlot_businessId_locationId_specificDate_idx" ON "EcomDeliverySlot"("businessId", "locationId", "specificDate");

-- CreateIndex
CREATE INDEX "EcomDeliverySlot_locationId_isActive_idx" ON "EcomDeliverySlot"("locationId", "isActive");

-- CreateIndex
CREATE INDEX "EcomDeliverySlotBooking_businessId_deliveryDate_idx" ON "EcomDeliverySlotBooking"("businessId", "deliveryDate");

-- CreateIndex
CREATE INDEX "EcomDeliverySlotBooking_slotId_deliveryDate_idx" ON "EcomDeliverySlotBooking"("slotId", "deliveryDate");

-- CreateIndex
CREATE INDEX "EcomDeliverySlotBooking_orderId_idx" ON "EcomDeliverySlotBooking"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "EcomDeliverySlotBooking_slotId_deliveryDate_orderId_key" ON "EcomDeliverySlotBooking"("slotId", "deliveryDate", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "EcomReturn_code_key" ON "EcomReturn"("code");

-- CreateIndex
CREATE INDEX "EcomReturn_businessId_status_createdAt_idx" ON "EcomReturn"("businessId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "EcomReturn_orderId_idx" ON "EcomReturn"("orderId");

-- CreateIndex
CREATE INDEX "EcomReturn_customerEmail_idx" ON "EcomReturn"("customerEmail");

-- CreateIndex
CREATE INDEX "EcomReturnItem_returnId_idx" ON "EcomReturnItem"("returnId");

-- CreateIndex
CREATE INDEX "EcomReturnItem_productId_idx" ON "EcomReturnItem"("productId");

-- CreateIndex
CREATE INDEX "EcomReturnEvent_returnId_createdAt_idx" ON "EcomReturnEvent"("returnId", "createdAt");

-- CreateIndex
CREATE INDEX "CustomerWallet_businessId_idx" ON "CustomerWallet"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerWallet_businessId_customerId_key" ON "CustomerWallet"("businessId", "customerId");

-- CreateIndex
CREATE INDEX "CustomerShoppingList_businessId_customerId_idx" ON "CustomerShoppingList"("businessId", "customerId");

-- CreateIndex
CREATE INDEX "ShoppingListItem_productId_idx" ON "ShoppingListItem"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ShoppingListItem_listId_productId_variantId_key" ON "ShoppingListItem"("listId", "productId", "variantId");

-- CreateIndex
CREATE INDEX "OrderIssueReport_businessId_status_createdAt_idx" ON "OrderIssueReport"("businessId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "OrderIssueReport_orderId_idx" ON "OrderIssueReport"("orderId");

-- CreateIndex
CREATE INDEX "Recipe_businessId_isPublished_sortOrder_idx" ON "Recipe"("businessId", "isPublished", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Recipe_businessId_slug_key" ON "Recipe"("businessId", "slug");

-- CreateIndex
CREATE INDEX "RecipeIngredient_recipeId_sortOrder_idx" ON "RecipeIngredient"("recipeId", "sortOrder");

-- CreateIndex
CREATE INDEX "RecipeIngredient_productId_idx" ON "RecipeIngredient"("productId");

-- CreateIndex
CREATE INDEX "CustomerSubscription_businessId_customerId_idx" ON "CustomerSubscription"("businessId", "customerId");

-- CreateIndex
CREATE INDEX "CustomerSubscription_businessId_status_nextDeliveryAt_idx" ON "CustomerSubscription"("businessId", "status", "nextDeliveryAt");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_walletId_createdAt_idx" ON "WalletLedgerEntry"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_businessId_createdAt_idx" ON "WalletLedgerEntry"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "EcomReview_businessId_productId_status_createdAt_idx" ON "EcomReview"("businessId", "productId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "EcomReview_businessId_riderId_status_createdAt_idx" ON "EcomReview"("businessId", "riderId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "EcomReview_businessId_status_createdAt_idx" ON "EcomReview"("businessId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "EcomBanner_businessId_placement_isActive_sortOrder_idx" ON "EcomBanner"("businessId", "placement", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "EcomBanner_businessId_locationId_idx" ON "EcomBanner"("businessId", "locationId");

-- CreateIndex
CREATE INDEX "EcomBanner_businessId_startsAt_endsAt_idx" ON "EcomBanner"("businessId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "EcomCmsBlock_businessId_slotKey_status_sortOrder_idx" ON "EcomCmsBlock"("businessId", "slotKey", "status", "sortOrder");

-- CreateIndex
CREATE INDEX "EcomCmsBlock_businessId_status_idx" ON "EcomCmsBlock"("businessId", "status");

-- CreateIndex
CREATE INDEX "EcomOrderEvent_businessId_orderId_createdAt_idx" ON "EcomOrderEvent"("businessId", "orderId", "createdAt");

-- CreateIndex
CREATE INDEX "EcomOrderEvent_orderId_createdAt_idx" ON "EcomOrderEvent"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "EcomServiceCity_businessId_isActive_sortOrder_idx" ON "EcomServiceCity"("businessId", "isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "EcomServiceCity_businessId_slug_key" ON "EcomServiceCity"("businessId", "slug");

-- CreateIndex
CREATE INDEX "EcomDeliveryZone_businessId_isActive_idx" ON "EcomDeliveryZone"("businessId", "isActive");

-- CreateIndex
CREATE INDEX "EcomDeliveryZone_cityId_isActive_idx" ON "EcomDeliveryZone"("cityId", "isActive");

-- CreateIndex
CREATE INDEX "EcomDeliveryZone_primaryLocationId_idx" ON "EcomDeliveryZone"("primaryLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "EcomDeliveryZone_businessId_cityId_slug_key" ON "EcomDeliveryZone"("businessId", "cityId", "slug");

-- CreateIndex
CREATE INDEX "EcomPickupLocation_businessId_isActive_sortOrder_idx" ON "EcomPickupLocation"("businessId", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "EcomPickupLocation_businessId_locationId_isActive_idx" ON "EcomPickupLocation"("businessId", "locationId", "isActive");

-- CreateIndex
CREATE INDEX "ProductBrandFamily_businessId_isActive_sortOrder_idx" ON "ProductBrandFamily"("businessId", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "ProductBrandFamily_businessId_countryCode_idx" ON "ProductBrandFamily"("businessId", "countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "ProductBrandFamily_businessId_slug_key" ON "ProductBrandFamily"("businessId", "slug");

-- CreateIndex
CREATE INDEX "ProductBrand_businessId_brandFamilyId_idx" ON "ProductBrand"("businessId", "brandFamilyId");

-- CreateIndex
CREATE INDEX "ProductBrand_businessId_isActive_sortOrder_idx" ON "ProductBrand"("businessId", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "ProductBrand_businessId_countryCode_idx" ON "ProductBrand"("businessId", "countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "ProductBrand_businessId_slug_key" ON "ProductBrand"("businessId", "slug");

-- CreateIndex
CREATE INDEX "EcomSupplier_businessId_isActive_idx" ON "EcomSupplier"("businessId", "isActive");

-- CreateIndex
CREATE INDEX "EcomSupplier_businessId_name_idx" ON "EcomSupplier"("businessId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "EcomGoodsReceiptNote_code_key" ON "EcomGoodsReceiptNote"("code");

-- CreateIndex
CREATE INDEX "EcomGoodsReceiptNote_businessId_status_receivedAt_idx" ON "EcomGoodsReceiptNote"("businessId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "EcomGoodsReceiptNote_locationId_receivedAt_idx" ON "EcomGoodsReceiptNote"("locationId", "receivedAt");

-- CreateIndex
CREATE INDEX "EcomGoodsReceiptNote_supplierId_idx" ON "EcomGoodsReceiptNote"("supplierId");

-- CreateIndex
CREATE INDEX "EcomGoodsReceiptItem_grnId_idx" ON "EcomGoodsReceiptItem"("grnId");

-- CreateIndex
CREATE INDEX "EcomGoodsReceiptItem_productId_idx" ON "EcomGoodsReceiptItem"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "EcomInventoryTransfer_code_key" ON "EcomInventoryTransfer"("code");

-- CreateIndex
CREATE INDEX "EcomInventoryTransfer_businessId_status_shippedAt_idx" ON "EcomInventoryTransfer"("businessId", "status", "shippedAt");

-- CreateIndex
CREATE INDEX "EcomInventoryTransfer_fromLocationId_shippedAt_idx" ON "EcomInventoryTransfer"("fromLocationId", "shippedAt");

-- CreateIndex
CREATE INDEX "EcomInventoryTransfer_toLocationId_receivedAt_idx" ON "EcomInventoryTransfer"("toLocationId", "receivedAt");

-- CreateIndex
CREATE INDEX "EcomInventoryTransfer_riderId_idx" ON "EcomInventoryTransfer"("riderId");

-- CreateIndex
CREATE INDEX "EcomInventoryTransferItem_transferId_idx" ON "EcomInventoryTransferItem"("transferId");

-- CreateIndex
CREATE INDEX "EcomInventoryTransferItem_productId_idx" ON "EcomInventoryTransferItem"("productId");

-- CreateIndex
CREATE INDEX "EcomActivityEvent_businessId_createdAt_idx" ON "EcomActivityEvent"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "EcomActivityEvent_businessId_area_createdAt_idx" ON "EcomActivityEvent"("businessId", "area", "createdAt");

-- CreateIndex
CREATE INDEX "EcomActivityEvent_businessId_severity_createdAt_idx" ON "EcomActivityEvent"("businessId", "severity", "createdAt");

-- CreateIndex
CREATE INDEX "EcomActivityEvent_businessId_actorUserId_createdAt_idx" ON "EcomActivityEvent"("businessId", "actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "EcomActivityEvent_businessId_targetType_targetId_idx" ON "EcomActivityEvent"("businessId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "EcomLoyaltyLedger_businessId_customerId_createdAt_idx" ON "EcomLoyaltyLedger"("businessId", "customerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EcomLoyaltyLedger_orderId_type_key" ON "EcomLoyaltyLedger"("orderId", "type");

-- CreateIndex
CREATE INDEX "AccountAuditLog_eventType_createdAt_idx" ON "AccountAuditLog"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "AccountAuditLog_targetType_targetId_idx" ON "AccountAuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AccountAuditLog_originalEmailHash_idx" ON "AccountAuditLog"("originalEmailHash");

-- CreateIndex
CREATE INDEX "Redirect_businessId_idx" ON "Redirect"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Redirect_businessId_fromPath_key" ON "Redirect"("businessId", "fromPath");

-- CreateIndex
CREATE INDEX "StorePolicy_businessId_idx" ON "StorePolicy"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "StorePolicy_businessId_slug_key" ON "StorePolicy"("businessId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Matter_originAppointmentId_key" ON "Matter"("originAppointmentId");

-- CreateIndex
CREATE INDEX "Matter_businessId_status_openedAt_idx" ON "Matter"("businessId", "status", "openedAt");

-- CreateIndex
CREATE INDEX "Matter_businessId_customerId_idx" ON "Matter"("businessId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Matter_businessId_matterNumber_key" ON "Matter"("businessId", "matterNumber");

-- CreateIndex
CREATE INDEX "MatterInvoice_businessId_status_issuedAt_idx" ON "MatterInvoice"("businessId", "status", "issuedAt");

-- CreateIndex
CREATE INDEX "MatterInvoice_matterId_idx" ON "MatterInvoice"("matterId");

-- CreateIndex
CREATE UNIQUE INDEX "MatterInvoice_businessId_invoiceNumber_key" ON "MatterInvoice"("businessId", "invoiceNumber");

-- CreateIndex
CREATE INDEX "MatterTimeEntry_businessId_matterId_billed_idx" ON "MatterTimeEntry"("businessId", "matterId", "billed");

-- CreateIndex
CREATE INDEX "MatterDisbursement_businessId_matterId_billed_idx" ON "MatterDisbursement"("businessId", "matterId", "billed");

-- CreateIndex
CREATE INDEX "TrustTransaction_businessId_createdAt_idx" ON "TrustTransaction"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "TrustTransaction_matterId_createdAt_idx" ON "TrustTransaction"("matterId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InstalledUnit_originAppointmentId_key" ON "InstalledUnit"("originAppointmentId");

-- CreateIndex
CREATE INDEX "InstalledUnit_businessId_pincode_idx" ON "InstalledUnit"("businessId", "pincode");

-- CreateIndex
CREATE INDEX "InstalledUnit_businessId_customerId_idx" ON "InstalledUnit"("businessId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "AmcContract_originAppointmentId_key" ON "AmcContract"("originAppointmentId");

-- CreateIndex
CREATE INDEX "AmcContract_businessId_status_endDate_idx" ON "AmcContract"("businessId", "status", "endDate");

-- CreateIndex
CREATE INDEX "AmcContract_businessId_nextVisitDueAt_idx" ON "AmcContract"("businessId", "nextVisitDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "AmcContract_businessId_contractNumber_key" ON "AmcContract"("businessId", "contractNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceVisit_appointmentId_key" ON "ServiceVisit"("appointmentId");

-- CreateIndex
CREATE INDEX "ServiceVisit_businessId_status_scheduledFor_idx" ON "ServiceVisit"("businessId", "status", "scheduledFor");

-- CreateIndex
CREATE INDEX "ServiceVisit_businessId_dueBy_idx" ON "ServiceVisit"("businessId", "dueBy");

-- CreateIndex
CREATE INDEX "ServiceVisit_amcContractId_idx" ON "ServiceVisit"("amcContractId");

-- CreateIndex
CREATE INDEX "AmcInvoice_businessId_status_issuedAt_idx" ON "AmcInvoice"("businessId", "status", "issuedAt");

-- CreateIndex
CREATE INDEX "AmcInvoice_amcContractId_idx" ON "AmcInvoice"("amcContractId");

-- CreateIndex
CREATE UNIQUE INDEX "AmcInvoice_businessId_invoiceNumber_key" ON "AmcInvoice"("businessId", "invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "QaUser_email_key" ON "QaUser"("email");

-- CreateIndex
CREATE INDEX "QaUser_isActive_createdAt_idx" ON "QaUser"("isActive", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "QaProject_key_key" ON "QaProject"("key");

-- CreateIndex
CREATE INDEX "QaProject_isActive_name_idx" ON "QaProject"("isActive", "name");

-- CreateIndex
CREATE INDEX "QaProjectVertical_projectId_isActive_sortOrder_idx" ON "QaProjectVertical"("projectId", "isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "QaProjectVertical_projectId_key_key" ON "QaProjectVertical"("projectId", "key");

-- CreateIndex
CREATE INDEX "QaProjectMember_projectId_isActive_idx" ON "QaProjectMember"("projectId", "isActive");

-- CreateIndex
CREATE INDEX "QaProjectMember_userId_isActive_idx" ON "QaProjectMember"("userId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "QaProjectMember_userId_projectId_key" ON "QaProjectMember"("userId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "QaAgentKey_tokenHash_key" ON "QaAgentKey"("tokenHash");

-- CreateIndex
CREATE INDEX "QaAgentKey_isActive_idx" ON "QaAgentKey"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "QaIssue_publicId_key" ON "QaIssue"("publicId");

-- CreateIndex
CREATE INDEX "QaIssue_projectId_status_createdAt_idx" ON "QaIssue"("projectId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "QaIssue_projectId_type_createdAt_idx" ON "QaIssue"("projectId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "QaIssue_verticalId_status_idx" ON "QaIssue"("verticalId", "status");

-- CreateIndex
CREATE INDEX "QaIssue_createdById_createdAt_idx" ON "QaIssue"("createdById", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "QaIssue_projectId_projectIssueNumber_key" ON "QaIssue"("projectId", "projectIssueNumber");

-- CreateIndex
CREATE INDEX "QaIssueComment_issueId_createdAt_idx" ON "QaIssueComment"("issueId", "createdAt");

-- CreateIndex
CREATE INDEX "QaIssueComment_authorUserId_createdAt_idx" ON "QaIssueComment"("authorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "Entity_businessId_countryCode_status_idx" ON "Entity"("businessId", "countryCode", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Entity_businessId_code_key" ON "Entity"("businessId", "code");

-- CreateIndex
CREATE INDEX "Location_businessId_entityId_isActive_idx" ON "Location"("businessId", "entityId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Location_businessId_entityId_code_key" ON "Location"("businessId", "entityId", "code");

-- CreateIndex
CREATE INDEX "Department_businessId_parentId_idx" ON "Department"("businessId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Department_businessId_code_key" ON "Department"("businessId", "code");

-- CreateIndex
CREATE INDEX "Designation_businessId_gradeId_idx" ON "Designation"("businessId", "gradeId");

-- CreateIndex
CREATE UNIQUE INDEX "Designation_businessId_code_key" ON "Designation"("businessId", "code");

-- CreateIndex
CREATE INDEX "Grade_businessId_rank_idx" ON "Grade"("businessId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "Grade_businessId_code_key" ON "Grade"("businessId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Band_businessId_code_key" ON "Band"("businessId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_userId_key" ON "Employee"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_currentEmploymentRecordId_key" ON "Employee"("currentEmploymentRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_currentCompensationId_key" ON "Employee"("currentCompensationId");

-- CreateIndex
CREATE INDEX "Employee_businessId_status_idx" ON "Employee"("businessId", "status");

-- CreateIndex
CREATE INDEX "Employee_businessId_managerEmployeeId_idx" ON "Employee"("businessId", "managerEmployeeId");

-- CreateIndex
CREATE INDEX "Employee_businessId_workEmail_idx" ON "Employee"("businessId", "workEmail");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_businessId_code_key" ON "Employee"("businessId", "code");

-- CreateIndex
CREATE INDEX "EmploymentRecord_businessId_entityId_isCurrent_idx" ON "EmploymentRecord"("businessId", "entityId", "isCurrent");

-- CreateIndex
CREATE INDEX "EmploymentRecord_businessId_employeeId_effectiveFrom_idx" ON "EmploymentRecord"("businessId", "employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "EmploymentRecord_businessId_departmentId_idx" ON "EmploymentRecord"("businessId", "departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "EmploymentRecord_employeeId_effectiveFrom_key" ON "EmploymentRecord"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "BankAccount_businessId_employeeId_isPrimary_idx" ON "BankAccount"("businessId", "employeeId", "isPrimary");

-- CreateIndex
CREATE INDEX "EmergencyContact_businessId_employeeId_idx" ON "EmergencyContact"("businessId", "employeeId");

-- CreateIndex
CREATE INDEX "Dependant_businessId_employeeId_idx" ON "Dependant"("businessId", "employeeId");

-- CreateIndex
CREATE INDEX "SalaryComponent_businessId_entityId_category_idx" ON "SalaryComponent"("businessId", "entityId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryComponent_businessId_code_key" ON "SalaryComponent"("businessId", "code");

-- CreateIndex
CREATE INDEX "SalaryStructure_businessId_entityId_isActive_idx" ON "SalaryStructure"("businessId", "entityId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryStructure_businessId_entityId_code_key" ON "SalaryStructure"("businessId", "entityId", "code");

-- CreateIndex
CREATE INDEX "SalaryComponentLine_businessId_structureId_idx" ON "SalaryComponentLine"("businessId", "structureId");

-- CreateIndex
CREATE INDEX "SalaryComponentLine_businessId_compensationId_idx" ON "SalaryComponentLine"("businessId", "compensationId");

-- CreateIndex
CREATE INDEX "CompensationRevision_businessId_employeeId_isCurrent_idx" ON "CompensationRevision"("businessId", "employeeId", "isCurrent");

-- CreateIndex
CREATE INDEX "CompensationRevision_businessId_entityId_effectiveFrom_idx" ON "CompensationRevision"("businessId", "entityId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationRevision_employeeId_effectiveFrom_key" ON "CompensationRevision"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "StatutoryProfile_employeeId_key" ON "StatutoryProfile"("employeeId");

-- CreateIndex
CREATE INDEX "StatutoryProfile_businessId_countryCode_idx" ON "StatutoryProfile"("businessId", "countryCode");

-- CreateIndex
CREATE INDEX "StatutoryProfile_businessId_uan_idx" ON "StatutoryProfile"("businessId", "uan");

-- CreateIndex
CREATE INDEX "StatutoryProfile_businessId_irdNumber_idx" ON "StatutoryProfile"("businessId", "irdNumber");

-- CreateIndex
CREATE INDEX "StatutoryElectionHistory_businessId_statutoryProfileId_fiel_idx" ON "StatutoryElectionHistory"("businessId", "statutoryProfileId", "field");

-- CreateIndex
CREATE INDEX "StatutoryRegistration_businessId_entityId_kind_idx" ON "StatutoryRegistration"("businessId", "entityId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "StatutoryRegistration_businessId_entityId_kind_stateCode_key" ON "StatutoryRegistration"("businessId", "entityId", "kind", "stateCode");

-- CreateIndex
CREATE INDEX "PayCalendar_businessId_entityId_isActive_idx" ON "PayCalendar"("businessId", "entityId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "PayCalendar_businessId_entityId_code_key" ON "PayCalendar"("businessId", "entityId", "code");

-- CreateIndex
CREATE INDEX "PayRun_businessId_entityId_payCalendarId_periodStart_type_idx" ON "PayRun"("businessId", "entityId", "payCalendarId", "periodStart", "type");

-- CreateIndex
CREATE INDEX "PayRun_businessId_entityId_status_idx" ON "PayRun"("businessId", "entityId", "status");

-- CreateIndex
CREATE INDEX "PayRun_businessId_taxYear_idx" ON "PayRun"("businessId", "taxYear");

-- CreateIndex
CREATE UNIQUE INDEX "PayRun_businessId_code_key" ON "PayRun"("businessId", "code");

-- CreateIndex
CREATE INDEX "AttendancePayInput_businessId_payRunId_idx" ON "AttendancePayInput"("businessId", "payRunId");

-- CreateIndex
CREATE INDEX "AttendancePayInput_businessId_employeeId_idx" ON "AttendancePayInput"("businessId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendancePayInput_payRunId_employeeId_key" ON "AttendancePayInput"("payRunId", "employeeId");

-- CreateIndex
CREATE INDEX "PayRunLine_businessId_employeeId_idx" ON "PayRunLine"("businessId", "employeeId");

-- CreateIndex
CREATE INDEX "PayRunLine_businessId_payRunId_status_idx" ON "PayRunLine"("businessId", "payRunId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PayRunLine_payRunId_employeeId_key" ON "PayRunLine"("payRunId", "employeeId");

-- CreateIndex
CREATE INDEX "PayRunLineComponent_businessId_payRunLineId_idx" ON "PayRunLineComponent"("businessId", "payRunLineId");

-- CreateIndex
CREATE INDEX "PayRunLineComponent_businessId_componentCode_idx" ON "PayRunLineComponent"("businessId", "componentCode");

-- CreateIndex
CREATE UNIQUE INDEX "Payslip_payRunLineId_key" ON "Payslip"("payRunLineId");

-- CreateIndex
CREATE INDEX "Payslip_businessId_employeeId_payDate_idx" ON "Payslip"("businessId", "employeeId", "payDate");

-- CreateIndex
CREATE UNIQUE INDEX "Payslip_businessId_payRunId_employeeId_key" ON "Payslip"("businessId", "payRunId", "employeeId");

-- CreateIndex
CREATE INDEX "StatutoryRemittance_businessId_entityId_kind_taxPeriod_idx" ON "StatutoryRemittance"("businessId", "entityId", "kind", "taxPeriod");

-- CreateIndex
CREATE INDEX "StatutoryRemittance_businessId_status_dueDate_idx" ON "StatutoryRemittance"("businessId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "LeaveType_businessId_countryCode_category_idx" ON "LeaveType"("businessId", "countryCode", "category");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveType_businessId_code_key" ON "LeaveType"("businessId", "code");

-- CreateIndex
CREATE INDEX "LeavePolicy_businessId_leaveTypeId_entityId_idx" ON "LeavePolicy"("businessId", "leaveTypeId", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "LeavePolicy_businessId_code_key" ON "LeavePolicy"("businessId", "code");

-- CreateIndex
CREATE INDEX "AccrualRule_businessId_leavePolicyId_minTenureMonths_idx" ON "AccrualRule"("businessId", "leavePolicyId", "minTenureMonths");

-- CreateIndex
CREATE INDEX "LeavePolicyAssignment_businessId_leavePolicyId_scope_scopeR_idx" ON "LeavePolicyAssignment"("businessId", "leavePolicyId", "scope", "scopeRefId");

-- CreateIndex
CREATE INDEX "LeaveBalance_businessId_employeeId_idx" ON "LeaveBalance"("businessId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveBalance_businessId_employeeId_leaveTypeId_periodCode_key" ON "LeaveBalance"("businessId", "employeeId", "leaveTypeId", "periodCode");

-- CreateIndex
CREATE INDEX "LeaveTransaction_businessId_employeeId_leaveTypeId_idx" ON "LeaveTransaction"("businessId", "employeeId", "leaveTypeId");

-- CreateIndex
CREATE INDEX "LeaveTransaction_businessId_status_idx" ON "LeaveTransaction"("businessId", "status");

-- CreateIndex
CREATE INDEX "LeaveTransaction_businessId_startDate_endDate_idx" ON "LeaveTransaction"("businessId", "startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftPattern_businessId_code_key" ON "ShiftPattern"("businessId", "code");

-- CreateIndex
CREATE INDEX "ShiftAssignment_businessId_employeeId_effectiveFrom_idx" ON "ShiftAssignment"("businessId", "employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "Holiday_businessId_countryCode_date_idx" ON "Holiday"("businessId", "countryCode", "date");

-- CreateIndex
CREATE INDEX "Holiday_businessId_entityId_locationId_date_idx" ON "Holiday"("businessId", "entityId", "locationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Holiday_businessId_scopeKey_date_name_key" ON "Holiday"("businessId", "scopeKey", "date", "name");

-- CreateIndex
CREATE INDEX "AttendancePunch_businessId_employeeId_punchAt_idx" ON "AttendancePunch"("businessId", "employeeId", "punchAt");

-- CreateIndex
CREATE INDEX "AttendancePunch_businessId_locationId_punchAt_idx" ON "AttendancePunch"("businessId", "locationId", "punchAt");

-- CreateIndex
CREATE INDEX "Attendance_businessId_date_status_idx" ON "Attendance"("businessId", "date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_businessId_employeeId_date_key" ON "Attendance"("businessId", "employeeId", "date");

-- CreateIndex
CREATE INDEX "Timesheet_businessId_status_idx" ON "Timesheet"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Timesheet_businessId_employeeId_periodStart_key" ON "Timesheet"("businessId", "employeeId", "periodStart");

-- CreateIndex
CREATE INDEX "TimesheetEntry_businessId_timesheetId_date_idx" ON "TimesheetEntry"("businessId", "timesheetId", "date");

-- CreateIndex
CREATE INDEX "ExpenseCategory_businessId_isActive_idx" ON "ExpenseCategory"("businessId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_businessId_code_key" ON "ExpenseCategory"("businessId", "code");

-- CreateIndex
CREATE INDEX "ExpensePolicy_businessId_categoryId_idx" ON "ExpensePolicy"("businessId", "categoryId");

-- CreateIndex
CREATE INDEX "ExpenseClaim_businessId_employeeId_idx" ON "ExpenseClaim"("businessId", "employeeId");

-- CreateIndex
CREATE INDEX "ExpenseClaim_businessId_status_idx" ON "ExpenseClaim"("businessId", "status");

-- CreateIndex
CREATE INDEX "ExpenseClaim_businessId_categoryId_idx" ON "ExpenseClaim"("businessId", "categoryId");

-- CreateIndex
CREATE INDEX "ExpenseClaimLine_businessId_claimId_idx" ON "ExpenseClaimLine"("businessId", "claimId");

-- CreateIndex
CREATE INDEX "LoanScheme_businessId_isActive_idx" ON "LoanScheme"("businessId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "LoanScheme_businessId_code_key" ON "LoanScheme"("businessId", "code");

-- CreateIndex
CREATE INDEX "Loan_businessId_employeeId_idx" ON "Loan"("businessId", "employeeId");

-- CreateIndex
CREATE INDEX "Loan_businessId_status_idx" ON "Loan"("businessId", "status");

-- CreateIndex
CREATE INDEX "Loan_businessId_schemeId_idx" ON "Loan"("businessId", "schemeId");

-- CreateIndex
CREATE INDEX "LoanInstallment_businessId_loanId_idx" ON "LoanInstallment"("businessId", "loanId");

-- CreateIndex
CREATE INDEX "LoanInstallment_businessId_status_idx" ON "LoanInstallment"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LoanInstallment_loanId_seq_key" ON "LoanInstallment"("loanId", "seq");

-- CreateIndex
CREATE INDEX "SeparationCase_businessId_status_idx" ON "SeparationCase"("businessId", "status");

-- CreateIndex
CREATE INDEX "SeparationCase_businessId_entityId_lastWorkingDay_idx" ON "SeparationCase"("businessId", "entityId", "lastWorkingDay");

-- CreateIndex
CREATE UNIQUE INDEX "SeparationCase_businessId_code_key" ON "SeparationCase"("businessId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "SeparationCase_businessId_employeeId_initiatedAt_key" ON "SeparationCase"("businessId", "employeeId", "initiatedAt");

-- CreateIndex
CREATE INDEX "EmployeeDocument_businessId_employeeId_category_idx" ON "EmployeeDocument"("businessId", "employeeId", "category");

-- CreateIndex
CREATE INDEX "EmployeeDocument_businessId_expiresAt_idx" ON "EmployeeDocument"("businessId", "expiresAt");

-- CreateIndex
CREATE INDEX "DocumentTemplate_businessId_kind_isActive_idx" ON "DocumentTemplate"("businessId", "kind", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTemplate_businessId_code_key" ON "DocumentTemplate"("businessId", "code");

-- CreateIndex
CREATE INDEX "ProfileChangeRequest_businessId_employeeId_status_idx" ON "ProfileChangeRequest"("businessId", "employeeId", "status");

-- CreateIndex
CREATE INDEX "DocumentRequest_businessId_employeeId_status_idx" ON "DocumentRequest"("businessId", "employeeId", "status");

-- CreateIndex
CREATE INDEX "AttendanceRegularizationRequest_businessId_employeeId_date_idx" ON "AttendanceRegularizationRequest"("businessId", "employeeId", "date");

-- CreateIndex
CREATE INDEX "Asset_businessId_status_category_idx" ON "Asset"("businessId", "status", "category");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_businessId_code_key" ON "Asset"("businessId", "code");

-- CreateIndex
CREATE INDEX "AssetAssignment_businessId_employeeId_status_idx" ON "AssetAssignment"("businessId", "employeeId", "status");

-- CreateIndex
CREATE INDEX "AssetAssignment_businessId_assetId_idx" ON "AssetAssignment"("businessId", "assetId");

-- CreateIndex
CREATE INDEX "ReviewCycle_businessId_status_idx" ON "ReviewCycle"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewCycle_businessId_code_key" ON "ReviewCycle"("businessId", "code");

-- CreateIndex
CREATE INDEX "PerformanceReview_businessId_reviewerId_status_idx" ON "PerformanceReview"("businessId", "reviewerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceReview_businessId_reviewCycleId_employeeId_key" ON "PerformanceReview"("businessId", "reviewCycleId", "employeeId");

-- CreateIndex
CREATE INDEX "Goal_businessId_employeeId_status_idx" ON "Goal"("businessId", "employeeId", "status");

-- CreateIndex
CREATE INDEX "EmployeeSkill_businessId_employeeId_idx" ON "EmployeeSkill"("businessId", "employeeId");

-- CreateIndex
CREATE INDEX "Job_businessId_status_idx" ON "Job"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Job_businessId_code_key" ON "Job"("businessId", "code");

-- CreateIndex
CREATE INDEX "JobStage_businessId_jobId_idx" ON "JobStage"("businessId", "jobId");

-- CreateIndex
CREATE UNIQUE INDEX "JobStage_businessId_jobId_sortOrder_key" ON "JobStage"("businessId", "jobId", "sortOrder");

-- CreateIndex
CREATE INDEX "Candidate_businessId_email_idx" ON "Candidate"("businessId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Candidate_businessId_email_key" ON "Candidate"("businessId", "email");

-- CreateIndex
CREATE INDEX "Application_businessId_status_idx" ON "Application"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Application_businessId_jobId_candidateId_key" ON "Application"("businessId", "jobId", "candidateId");

-- CreateIndex
CREATE INDEX "Interview_businessId_applicationId_idx" ON "Interview"("businessId", "applicationId");

-- CreateIndex
CREATE INDEX "Offer_businessId_applicationId_status_idx" ON "Offer"("businessId", "applicationId", "status");

-- CreateIndex
CREATE INDEX "HelpdeskCategory_businessId_isActive_idx" ON "HelpdeskCategory"("businessId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "HelpdeskCategory_businessId_name_key" ON "HelpdeskCategory"("businessId", "name");

-- CreateIndex
CREATE INDEX "HelpdeskTicket_businessId_status_priority_idx" ON "HelpdeskTicket"("businessId", "status", "priority");

-- CreateIndex
CREATE INDEX "HelpdeskTicket_businessId_assigneeId_status_idx" ON "HelpdeskTicket"("businessId", "assigneeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "HelpdeskTicket_businessId_code_key" ON "HelpdeskTicket"("businessId", "code");

-- CreateIndex
CREATE INDEX "HelpdeskMessage_businessId_ticketId_idx" ON "HelpdeskMessage"("businessId", "ticketId");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_businessId_module_isActive_idx" ON "WorkflowDefinition"("businessId", "module", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowDefinition_businessId_code_key" ON "WorkflowDefinition"("businessId", "code");

-- CreateIndex
CREATE INDEX "WorkflowStep_businessId_workflowDefinitionId_idx" ON "WorkflowStep"("businessId", "workflowDefinitionId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowStep_businessId_workflowDefinitionId_stepOrder_key" ON "WorkflowStep"("businessId", "workflowDefinitionId", "stepOrder");

-- CreateIndex
CREATE INDEX "ApprovalRequest_businessId_module_status_idx" ON "ApprovalRequest"("businessId", "module", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_businessId_entityType_entityId_idx" ON "ApprovalRequest"("businessId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "ApprovalAction_businessId_approvalRequestId_idx" ON "ApprovalAction"("businessId", "approvalRequestId");

-- CreateIndex
CREATE INDEX "Notification_businessId_recipientUserId_readAt_idx" ON "Notification"("businessId", "recipientUserId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_businessId_type_createdAt_idx" ON "Notification"("businessId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "NumberSequence_businessId_scope_idx" ON "NumberSequence"("businessId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "NumberSequence_businessId_entityId_scope_periodKey_key" ON "NumberSequence"("businessId", "entityId", "scope", "periodKey");

-- CreateIndex
CREATE INDEX "TenantBrand_businessId_entityId_isActive_idx" ON "TenantBrand"("businessId", "entityId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "TenantBrand_businessId_code_key" ON "TenantBrand"("businessId", "code");

-- CreateIndex
CREATE INDEX "HrRolePermissionGrant_businessId_idx" ON "HrRolePermissionGrant"("businessId");

-- CreateIndex
CREATE INDEX "HrRolePermissionGrant_businessId_roleId_idx" ON "HrRolePermissionGrant"("businessId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "HrRolePermissionGrant_roleId_permissionKey_entityId_key" ON "HrRolePermissionGrant"("roleId", "permissionKey", "entityId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_businessRoleId_fkey" FOREIGN KEY ("businessRoleId") REFERENCES "BusinessRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessPage" ADD CONSTRAINT "BusinessPage_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessSeoSettings" ADD CONSTRAINT "BusinessSeoSettings_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeoPageOverride" ADD CONSTRAINT "SeoPageOverride_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_storeBrandId_fkey" FOREIGN KEY ("storeBrandId") REFERENCES "StoreBrand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "ProductBrand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPrice" ADD CONSTRAINT "ProductPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wishlist" ADD CONSTRAINT "Wishlist_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wishlist" ADD CONSTRAINT "Wishlist_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_wishlistId_fkey" FOREIGN KEY ("wishlistId") REFERENCES "Wishlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_pickupLocationId_fkey" FOREIGN KEY ("pickupLocationId") REFERENCES "EcomPickupLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessIntegration" ADD CONSTRAINT "BusinessIntegration_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enquiry" ADD CONSTRAINT "Enquiry_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessHours" ADD CONSTRAINT "BusinessHours_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessHoliday" ADD CONSTRAINT "BusinessHoliday_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessHoliday" ADD CONSTRAINT "BusinessHoliday_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerIdentity" ADD CONSTRAINT "CustomerIdentity_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAddress" ADD CONSTRAINT "CustomerAddress_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessContent" ADD CONSTRAINT "BusinessContent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "PricingTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaddleWebhookEvent" ADD CONSTRAINT "PaddleWebhookEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaddleBillingSubscription" ADD CONSTRAINT "PaddleBillingSubscription_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPurchase" ADD CONSTRAINT "BillingPurchase_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessagingTopupGrant" ADD CONSTRAINT "MessagingTopupGrant_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessagingTopupGrant" ADD CONSTRAINT "MessagingTopupGrant_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "BillingPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "BillingPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdjustmentLedger" ADD CONSTRAINT "AdjustmentLedger_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdjustmentLedger" ADD CONSTRAINT "AdjustmentLedger_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "BillingPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_intakeFormId_fkey" FOREIGN KEY ("intakeFormId") REFERENCES "IntakeForm"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffSchedule" ADD CONSTRAINT "StaffSchedule_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffSchedule" ADD CONSTRAINT "StaffSchedule_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waitlist" ADD CONSTRAINT "Waitlist_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waitlist" ADD CONSTRAINT "Waitlist_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waitlist" ADD CONSTRAINT "Waitlist_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waitlist" ADD CONSTRAINT "Waitlist_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Specialty" ADD CONSTRAINT "Specialty_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentReminder" ADD CONSTRAINT "AppointmentReminder_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentPrescription" ADD CONSTRAINT "AppointmentPrescription_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentPrescription" ADD CONSTRAINT "AppointmentPrescription_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentPrescription" ADD CONSTRAINT "AppointmentPrescription_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentInvoice" ADD CONSTRAINT "AppointmentInvoice_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentDocument" ADD CONSTRAINT "AppointmentDocument_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentDocument" ADD CONSTRAINT "AppointmentDocument_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentDocument" ADD CONSTRAINT "AppointmentDocument_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffLeave" ADD CONSTRAINT "StaffLeave_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffLeave" ADD CONSTRAINT "StaffLeave_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxNotification" ADD CONSTRAINT "InboxNotification_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxNotification" ADD CONSTRAINT "InboxNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxNotification" ADD CONSTRAINT "InboxNotification_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxNotification" ADD CONSTRAINT "InboxNotification_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportConversation" ADD CONSTRAINT "SupportConversation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportConversation" ADD CONSTRAINT "SupportConversation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SupportConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminCouponRedemption" ADD CONSTRAINT "AdminCouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "AdminCoupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CountryZoneAssignment" ADD CONSTRAINT "CountryZoneAssignment_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "PricingZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TierPrice" ADD CONSTRAINT "TierPrice_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "PricingTier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TierFeature" ADD CONSTRAINT "TierFeature_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "PricingTier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationConfig" ADD CONSTRAINT "NotificationConfig_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetUsage" ADD CONSTRAINT "BudgetUsage_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationCampaign" ADD CONSTRAINT "AutomationCampaign_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationEnrollment" ADD CONSTRAINT "AutomationEnrollment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationEnrollment" ADD CONSTRAINT "AutomationEnrollment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AutomationCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationEnrollment" ADD CONSTRAINT "AutomationEnrollment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMarketingOptOut" ADD CONSTRAINT "CustomerMarketingOptOut_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMarketingOptOut" ADD CONSTRAINT "CustomerMarketingOptOut_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeForm" ADD CONSTRAINT "IntakeForm_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlogPost" ADD CONSTRAINT "BlogPost_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlogPost" ADD CONSTRAINT "BlogPost_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "BlogCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlogCategory" ADD CONSTRAINT "BlogCategory_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlogComment" ADD CONSTRAINT "BlogComment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlogComment" ADD CONSTRAINT "BlogComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "BlogPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlogComment" ADD CONSTRAINT "BlogComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "BlogComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlogComment" ADD CONSTRAINT "BlogComment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlogLike" ADD CONSTRAINT "BlogLike_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlogLike" ADD CONSTRAINT "BlogLike_postId_fkey" FOREIGN KEY ("postId") REFERENCES "BlogPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlogLike" ADD CONSTRAINT "BlogLike_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlogSettings" ADD CONSTRAINT "BlogSettings_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosIntegration" ADD CONSTRAINT "PosIntegration_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreBrand" ADD CONSTRAINT "StoreBrand_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessPaymentAccount" ADD CONSTRAINT "BusinessPaymentAccount_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessRole" ADD CONSTRAINT "BusinessRole_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessLocation" ADD CONSTRAINT "BusinessLocation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantSettings" ADD CONSTRAINT "RestaurantSettings_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantDiningArea" ADD CONSTRAINT "RestaurantDiningArea_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantDiningArea" ADD CONSTRAINT "RestaurantDiningArea_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantTable" ADD CONSTRAINT "RestaurantTable_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantTable" ADD CONSTRAINT "RestaurantTable_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "RestaurantDiningArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantServicePeriod" ADD CONSTRAINT "RestaurantServicePeriod_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantServicePeriod" ADD CONSTRAINT "RestaurantServicePeriod_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantServicePeriod" ADD CONSTRAINT "RestaurantServicePeriod_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "RestaurantDiningArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantReservation" ADD CONSTRAINT "RestaurantReservation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantReservation" ADD CONSTRAINT "RestaurantReservation_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantReservation" ADD CONSTRAINT "RestaurantReservation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantReservationTable" ADD CONSTRAINT "RestaurantReservationTable_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "RestaurantReservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantReservationTable" ADD CONSTRAINT "RestaurantReservationTable_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "RestaurantTable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LawFirmIntake" ADD CONSTRAINT "LawFirmIntake_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LawFirmIntake" ADD CONSTRAINT "LawFirmIntake_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerTag" ADD CONSTRAINT "CustomerTag_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerTagAssignment" ADD CONSTRAINT "CustomerTagAssignment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerTagAssignment" ADD CONSTRAINT "CustomerTagAssignment_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "CustomerTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerSegment" ADD CONSTRAINT "CustomerSegment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeSubmission" ADD CONSTRAINT "IntakeSubmission_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeSubmission" ADD CONSTRAINT "IntakeSubmission_formId_fkey" FOREIGN KEY ("formId") REFERENCES "IntakeForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomRolePermissionGrant" ADD CONSTRAINT "EcomRolePermissionGrant_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomRolePermissionGrant" ADD CONSTRAINT "EcomRolePermissionGrant_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "BusinessRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomRolePermissionGrant" ADD CONSTRAINT "EcomRolePermissionGrant_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "EcomPermission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomRolePermissionGrant" ADD CONSTRAINT "EcomRolePermissionGrant_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryStock" ADD CONSTRAINT "InventoryStock_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryStock" ADD CONSTRAINT "InventoryStock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryStock" ADD CONSTRAINT "InventoryStock_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryAdjustment" ADD CONSTRAINT "InventoryAdjustment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryAdjustment" ADD CONSTRAINT "InventoryAdjustment_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "InventoryStock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductLocationOverride" ADD CONSTRAINT "ProductLocationOverride_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductLocationOverride" ADD CONSTRAINT "ProductLocationOverride_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductLocationOverride" ADD CONSTRAINT "ProductLocationOverride_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomRider" ADD CONSTRAINT "EcomRider_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomRider" ADD CONSTRAINT "EcomRider_homeLocationId_fkey" FOREIGN KEY ("homeLocationId") REFERENCES "BusinessLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomRiderShift" ADD CONSTRAINT "EcomRiderShift_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomRiderShift" ADD CONSTRAINT "EcomRiderShift_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "EcomRider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomRiderShift" ADD CONSTRAINT "EcomRiderShift_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryRequest" ADD CONSTRAINT "EcomDeliveryRequest_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryRequest" ADD CONSTRAINT "EcomDeliveryRequest_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryRequest" ADD CONSTRAINT "EcomDeliveryRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryRequest" ADD CONSTRAINT "EcomDeliveryRequest_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "EcomRider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryRequestEvent" ADD CONSTRAINT "EcomDeliveryRequestEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryRequestEvent" ADD CONSTRAINT "EcomDeliveryRequestEvent_deliveryRequestId_fkey" FOREIGN KEY ("deliveryRequestId") REFERENCES "EcomDeliveryRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryRoute" ADD CONSTRAINT "EcomDeliveryRoute_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryRoute" ADD CONSTRAINT "EcomDeliveryRoute_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryRoute" ADD CONSTRAINT "EcomDeliveryRoute_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "EcomRider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryRouteStop" ADD CONSTRAINT "EcomDeliveryRouteStop_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "EcomDeliveryRoute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryRouteStop" ADD CONSTRAINT "EcomDeliveryRouteStop_deliveryRequestId_fkey" FOREIGN KEY ("deliveryRequestId") REFERENCES "EcomDeliveryRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryLocationPing" ADD CONSTRAINT "EcomDeliveryLocationPing_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryLocationPing" ADD CONSTRAINT "EcomDeliveryLocationPing_deliveryRequestId_fkey" FOREIGN KEY ("deliveryRequestId") REFERENCES "EcomDeliveryRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryLocationPing" ADD CONSTRAINT "EcomDeliveryLocationPing_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "EcomRider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryLocationPing" ADD CONSTRAINT "EcomDeliveryLocationPing_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "EcomDeliveryRoute"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryLocationPing" ADD CONSTRAINT "EcomDeliveryLocationPing_routeStopId_fkey" FOREIGN KEY ("routeStopId") REFERENCES "EcomDeliveryRouteStop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryCashSettlement" ADD CONSTRAINT "EcomDeliveryCashSettlement_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryCashSettlement" ADD CONSTRAINT "EcomDeliveryCashSettlement_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "EcomRider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryCashSettlement" ADD CONSTRAINT "EcomDeliveryCashSettlement_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliverySlot" ADD CONSTRAINT "EcomDeliverySlot_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliverySlot" ADD CONSTRAINT "EcomDeliverySlot_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliverySlotBooking" ADD CONSTRAINT "EcomDeliverySlotBooking_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliverySlotBooking" ADD CONSTRAINT "EcomDeliverySlotBooking_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "EcomDeliverySlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomReturn" ADD CONSTRAINT "EcomReturn_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomReturnItem" ADD CONSTRAINT "EcomReturnItem_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "EcomReturn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomReturnEvent" ADD CONSTRAINT "EcomReturnEvent_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "EcomReturn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShoppingListItem" ADD CONSTRAINT "ShoppingListItem_listId_fkey" FOREIGN KEY ("listId") REFERENCES "CustomerShoppingList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeIngredient" ADD CONSTRAINT "RecipeIngredient_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "CustomerWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomReview" ADD CONSTRAINT "EcomReview_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomBanner" ADD CONSTRAINT "EcomBanner_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomCmsBlock" ADD CONSTRAINT "EcomCmsBlock_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomOrderEvent" ADD CONSTRAINT "EcomOrderEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomServiceCity" ADD CONSTRAINT "EcomServiceCity_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryZone" ADD CONSTRAINT "EcomDeliveryZone_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomDeliveryZone" ADD CONSTRAINT "EcomDeliveryZone_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "EcomServiceCity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomPickupLocation" ADD CONSTRAINT "EcomPickupLocation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomPickupLocation" ADD CONSTRAINT "EcomPickupLocation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "BusinessLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductBrandFamily" ADD CONSTRAINT "ProductBrandFamily_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductBrand" ADD CONSTRAINT "ProductBrand_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductBrand" ADD CONSTRAINT "ProductBrand_brandFamilyId_fkey" FOREIGN KEY ("brandFamilyId") REFERENCES "ProductBrandFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomSupplier" ADD CONSTRAINT "EcomSupplier_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomGoodsReceiptNote" ADD CONSTRAINT "EcomGoodsReceiptNote_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomGoodsReceiptNote" ADD CONSTRAINT "EcomGoodsReceiptNote_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "EcomSupplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomGoodsReceiptItem" ADD CONSTRAINT "EcomGoodsReceiptItem_grnId_fkey" FOREIGN KEY ("grnId") REFERENCES "EcomGoodsReceiptNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomInventoryTransfer" ADD CONSTRAINT "EcomInventoryTransfer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomInventoryTransferItem" ADD CONSTRAINT "EcomInventoryTransferItem_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "EcomInventoryTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomActivityEvent" ADD CONSTRAINT "EcomActivityEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomLoyaltyLedger" ADD CONSTRAINT "EcomLoyaltyLedger_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EcomLoyaltyLedger" ADD CONSTRAINT "EcomLoyaltyLedger_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redirect" ADD CONSTRAINT "Redirect_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorePolicy" ADD CONSTRAINT "StorePolicy_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Matter" ADD CONSTRAINT "Matter_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Matter" ADD CONSTRAINT "Matter_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Matter" ADD CONSTRAINT "Matter_responsibleLawyerId_fkey" FOREIGN KEY ("responsibleLawyerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Matter" ADD CONSTRAINT "Matter_originAppointmentId_fkey" FOREIGN KEY ("originAppointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatterInvoice" ADD CONSTRAINT "MatterInvoice_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "Matter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatterTimeEntry" ADD CONSTRAINT "MatterTimeEntry_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "Matter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatterDisbursement" ADD CONSTRAINT "MatterDisbursement_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "Matter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrustTransaction" ADD CONSTRAINT "TrustTransaction_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrustTransaction" ADD CONSTRAINT "TrustTransaction_matterId_fkey" FOREIGN KEY ("matterId") REFERENCES "Matter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstalledUnit" ADD CONSTRAINT "InstalledUnit_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstalledUnit" ADD CONSTRAINT "InstalledUnit_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstalledUnit" ADD CONSTRAINT "InstalledUnit_originAppointmentId_fkey" FOREIGN KEY ("originAppointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcContract" ADD CONSTRAINT "AmcContract_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcContract" ADD CONSTRAINT "AmcContract_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcContract" ADD CONSTRAINT "AmcContract_installedUnitId_fkey" FOREIGN KEY ("installedUnitId") REFERENCES "InstalledUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcContract" ADD CONSTRAINT "AmcContract_responsibleTechnicianId_fkey" FOREIGN KEY ("responsibleTechnicianId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcContract" ADD CONSTRAINT "AmcContract_originAppointmentId_fkey" FOREIGN KEY ("originAppointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceVisit" ADD CONSTRAINT "ServiceVisit_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceVisit" ADD CONSTRAINT "ServiceVisit_amcContractId_fkey" FOREIGN KEY ("amcContractId") REFERENCES "AmcContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceVisit" ADD CONSTRAINT "ServiceVisit_installedUnitId_fkey" FOREIGN KEY ("installedUnitId") REFERENCES "InstalledUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceVisit" ADD CONSTRAINT "ServiceVisit_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceVisit" ADD CONSTRAINT "ServiceVisit_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcInvoice" ADD CONSTRAINT "AmcInvoice_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcInvoice" ADD CONSTRAINT "AmcInvoice_amcContractId_fkey" FOREIGN KEY ("amcContractId") REFERENCES "AmcContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QaProjectVertical" ADD CONSTRAINT "QaProjectVertical_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "QaProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QaProjectMember" ADD CONSTRAINT "QaProjectMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "QaUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QaProjectMember" ADD CONSTRAINT "QaProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "QaProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QaIssue" ADD CONSTRAINT "QaIssue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "QaProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QaIssue" ADD CONSTRAINT "QaIssue_verticalId_fkey" FOREIGN KEY ("verticalId") REFERENCES "QaProjectVertical"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QaIssue" ADD CONSTRAINT "QaIssue_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "QaUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QaIssueComment" ADD CONSTRAINT "QaIssueComment_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "QaIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QaIssueComment" ADD CONSTRAINT "QaIssueComment_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "QaUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Designation" ADD CONSTRAINT "Designation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Designation" ADD CONSTRAINT "Designation_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "Grade"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grade" ADD CONSTRAINT "Grade_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grade" ADD CONSTRAINT "Grade_bandId_fkey" FOREIGN KEY ("bandId") REFERENCES "Band"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Band" ADD CONSTRAINT "Band_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_managerEmployeeId_fkey" FOREIGN KEY ("managerEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmploymentRecord" ADD CONSTRAINT "EmploymentRecord_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmploymentRecord" ADD CONSTRAINT "EmploymentRecord_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmploymentRecord" ADD CONSTRAINT "EmploymentRecord_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmploymentRecord" ADD CONSTRAINT "EmploymentRecord_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmploymentRecord" ADD CONSTRAINT "EmploymentRecord_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmploymentRecord" ADD CONSTRAINT "EmploymentRecord_designationId_fkey" FOREIGN KEY ("designationId") REFERENCES "Designation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyContact" ADD CONSTRAINT "EmergencyContact_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyContact" ADD CONSTRAINT "EmergencyContact_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dependant" ADD CONSTRAINT "Dependant_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dependant" ADD CONSTRAINT "Dependant_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryComponent" ADD CONSTRAINT "SalaryComponent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryStructure" ADD CONSTRAINT "SalaryStructure_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryComponentLine" ADD CONSTRAINT "SalaryComponentLine_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryComponentLine" ADD CONSTRAINT "SalaryComponentLine_structureId_fkey" FOREIGN KEY ("structureId") REFERENCES "SalaryStructure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryComponentLine" ADD CONSTRAINT "SalaryComponentLine_compensationId_fkey" FOREIGN KEY ("compensationId") REFERENCES "CompensationRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryComponentLine" ADD CONSTRAINT "SalaryComponentLine_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "SalaryComponent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompensationRevision" ADD CONSTRAINT "CompensationRevision_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompensationRevision" ADD CONSTRAINT "CompensationRevision_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompensationRevision" ADD CONSTRAINT "CompensationRevision_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatutoryProfile" ADD CONSTRAINT "StatutoryProfile_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatutoryProfile" ADD CONSTRAINT "StatutoryProfile_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatutoryElectionHistory" ADD CONSTRAINT "StatutoryElectionHistory_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatutoryElectionHistory" ADD CONSTRAINT "StatutoryElectionHistory_statutoryProfileId_fkey" FOREIGN KEY ("statutoryProfileId") REFERENCES "StatutoryProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatutoryRegistration" ADD CONSTRAINT "StatutoryRegistration_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatutoryRegistration" ADD CONSTRAINT "StatutoryRegistration_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayCalendar" ADD CONSTRAINT "PayCalendar_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayCalendar" ADD CONSTRAINT "PayCalendar_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRun" ADD CONSTRAINT "PayRun_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRun" ADD CONSTRAINT "PayRun_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRun" ADD CONSTRAINT "PayRun_payCalendarId_fkey" FOREIGN KEY ("payCalendarId") REFERENCES "PayCalendar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePayInput" ADD CONSTRAINT "AttendancePayInput_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePayInput" ADD CONSTRAINT "AttendancePayInput_payRunId_fkey" FOREIGN KEY ("payRunId") REFERENCES "PayRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePayInput" ADD CONSTRAINT "AttendancePayInput_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRunLine" ADD CONSTRAINT "PayRunLine_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRunLine" ADD CONSTRAINT "PayRunLine_payRunId_fkey" FOREIGN KEY ("payRunId") REFERENCES "PayRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRunLine" ADD CONSTRAINT "PayRunLine_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRunLineComponent" ADD CONSTRAINT "PayRunLineComponent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayRunLineComponent" ADD CONSTRAINT "PayRunLineComponent_payRunLineId_fkey" FOREIGN KEY ("payRunLineId") REFERENCES "PayRunLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_payRunId_fkey" FOREIGN KEY ("payRunId") REFERENCES "PayRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_payRunLineId_fkey" FOREIGN KEY ("payRunLineId") REFERENCES "PayRunLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatutoryRemittance" ADD CONSTRAINT "StatutoryRemittance_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatutoryRemittance" ADD CONSTRAINT "StatutoryRemittance_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatutoryRemittance" ADD CONSTRAINT "StatutoryRemittance_payRunId_fkey" FOREIGN KEY ("payRunId") REFERENCES "PayRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveType" ADD CONSTRAINT "LeaveType_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccrualRule" ADD CONSTRAINT "AccrualRule_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccrualRule" ADD CONSTRAINT "AccrualRule_leavePolicyId_fkey" FOREIGN KEY ("leavePolicyId") REFERENCES "LeavePolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeavePolicyAssignment" ADD CONSTRAINT "LeavePolicyAssignment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeavePolicyAssignment" ADD CONSTRAINT "LeavePolicyAssignment_leavePolicyId_fkey" FOREIGN KEY ("leavePolicyId") REFERENCES "LeavePolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveBalance" ADD CONSTRAINT "LeaveBalance_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveBalance" ADD CONSTRAINT "LeaveBalance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveBalance" ADD CONSTRAINT "LeaveBalance_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveTransaction" ADD CONSTRAINT "LeaveTransaction_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveTransaction" ADD CONSTRAINT "LeaveTransaction_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveTransaction" ADD CONSTRAINT "LeaveTransaction_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftPattern" ADD CONSTRAINT "ShiftPattern_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_shiftPatternId_fkey" FOREIGN KEY ("shiftPatternId") REFERENCES "ShiftPattern"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Holiday" ADD CONSTRAINT "Holiday_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunch" ADD CONSTRAINT "AttendancePunch_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunch" ADD CONSTRAINT "AttendancePunch_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Timesheet" ADD CONSTRAINT "Timesheet_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Timesheet" ADD CONSTRAINT "Timesheet_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetEntry" ADD CONSTRAINT "TimesheetEntry_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetEntry" ADD CONSTRAINT "TimesheetEntry_timesheetId_fkey" FOREIGN KEY ("timesheetId") REFERENCES "Timesheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseCategory" ADD CONSTRAINT "ExpenseCategory_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpensePolicy" ADD CONSTRAINT "ExpensePolicy_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpensePolicy" ADD CONSTRAINT "ExpensePolicy_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseClaimLine" ADD CONSTRAINT "ExpenseClaimLine_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseClaimLine" ADD CONSTRAINT "ExpenseClaimLine_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ExpenseClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanScheme" ADD CONSTRAINT "LoanScheme_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "LoanScheme"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanInstallment" ADD CONSTRAINT "LoanInstallment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanInstallment" ADD CONSTRAINT "LoanInstallment_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeparationCase" ADD CONSTRAINT "SeparationCase_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeparationCase" ADD CONSTRAINT "SeparationCase_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTemplate" ADD CONSTRAINT "DocumentTemplate_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileChangeRequest" ADD CONSTRAINT "ProfileChangeRequest_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileChangeRequest" ADD CONSTRAINT "ProfileChangeRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRequest" ADD CONSTRAINT "DocumentRequest_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRequest" ADD CONSTRAINT "DocumentRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRegularizationRequest" ADD CONSTRAINT "AttendanceRegularizationRequest_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRegularizationRequest" ADD CONSTRAINT "AttendanceRegularizationRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignment" ADD CONSTRAINT "AssetAssignment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignment" ADD CONSTRAINT "AssetAssignment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignment" ADD CONSTRAINT "AssetAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewCycle" ADD CONSTRAINT "ReviewCycle_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReview" ADD CONSTRAINT "PerformanceReview_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReview" ADD CONSTRAINT "PerformanceReview_reviewCycleId_fkey" FOREIGN KEY ("reviewCycleId") REFERENCES "ReviewCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReview" ADD CONSTRAINT "PerformanceReview_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReview" ADD CONSTRAINT "PerformanceReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSkill" ADD CONSTRAINT "EmployeeSkill_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSkill" ADD CONSTRAINT "EmployeeSkill_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobStage" ADD CONSTRAINT "JobStage_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobStage" ADD CONSTRAINT "JobStage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpdeskCategory" ADD CONSTRAINT "HelpdeskCategory_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpdeskTicket" ADD CONSTRAINT "HelpdeskTicket_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpdeskTicket" ADD CONSTRAINT "HelpdeskTicket_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpdeskMessage" ADD CONSTRAINT "HelpdeskMessage_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpdeskMessage" ADD CONSTRAINT "HelpdeskMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "HelpdeskTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowDefinition" ADD CONSTRAINT "WorkflowDefinition_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStep" ADD CONSTRAINT "WorkflowStep_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStep" ADD CONSTRAINT "WorkflowStep_workflowDefinitionId_fkey" FOREIGN KEY ("workflowDefinitionId") REFERENCES "WorkflowDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_requesterEmployeeId_fkey" FOREIGN KEY ("requesterEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalAction" ADD CONSTRAINT "ApprovalAction_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalAction" ADD CONSTRAINT "ApprovalAction_approvalRequestId_fkey" FOREIGN KEY ("approvalRequestId") REFERENCES "ApprovalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NumberSequence" ADD CONSTRAINT "NumberSequence_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantBrand" ADD CONSTRAINT "TenantBrand_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrRolePermissionGrant" ADD CONSTRAINT "HrRolePermissionGrant_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrRolePermissionGrant" ADD CONSTRAINT "HrRolePermissionGrant_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "BusinessRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

