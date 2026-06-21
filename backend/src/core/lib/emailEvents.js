const EMAIL_EVENTS = {
  USER_SIGNUP_OTP: 'user_signup_otp',
  USER_WELCOME: 'user_welcome',
  USER_PASSWORD_RESET_OTP: 'user_password_reset_otp',
  CUSTOMER_SIGNUP_OTP: 'customer_signup_otp',
  CUSTOMER_PASSWORD_RESET_OTP: 'customer_password_reset_otp',
  STAFF_INVITE: 'staff_invite',
  RIDER_INVITE: 'rider_invite',
  BOOKING_CREATED_CUSTOMER: 'booking_created_customer',
  BOOKING_CREATED_STAFF: 'booking_created_staff',
  APPOINTMENT_CONFIRMED: 'appointment_confirmed',
  APPOINTMENT_CANCELLED: 'appointment_cancelled',
  APPOINTMENT_RESCHEDULED: 'appointment_rescheduled',
  APPOINTMENT_AUTO_CANCELLED: 'appointment_auto_cancelled',
  APPOINTMENT_NO_SHOW: 'appointment_no_show',
  APPOINTMENT_COMPLETED: 'appointment_completed',
  APPOINTMENT_REVIEW_REQUEST: 'appointment_review_request',
  PRESCRIPTION_READY: 'prescription_ready',
  CUSTOMER_WELCOME: 'customer_welcome',
  BOOKING_CREATED_ADMIN: 'booking_created_admin',
  ENQUIRY_RECEIVED_ADMIN: 'enquiry_received_admin',
  ENQUIRY_AUTO_REPLY_CUSTOMER: 'enquiry_auto_reply_customer',
  LEAVE_REQUEST_SUBMITTED_ADMIN: 'leave_request_submitted_admin',
  LEAVE_REQUEST_APPROVED_STAFF: 'leave_request_approved_staff',
  LEAVE_REQUEST_REJECTED_STAFF: 'leave_request_rejected_staff',
  BOOKING_REMINDER_24H: 'booking_reminder_24h',
  BOOKING_REMINDER_2H: 'booking_reminder_2h',
  STAFF_INVITE_REMINDER: 'staff_invite_reminder',
  TRIAL_EXPIRING: 'trial_expiring',
  SUBSCRIPTION_STARTED: 'subscription_started',
  PAYMENT_FAILED: 'payment_failed',
  SUBSCRIPTION_CANCELLED: 'subscription_cancelled',
  WAITLIST_SLOT_OPEN: 'waitlist_slot_open',
  ADMIN_BULK_MESSAGE: 'admin_bulk_message',
  // E-commerce (E2 Phase 2). ORDER_RECEIVED goes to the customer at
  // checkout; ORDER_RECEIVED_ADMIN notifies the seller so they can
  // start fulfillment without polling the admin panel.
  ORDER_RECEIVED: 'order_received',
  ORDER_RECEIVED_ADMIN: 'order_received_admin',
  // Per-status emails — fire automatically as the admin advances the
  // order through the fulfillment state machine.
  ORDER_PAID: 'order_paid',
  ORDER_OUT_FOR_DELIVERY: 'order_out_for_delivery',
  ORDER_DELIVERED: 'order_delivered',
  ORDER_DELIVERY_ATTEMPT_FAILED: 'order_delivery_attempt_failed',
  // Click & Collect — admin flips order to READY_FOR_PICKUP, customer
  // gets the location address + pickup code via this email.
  ORDER_READY_FOR_PICKUP: 'order_ready_for_pickup',
  // Grocery picking — an out-of-stock item was substituted and needs the
  // customer's approval. Links to the order page where they accept/decline.
  ORDER_SUBSTITUTION_PROPOSED: 'order_substitution_proposed',
  // Grocery picking — the order total changed during picking (weight, shorts,
  // substitutions). Sent once as it leaves picking; includes any refund.
  ORDER_ADJUSTED: 'order_adjusted',
  // Post-delivery review request — a delayed follow-up asking the buyer to
  // review (mirrors APPOINTMENT_REVIEW_REQUEST). Gated on Business
  // reviewRequestEnabled + reviewRequestLink; deduped per order.
  ORDER_REVIEW_REQUEST: 'order_review_request',
  // Sprint 3.2b polish — admin notification when a new blog comment
  // arrives. Honours BlogSettings.notifyAdminOnNewComment + only fires
  // for PENDING comments (auto-approved comments are routine; admin
  // doesn't need an inbox ping).
  BLOG_COMMENT_NEW_ADMIN: 'blog_comment_new_admin',
  // Reseller email — a Zoho business mailbox was provisioned; this delivers
  // the login credentials to the customer so they can sign in at Zoho.
  MAILBOX_PROVISIONED: 'mailbox_provisioned',
};

