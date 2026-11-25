/**
 * Central registry of all Strug background schedules (node-cron + setInterval).
 * Step 1 (Target 4): inventory + gap analysis — single source of truth.
 *
 * Run: node -e "import('./utils/cron-inventory.js').then(m => m.logCronInventory())"
 */

/** @typedef {'node-cron' | 'setInterval'} CronDriver */
/** @typedef {'active' | 'overlap' | 'gap'} CronStatus */

/**
 * @type {Array<{
 *   id: string;
 *   file: string;
 *   driver: CronDriver;
 *   schedule: string;
 *   scheduleHuman: string;
 *   action: string;
 *   sendsEmail: boolean;
 *   emailTemplate?: string;
 *   userLng: boolean | 'via-user';
 *   init: string;
 *   status: CronStatus;
 *   notes?: string;
 * }>}
 */
export const CRON_INVENTORY = [
  // ── utils/cron-jobs.js (initGhostDriverCron) ──────────────────────────────
  {
    id: 'ghost-driver',
    file: 'utils/cron-jobs.js',
    driver: 'node-cron',
    schedule: '* * * * *',
    scheduleHuman: 'Every minute',
    action: 'Ghost driver: trip started >5 min with OTP, no end → reassign + notify passenger',
    sendsEmail: true,
    emailTemplate: 'ghost-driver',
    userLng: true,
    init: 'initGhostDriverCron(io)',
    status: 'active',
  },
  {
    id: 'story-cleanup',
    file: 'utils/cron-jobs.js',
    driver: 'node-cron',
    schedule: '*/30 * * * *',
    scheduleHuman: 'Every 30 minutes',
    action: 'Delete expired social stories (non-highlights)',
    sendsEmail: false,
    userLng: false,
    init: 'initGhostDriverCron(io)',
    status: 'active',
  },
  {
    id: 'pending-ride-timeout-legacy',
    file: 'utils/cron-jobs.js',
    driver: 'node-cron',
    schedule: '* * * * *',
    scheduleHuman: 'Every minute',
    action: 'Cancel ride_request pending >3 min (socket only)',
    sendsEmail: false,
    userLng: false,
    init: 'initGhostDriverCron(io)',
    status: 'overlap',
    notes: 'Overlaps ride-timeout-cron.js (which also refunds wallet). Consider consolidating.',
  },
  {
    id: 'service-order-timeout',
    file: 'utils/cron-jobs.js',
    driver: 'node-cron',
    schedule: '* * * * *',
    scheduleHuman: 'Every minute',
    action: 'Cancel service_order pending >3 min; email buyer',
    sendsEmail: true,
    emailTemplate: 'service-appointment',
    userLng: true,
    init: 'initGhostDriverCron(io)',
    status: 'active',
  },
  {
    id: 'courier-order-timeout',
    file: 'utils/cron-jobs.js',
    driver: 'node-cron',
    schedule: '* * * * *',
    scheduleHuman: 'Every minute',
    action: 'Cancel courier_order pending >3 min',
    sendsEmail: false,
    userLng: false,
    init: 'initGhostDriverCron(io)',
    status: 'active',
  },
  {
    id: 'appointment-reminder',
    file: 'utils/cron-jobs.js',
    driver: 'node-cron',
    schedule: '0 8 * * *',
    scheduleHuman: 'Daily 08:00 server time',
    action: 'Email reminders for appointments scheduled tomorrow',
    sendsEmail: true,
    emailTemplate: 'service-appointment',
    userLng: true,
    init: 'initGhostDriverCron(io)',
    status: 'active',
  },
  {
    id: 'rental-expiry',
    file: 'utils/cron-jobs.js',
    driver: 'node-cron',
    schedule: '0 9 * * *',
    scheduleHuman: 'Daily 09:00 server time',
    action: 'Email notices for paid rentals expiring tomorrow',
    sendsEmail: true,
    emailTemplate: 'rental-expiry',
    userLng: true,
    init: 'initGhostDriverCron(io)',
    status: 'active',
  },
  {
    id: 'password-reset-token-prune',
    file: 'utils/cron-jobs.js',
    driver: 'node-cron',
    schedule: '0 * * * *',
    scheduleHuman: 'Every hour',
    action: 'Delete expired password_reset_tokens rows',
    sendsEmail: false,
    userLng: false,
    init: 'initGhostDriverCron(io)',
    status: 'active',
  },

  // ── utils/ride-timeout-cron.js ────────────────────────────────────────────
  {
    id: 'ride-timeout-refund',
    file: 'utils/ride-timeout-cron.js',
    driver: 'node-cron',
    schedule: '*/2 * * * *',
    scheduleHuman: 'Every 2 minutes',
    action: 'Cancel stale pending rides (>3 min), wallet refund, socket notify',
    sendsEmail: false,
    userLng: false,
    init: 'startRideTimeoutCron(io)',
    status: 'active',
    notes: 'Primary ride timeout handler (includes refund logic).',
  },

  // ── utils/ride-dispatch.js ────────────────────────────────────────────────
  {
    id: 'ride-dispatch',
    file: 'utils/ride-dispatch.js',
    driver: 'setInterval',
    schedule: '5000ms',
    scheduleHuman: 'Every 5 seconds',
    action: 'Expire driver offers + redispatch orphaned pending rides',
    sendsEmail: false,
    userLng: false,
    init: 'startRideDispatchCron(io)',
    status: 'active',
  },

  // ── utils/ride-noshow-cron.js ─────────────────────────────────────────────
  {
    id: 'ride-noshow-fee',
    file: 'utils/ride-noshow-cron.js',
    driver: 'node-cron',
    schedule: '*/2 * * * *',
    scheduleHuman: 'Every 2 minutes',
    action: 'Auto-cancel trips where the driver arrived but the rider never boarded past the grace period, apply no-show fee, notify driver they are free to go',
    sendsEmail: false,
    userLng: false,
    init: 'startRideNoShowCron(io)',
    status: 'active',
  },

  // ── utils/ride-schedule-cron.js ───────────────────────────────────────────
  {
    id: 'ride-schedule',
    file: 'utils/ride-schedule-cron.js',
    driver: 'node-cron',
    schedule: '*/2 * * * *',
    scheduleHuman: 'Every 2 minutes',
    action: 'Dispatch scheduled rides once close to pickup time; send rider/driver reminders (in-app + push + email) as scheduled pickup approaches',
    sendsEmail: true,
    emailTemplate: 'ride-status',
    userLng: true,
    init: 'startRideScheduleCron(io)',
    status: 'active',
    notes: 'Replaces the previously frontend-only "schedule for later" — ride_request.scheduled_at is now persisted and actually held until dispatch.',
  },

  // ── utils/scheduled-chat-cron.js ──────────────────────────────────────────
  {
    id: 'scheduled-chat',
    file: 'utils/scheduled-chat-cron.js',
    driver: 'setInterval',
    schedule: '15000ms',
    scheduleHuman: 'Every 15 seconds',
    action: 'Deliver due scheduled_chat_message rows via createChatMessage + socket notify',
    sendsEmail: false,
    userLng: false,
    init: 'startScheduledChatCron(io)',
    status: 'active',
    notes: 'Persists schedules server-side so messages send even when the sender browser is closed.',
  },

  // ── utils/property-saved-search-cron.js ───────────────────────────────────
  {
    id: 'property-saved-search-alerts',
    file: 'utils/property-saved-search-cron.js',
    driver: 'node-cron',
    schedule: '*/15 * * * *',
    scheduleHuman: 'Every 15 minutes',
    action: 'Notify users when new published properties match their alert-enabled saved searches (in-app + web push; optional email)',
    sendsEmail: true,
    emailTemplate: 'property-saved-search (PROPERTY_SAVED_SEARCH_EMAIL=true)',
    userLng: true,
    init: 'startPropertySavedSearchCron(io)',
    status: 'active',
    notes: 'Watermarked by property_saved_search.last_notified_at. Manual trigger: POST /property/saved-searches/run-alerts',
  },

  // ── utils/job-saved-search-cron.js ────────────────────────────────────────
  {
    id: 'job-saved-search-alerts',
    file: 'utils/job-saved-search-cron.js',
    driver: 'node-cron',
    schedule: '*/15 * * * *',
    scheduleHuman: 'Every 15 minutes',
    action: 'Notify seekers when newly posted open jobs match their alert-enabled saved searches',
    sendsEmail: true,
    emailTemplate: 'job-saved-search (JOB_SAVED_SEARCH_EMAIL=true)',
    userLng: true,
    init: 'startJobSavedSearchCron(io)',
    status: 'active',
    notes: 'Watermarked by job_saved_search.last_notified_at; daily frequency throttles to 24h. Manual: POST /job/saved-searches/run-alerts',
  },

  // ── utils/mail-outbox-cron.js ───────────────────────────────────────────────
  {
    id: 'mail-outbox-drain',
    file: 'utils/mail-outbox-cron.js',
    driver: 'node-cron',
    schedule: '*/2 * * * *',
    scheduleHuman: 'Every 2 minutes',
    action: 'Drain stale pending critical-mail outbox rows (crash recovery; no auto-retry of failed OTP)',
    sendsEmail: true,
    emailTemplate: 'critical templates via outbox (otp, receipts, …)',
    userLng: false,
    init: 'startMailOutboxCron()',
    status: 'active',
    notes: 'Skip with MAIL_OUTBOX_DISABLED=true. Stale threshold MAIL_OUTBOX_STALE_MS (default 120s).',
  },

  // ── utils/work-dispatch.js ──────────────────────────────────────────────────
  {
    id: 'work-dispatch',
    file: 'utils/work-dispatch.js',
    driver: 'setInterval',
    schedule: '5000ms',
    scheduleHuman: 'Every 5 seconds',
    action: 'Expire on-demand work job offers to workers',
    sendsEmail: false,
    userLng: false,
    init: 'startWorkDispatchCron(io)',
    status: 'active',
  },

  // ── utils/recommendation-cron.js ────────────────────────────────────────────
  {
    id: 'reco-interest-profiles',
    file: 'utils/recommendation-cron.js',
    driver: 'node-cron',
    schedule: '*/15 * * * *',
    scheduleHuman: 'Every 15 minutes',
    action: 'Refresh interest vectors for recently active users',
    sendsEmail: false,
    userLng: false,
    init: 'initRecommendationCron()',
    status: 'active',
  },
  {
    id: 'reco-trending-tokens',
    file: 'utils/recommendation-cron.js',
    driver: 'node-cron',
    schedule: '*/30 * * * *',
    scheduleHuman: 'Every 30 minutes',
    action: 'Recompute rolling trending topic tokens',
    sendsEmail: false,
    userLng: false,
    init: 'initRecommendationCron()',
    status: 'active',
  },

  // ── workers/video-reconciliation.js ───────────────────────────────────────
  {
    id: 'video-reconciliation',
    file: 'workers/video-reconciliation.js',
    driver: 'setInterval',
    schedule: '900000ms',
    scheduleHuman: 'Every 15 minutes',
    action: 'Re-queue stalled video transcodes (lost enqueue / worker crash)',
    sendsEmail: false,
    userLng: false,
    init: 'startVideoReconciliationCron()',
    status: 'active',
    notes: 'Disabled when AZURE_STORAGE_CONNECTION_STRING unset.',
  },

  // ── workers/live-session-sweep.js ───────────────────────────────────────────
  {
    id: 'live-session-sweep',
    file: 'workers/live-session-sweep.js',
    driver: 'setInterval',
    schedule: '300000ms',
    scheduleHuman: 'Every 5 minutes',
    action: 'Cancel stale STARTING/IDLE live sessions; end orphaned LIVE >24h',
    sendsEmail: false,
    userLng: false,
    init: 'startLiveSessionSweep()',
    status: 'active',
  },

  // ── index.js + utils/ads-delivery-engine.js ─────────────────────────────────
  {
    id: 'ads-daily-budget-reset',
    file: 'index.js → utils/ads-delivery-engine.js',
    driver: 'node-cron',
    schedule: '0 0 * * *',
    scheduleHuman: 'Daily midnight server time',
    action: 'Restore OUT_OF_BUDGET campaigns when wallet balance > 0',
    sendsEmail: false,
    userLng: false,
    init: "cron.schedule('0 0 * * *', resetDailyBudgetCron)",
    status: 'active',
  },
  {
    id: 'ads-redis-heartbeat',
    file: 'index.js → utils/ads-delivery-engine.js',
    driver: 'setInterval',
    schedule: '60000ms',
    scheduleHuman: 'Every 60 seconds',
    action: 'Sync ads:active:index Redis set with DB ACTIVE campaigns',
    sendsEmail: false,
    userLng: false,
    init: 'setInterval(dbRedisConsistencyHeartbeat)',
    status: 'active',
  },

  // ── Gap analysis: not yet implemented ─────────────────────────────────────────
  {
    id: 'product-order-unpaid-timeout',
    file: '(not implemented)',
    driver: 'node-cron',
    schedule: 'TBD',
    scheduleHuman: 'TBD — product decision',
    action: 'Auto-cancel unpaid product_order after checkout timeout',
    sendsEmail: false,
    userLng: false,
    init: '—',
    status: 'gap',
    notes: 'Identified in Phase 2.3 plan; no cron exists yet.',
  },
  {
    id: 'community-mail-donation',
    file: 'routes/donation-routes.js',
    driver: '—',
    schedule: 'on-demand',
    scheduleHuman: 'Route trigger (not cron)',
    action: 'Notify project owner on new donation (community-mail)',
    sendsEmail: true,
    emailTemplate: 'community-mail',
    userLng: true,
    init: 'donation route POST',
    status: 'active',
    notes: 'Sends community-mail to campaign owner when donation is created.',
  },
];

