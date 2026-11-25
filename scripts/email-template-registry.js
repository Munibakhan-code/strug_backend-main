/**
 * Canonical registry of branded Handlebars email templates (excludes layout.hbs).
 * Phase 3 Mail Organization: vertical / owner / audience / priority are SSOT for catalog.
 * Used by smoke-all-emails, guard-email-registry, and GET /admin/mail/catalog.
 *
 * audience: 'user' | 'ops'
 * priority: 'critical' | 'high' | 'normal' | 'low'
 */
export const EMAIL_TEMPLATE_REGISTRY = [
  { template: 'welcome', subjectKey: 'emails.subjects.welcome', trigger: 'auth-routes/user-auth-route.js — register', vertical: 'auth', owner: 'platform', audience: 'user', priority: 'high' },
  { template: 'otp', subjectKey: 'emails.subjects.otp', trigger: 'auth — OTP send', vertical: 'auth', owner: 'platform', audience: 'user', priority: 'critical' },
  { template: 'password-reset', subjectKey: 'emails.subjects.password_reset', trigger: 'auth — password-reset-request', vertical: 'auth', owner: 'platform', audience: 'user', priority: 'critical' },
  { template: 'login-alert', subjectKey: 'emails.subjects.login_alert', trigger: 'auth — login', vertical: 'auth', owner: 'platform', audience: 'user', priority: 'high' },
  { template: 'password-change-success', subjectKey: 'emails.password_changed.subject', trigger: 'auth — reset/change password', vertical: 'auth', owner: 'platform', audience: 'user', priority: 'high' },
  { template: 'shop-order-receipt', subjectKey: 'emails.shop.subjects.order_confirm_buyer', trigger: 'product-order-email.js', vertical: 'shop', owner: 'commerce', audience: 'user', priority: 'high' },
  { template: 'shop-order-status', subjectKey: 'emails.shop.status.subjects.confirmed', trigger: 'product-order-email.js — status', vertical: 'shop', owner: 'commerce', audience: 'user', priority: 'normal' },
  { template: 'digital-delivery', subjectKey: 'emails.digital.subject', trigger: 'product-order-email.js — digital', vertical: 'shop', owner: 'commerce', audience: 'user', priority: 'high' },
  { template: 'food-order-receipt', subjectKey: 'emails.food.subjects.order_confirm_buyer', trigger: 'food-routes — order confirm', vertical: 'food', owner: 'commerce', audience: 'user', priority: 'high' },
  { template: 'food-order-status', subjectKey: 'emails.food_status.subjects.preparing', trigger: 'food-routes — status update', vertical: 'food', owner: 'commerce', audience: 'user', priority: 'normal' },
  { template: 'ride-receipt', subjectKey: 'emails.subjects.ride_receipt', trigger: 'active_trip-routes — trip complete', vertical: 'rides', owner: 'mobility', audience: 'user', priority: 'high' },
  { template: 'ride-status', subjectKey: 'emails.ride_status.subjects.assigned', trigger: 'ride-request accept + active_trip arrived', vertical: 'rides', owner: 'mobility', audience: 'user', priority: 'high' },
  { template: 'ghost-driver', subjectKey: 'emails.ghost_driver.subject', trigger: 'cron-jobs — ghost driver', vertical: 'rides', owner: 'mobility', audience: 'user', priority: 'normal' },
  { template: 'carpool-booking', subjectKey: 'emails.carpool_booking.subject', trigger: 'carpool_booking-routes', vertical: 'rides', owner: 'mobility', audience: 'user', priority: 'normal' },
  { template: 'service-appointment', subjectKey: 'emails.services.subjects.confirmed_customer', trigger: 'appointments-routes, service-order-email, cron', vertical: 'services', owner: 'services', audience: 'user', priority: 'high' },
  { template: 'rental-expiry', subjectKey: 'emails.services.subjects.rental_expiry', trigger: 'cron-jobs — rental expiry', vertical: 'services', owner: 'services', audience: 'user', priority: 'normal' },
  { template: 'ads-low-balance', subjectKey: 'emails.ads.low_balance_subject', trigger: 'ads-wallet-routes, ads-delivery-engine', vertical: 'ads', owner: 'ads', audience: 'user', priority: 'normal' },
  { template: 'ads-spend-alert', subjectKey: 'emails.ads.spend_alert_subject', trigger: 'ads-wallet-routes', vertical: 'ads', owner: 'ads', audience: 'user', priority: 'normal' },
  { template: 'shift-update', subjectKey: 'emails.shift_update.subject', trigger: 'shift-routes', vertical: 'jobs', owner: 'hr', audience: 'user', priority: 'normal' },
  { template: 'leave-status', subjectKey: 'emails.leave_status.subject_approved', trigger: 'leave-routes', vertical: 'jobs', owner: 'hr', audience: 'user', priority: 'normal' },
  { template: 'payslip', subjectKey: 'emails.payroll.subject', trigger: 'payrolls-routes', vertical: 'jobs', owner: 'hr', audience: 'user', priority: 'high' },
  { template: 'job-application-alert', subjectKey: 'emails.job_alert.subject', trigger: 'job-routes', vertical: 'jobs', owner: 'jobs', audience: 'user', priority: 'high' },
  { template: 'job-application-status', subjectKey: 'emails.job_status.subject', trigger: 'job-routes — application status', vertical: 'jobs', owner: 'jobs', audience: 'user', priority: 'normal' },
  { template: 'job-saved-search', subjectKey: 'emails.job_saved_search.subject', trigger: 'job-saved-search-cron (JOB_SAVED_SEARCH_EMAIL)', vertical: 'jobs', owner: 'jobs', audience: 'user', priority: 'low' },
  { template: 'fintech-mail', subjectKey: 'emails.fintech.subjects.donation', trigger: 'donation-routes — donor receipt', vertical: 'donations', owner: 'community', audience: 'user', priority: 'normal' },
  { template: 'community-mail', subjectKey: 'emails.community.donation_subject', trigger: 'donation-routes — owner notify', vertical: 'donations', owner: 'community', audience: 'user', priority: 'normal' },
  { template: 'event-invite', subjectKey: 'emails.event_invite.subject', trigger: 'event-concierge-routes — send-invite', vertical: 'events', owner: 'events', audience: 'user', priority: 'high' },
  { template: 'board-invite', subjectKey: 'emails.board_invite.subject', trigger: 'board-members-routes — create member', vertical: 'board', owner: 'platform', audience: 'ops', priority: 'high' },
  { template: 'property-saved-search', subjectKey: 'emails.property_saved_search.subject', trigger: 'property-saved-search-cron (PROPERTY_SAVED_SEARCH_EMAIL)', vertical: 'property', owner: 'property', audience: 'user', priority: 'low' },
  { template: 'dating-match', subjectKey: 'emails.dating_match.subject', trigger: 'dating-routes — mutual match', vertical: 'dating', owner: 'dating', audience: 'user', priority: 'high' },
  { template: 'dating-worth-it-invite', subjectKey: 'emails.dating_worth_it_invite.subject', trigger: 'dating-routes — worth-it invite', vertical: 'dating', owner: 'dating', audience: 'user', priority: 'high' },
  { template: 'medical-booking-confirmed', subjectKey: 'emails.medical_booking_confirmed.subject', trigger: 'booking-engine — medical confirmed', vertical: 'medical', owner: 'medical', audience: 'user', priority: 'high' },
  { template: 'medical-booking-request', subjectKey: 'emails.medical_booking_request.subject', trigger: 'booking-engine — medical host request', vertical: 'medical', owner: 'medical', audience: 'user', priority: 'high' },
  { template: 'venue-booking-confirmed', subjectKey: 'emails.venue_booking_confirmed.subject', trigger: 'booking-engine — venue confirmed', vertical: 'venues', owner: 'venues', audience: 'user', priority: 'high' },
  { template: 'venue-booking-request', subjectKey: 'emails.venue_booking_request.subject', trigger: 'booking-engine — venue host request', vertical: 'venues', owner: 'venues', audience: 'user', priority: 'high' },
  { template: 'social-new-follower', subjectKey: 'emails.social_new_follower.subject', trigger: 'social-follow — FOLLOW accepted', vertical: 'social', owner: 'social', audience: 'user', priority: 'low' },
];