const EMAIL_EVENT_CATEGORIES = {
  [EMAIL_EVENTS.USER_SIGNUP_OTP]: 'auth',
  [EMAIL_EVENTS.USER_WELCOME]: 'lifecycle',
  [EMAIL_EVENTS.USER_PASSWORD_RESET_OTP]: 'security',
  [EMAIL_EVENTS.CUSTOMER_SIGNUP_OTP]: 'auth',
  [EMAIL_EVENTS.CUSTOMER_PASSWORD_RESET_OTP]: 'security',
  [EMAIL_EVENTS.STAFF_INVITE]: 'staff',
  [EMAIL_EVENTS.RIDER_INVITE]: 'staff',
  [EMAIL_EVENTS.BOOKING_CREATED_CUSTOMER]: 'booking',
  [EMAIL_EVENTS.BOOKING_CREATED_STAFF]: 'booking',
  [EMAIL_EVENTS.APPOINTMENT_CONFIRMED]: 'booking',
  [EMAIL_EVENTS.APPOINTMENT_CANCELLED]: 'booking',
  [EMAIL_EVENTS.APPOINTMENT_RESCHEDULED]: 'booking',
  [EMAIL_EVENTS.APPOINTMENT_AUTO_CANCELLED]: 'booking',
  [EMAIL_EVENTS.APPOINTMENT_NO_SHOW]: 'booking',
  [EMAIL_EVENTS.APPOINTMENT_COMPLETED]: 'booking',
  [EMAIL_EVENTS.APPOINTMENT_REVIEW_REQUEST]: 'booking',
  [EMAIL_EVENTS.PRESCRIPTION_READY]: 'booking',
  [EMAIL_EVENTS.CUSTOMER_WELCOME]: 'lifecycle',
  [EMAIL_EVENTS.BOOKING_CREATED_ADMIN]: 'booking',
  [EMAIL_EVENTS.ENQUIRY_RECEIVED_ADMIN]: 'notification',
  [EMAIL_EVENTS.ENQUIRY_AUTO_REPLY_CUSTOMER]: 'notification',
  [EMAIL_EVENTS.LEAVE_REQUEST_SUBMITTED_ADMIN]: 'staff',
  [EMAIL_EVENTS.LEAVE_REQUEST_APPROVED_STAFF]: 'staff',
  [EMAIL_EVENTS.LEAVE_REQUEST_REJECTED_STAFF]: 'staff',
  [EMAIL_EVENTS.BOOKING_REMINDER_24H]: 'booking',
  [EMAIL_EVENTS.BOOKING_REMINDER_2H]: 'booking',
  [EMAIL_EVENTS.STAFF_INVITE_REMINDER]: 'staff',
  [EMAIL_EVENTS.TRIAL_EXPIRING]: 'billing',
  [EMAIL_EVENTS.SUBSCRIPTION_STARTED]: 'billing',
  [EMAIL_EVENTS.PAYMENT_FAILED]: 'billing',
  [EMAIL_EVENTS.SUBSCRIPTION_CANCELLED]: 'billing',
  [EMAIL_EVENTS.WAITLIST_SLOT_OPEN]: 'booking',
  [EMAIL_EVENTS.ADMIN_BULK_MESSAGE]: 'notification',
  [EMAIL_EVENTS.ORDER_RECEIVED]: 'ecommerce',
  [EMAIL_EVENTS.ORDER_RECEIVED_ADMIN]: 'ecommerce',
  [EMAIL_EVENTS.ORDER_PAID]: 'ecommerce',
  [EMAIL_EVENTS.ORDER_OUT_FOR_DELIVERY]: 'ecommerce',
  [EMAIL_EVENTS.ORDER_DELIVERED]: 'ecommerce',
  [EMAIL_EVENTS.ORDER_DELIVERY_ATTEMPT_FAILED]: 'ecommerce',
  [EMAIL_EVENTS.ORDER_READY_FOR_PICKUP]: 'ecommerce',
  [EMAIL_EVENTS.ORDER_SUBSTITUTION_PROPOSED]: 'ecommerce',
  [EMAIL_EVENTS.ORDER_ADJUSTED]: 'ecommerce',
  [EMAIL_EVENTS.ORDER_REVIEW_REQUEST]: 'ecommerce',
  [EMAIL_EVENTS.BLOG_COMMENT_NEW_ADMIN]: 'notification',
};

function categoryForEmailEvent(eventKey) {
  return EMAIL_EVENT_CATEGORIES[eventKey] || 'transactional';
}

module.exports = {
  EMAIL_EVENTS,
  EMAIL_EVENT_CATEGORIES,
  categoryForEmailEvent,
};