/** Prisma user fields required for cron-triggered emails. */
export const CRON_EMAIL_USER_SELECT = {
  email: true,
  name: true,
  language: true,
};

export function getCronEmailJobs() {
  return CRON_INVENTORY.filter((j) => j.sendsEmail && j.status !== 'gap');
}

export function getCronGaps() {
  return CRON_INVENTORY.filter((j) => j.status === 'gap');
}

export function getCronOverlaps() {
  return CRON_INVENTORY.filter((j) => j.status === 'overlap');
}

/** Log inventory summary on server boot (Step 1). */
export function logCronInventory() {
  const active = CRON_INVENTORY.filter((j) => j.status === 'active');
  const emailJobs = getCronEmailJobs();
  const gaps = getCronGaps();
  const overlaps = getCronOverlaps();

  console.log('───────────────────────────────────────────────────────────');
  console.log(`[Cron Inventory] ${CRON_INVENTORY.length} entries · ${active.length} active schedules`);
  console.log(`[Cron Inventory] ${emailJobs.length} email-sending job(s) · ${gaps.length} gap(s) · ${overlaps.length} overlap(s)`);

  for (const job of emailJobs) {
    const lngFlag = job.userLng === true ? 'user.language ✓' : String(job.userLng);
    console.log(`  📧 ${job.id} → ${job.emailTemplate} (${job.scheduleHuman}) [${lngFlag}]`);
  }

  for (const job of overlaps) {
    console.log(`  ⚠️  overlap: ${job.id} — ${job.notes || job.action}`);
  }

  for (const job of gaps) {
    console.log(`  ⬜ gap: ${job.id} — ${job.notes || job.action}`);
  }

  console.log('───────────────────────────────────────────────────────────');
}