/** Sample variables per template for render smoke tests. */
export function sampleVariablesForTemplate(template, t) {
  const base = { name: 'Smoke Test User', frontend_url: 'https://strug.ca' };
  const map = {
    welcome: { name: 'Smoke Test User' },
    otp: { otp: '123456' },
    'password-reset': { name: 'Smoke Test User', reset_url: 'https://app.strug.ca/reset-password?token=test' },
    'login-alert': { device: 'Chrome on Windows', time: new Date().toISOString() },
    'password-change-success': { name: 'Smoke Test User', secure_url: 'https://strug.ca/account' },
    'shop-order-receipt': { order_id: 1001, product_name: 'Test Product', qty: 1, total: '29.99', currency: '$', isVendor: false },
    'shop-order-status': { order_id: 1001, status_title: 'Confirmed', status_message: 'Your order is confirmed.', track_url: 'https://strug.ca/shop' },
    'digital-delivery': { download_url: 'https://strug.ca/shop?order=1001' },
    'food-order-receipt': {
      order_id: 2001, isVendor: false, currency: 'CAD', subtotal: '20.00', delivery_fee: '3.00',
      gov_tax: '1.00', platform_fee: '1.00', total_amount: '25.00', delivery_location: '123 Test St',
      items: [{ name: 'Burger', qty: 1, price: '20.00' }],
    },
    'food-order-status': { order_id: 2001, status_title: 'Preparing', status_message: 'Your order is being prepared.' },
    'ride-receipt': {
      total_fare: '24.76', currency: 'CAD', distance: '8.40', driver_name: 'Test Driver',
      pickup_address: '55 York St, Toronto', drop_address: '2 Inwood Ave, East York',
      ride_id: '#96', trip_id: '#42', completed_at: 'Jun 19, 2026, 2:33 a.m.',
      vehicle_type: 'Economy', payment_method: 'Strug Wallet',
    },
    'ride-status': {
      status_title: 'Driver Assigned',
      status_message: 'A driver has accepted your ride and is heading to your pickup location.',
      ride_id_label: '#96',
      trip_id_label: '#42',
      driver_name: 'Test Driver',
      vehicle_type: 'Economy',
      plate_number: 'ABC 123',
      eta: '~5 min',
      pickup_address: '55 York St, Toronto',
      drop_address: '2 Inwood Ave, East York',
      track_url: 'https://strug.ca/ride',
    },
    'ghost-driver': { name: 'Smoke Test User' },
    'carpool-booking': {
      from_location: 'Toronto', to_location: 'Ottawa', seats: 2, total_cost: '40.00', currency: 'CAD', status: 'Confirmed',
    },
    'service-appointment': {
      title: t('emails.services.subjects.confirmed_customer'),
      message: t('emails.services.messages.confirmed'),
      service_name: 'Smoke Test Service',
      other_party_name: 'Strug Partner',
      date: '2026-06-02',
      time: '10:00 AM',
      isProvider: false,
    },
    'rental-expiry': { item_name: 'Smoke Test Rental', expire_date: '2026-06-03', rental_id: 1 },
    'ads-low-balance': { name: 'Smoke Test User', balance: '5.00', topup_url: 'https://strug.ca/ads' },
    'ads-spend-alert': { name: 'Smoke Test User', percentage: 80, campaign_id: 42, manage_url: 'https://strug.ca/ads' },
    'shift-update': { name: 'Smoke Test User', start_time: '09:00', end_time: '17:00' },
    'leave-status': {
      name: 'Smoke Test User', status: 'approved', from_date: '2026-06-10', to_date: '2026-06-12', rejection_reason: '',
    },
    payslip: {
      name: 'Smoke Test User', net_salary: '3500.00', epf: '100.00', etf: '50.00', ot: '0.00', bonus: '0.00', status: 'Paid',
    },
    'job-application-alert': {
      job_title: 'Software Engineer', applicant_name: 'Jane Doe', applicant_email: 'jane@example.com',
    },
    'job-application-status': {
      candidate_name: 'Jane Doe',
      job_title: 'Software Engineer',
      status: 'shortlisted',
      status_label: 'Shortlisted',
      is_rejected: false,
      is_hired: false,
    },
    'fintech-mail': {
      title: t('emails.fintech.donation.title'),
      message: t('emails.fintech.donation.msg'),
      amount: '$50.00',
      project_name: 'Test Campaign',
    },
    'community-mail': {
      title: t('emails.community.donation_title'),
      message: t('emails.community.donation_message', { amount: '$50', project: 'Test Campaign' }),
      button_text: t('emails.community.donation_button'),
      button_url: 'https://strug.ca/community',
    },
    'event-invite': {
      guest_name: 'Alex Guest',
      event_title: 'Smoke Test Gala',
      event_when: 'Sat, Jun 20, 2026',
      event_city: 'Toronto',
      invite_message: 'Looking forward to celebrating with you.',
      rsvp_url: 'https://app.strug.ca/invite/smoke-token',
    },
    'board-invite': {
      name: 'Smoke Staff',
      email: 'smoke@strug.ca',
      temp_password: 'TempPass123!',
      role_label: 'Member',
      board_url: 'https://strug.ca/board',
    },
    'property-saved-search': {
      name: 'Smoke Test User',
      headline: '2 new listings match your search',
      summary: 'Condo downtown and 1 more — Saved search',
      browse_url: 'https://app.strug.ca/realestate',
      matches: [
        { title: 'Condo downtown', detail: 'Toronto' },
        { title: 'Loft east', detail: 'East York' },
      ],
    },
    'job-saved-search': {
      name: 'Smoke Test User',
      headline: '2 new jobs match your search',
      summary: 'Backend Engineer and 1 more — Saved search',
      browse_url: 'https://app.strug.ca/jobs',
      matches: [
        { title: 'Backend Engineer', detail: 'Toronto' },
        { title: 'Platform Engineer', detail: 'Remote' },
      ],
    },
    'dating-match': {
      name: 'Alex',
      cta_url: 'https://app.strug.ca/dating',
    },
    'dating-worth-it-invite': {
      name: 'Alex',
      restaurant_name: 'Smoke Bistro',
      cta_url: 'https://app.strug.ca/dating',
    },
    'medical-booking-confirmed': {
      name: 'Alex',
      listing_title: 'Dr. Smoke',
      when_label: 'Mon 10:00 AM',
      booking_id: 1001,
      cta_url: 'https://app.strug.ca/medical',
    },
    'medical-booking-request': {
      name: 'Dr. Smoke',
      guest_name: 'Alex Patient',
      listing_title: 'Online consult',
      booking_id: 1002,
      cta_url: 'https://app.strug.ca/medical',
    },
    'venue-booking-confirmed': {
      name: 'Alex',
      listing_title: 'Smoke Hall',
      when_label: 'Sat 6:00 PM',
      booking_id: 2001,
      cta_url: 'https://app.strug.ca/venues',
    },
    'venue-booking-request': {
      name: 'Host',
      guest_name: 'Alex Guest',
      listing_title: 'Smoke Hall',
      booking_id: 2002,
      cta_url: 'https://app.strug.ca/venues',
    },
    'social-new-follower': {
      name: 'Alex',
      follower_name: 'Jordan',
      cta_url: 'https://app.strug.ca/',
    },
  };
  return { ...base, ...(map[template] || {}) };
}

export function logEmailTemplateInventory() {
  console.log('───────────────────────────────────────────────────────────');
  console.log(`[Email Templates] ${EMAIL_TEMPLATE_REGISTRY.length} branded templates registered`);
  for (const row of EMAIL_TEMPLATE_REGISTRY) {
    console.log(
      `  📧 ${row.template}.hbs [${row.vertical}/${row.audience}/${row.priority}] ← ${row.trigger}`,
    );
  }
  console.log('───────────────────────────────────────────────────────────');
}

/** Build markdown inventory table from the registry (docs sync). */
export function buildMailInventoryMarkdown(registry = EMAIL_TEMPLATE_REGISTRY) {
  const lines = [
    '# Mail template inventory',
    '',
    '_Generated from `EMAIL_TEMPLATE_REGISTRY`. Do not edit by hand; run `npm run email:inventory:md`._',
    '',
    `| Template | Vertical | Owner | Audience | Priority | Subject key | Trigger |`,
    `|---|---|---|---|---|---|---|`,
  ];
  for (const row of registry) {
    lines.push(
      `| \`${row.template}\` | ${row.vertical} | ${row.owner} | ${row.audience} | ${row.priority} | \`${row.subjectKey}\` | ${row.trigger.replace(/\|/g, '/')} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
