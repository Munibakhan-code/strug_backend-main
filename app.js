import 'dotenv/config';
//import libraries
import express, { json } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import i18next from './utils/i18n.js';
import i18nextMiddleware from 'i18next-http-middleware';
import carpoolOfferRouter from './routes/carpool_offer-routes.js';
import carpoolWaypointsRouter from './routes/carpool_waypoints-routes.js';

import adsSecurityRouter from './routes/ads-security-routes.js';
import adsModerationRouter from './routes/ads-moderation-routes.js';
import adsCreativeRouter from './routes/ads-creative-routes.js';
import adsManagerRouter from './routes/ads-manager-routes.js';
import adsWalletRouter from './routes/ads-wallet-routes.js';
import adsCampaignRouter from './routes/ads-campaign-routes.js';
import adsTargetingRouter from './routes/ads-targeting-routes.js';
import boardAdminTownHallRouter from './routes/board-admin-townhall-routes.js';
import categoriesRouter from './routes/categories-routes.js';


import { harvestAdContext } from './middleware/ad-context-binder.js';



import socAuthRouter from './routes/soc-auth-routes.js';
import telemetryRouter from './routes/telemetry-routes.js';

import healthRouter from './routes/health-routes.js';
import { globalErrorHandler } from './middleware/error-handler.js';
import videoRouter from './routes/video-routes.js';
import channelRouter from './routes/channel-routes.js';
import creatorStudioRouter from './routes/creator-studio-routes.js';
import voiceaiRouter from './routes/voiceai-routes.js';
import videoEngagementRouter from './routes/video-engagement-routes.js';
import videoFriendActivityRouter from './routes/video-friend-activity-routes.js';
import videoDiscoveryRouter from './routes/video-discovery-routes.js';
import playlistRouter from './routes/playlist-routes.js';
import videoSocialRouter from './routes/video-social-routes.js';
import adEngineRouter from './routes/ad-engine-routes.js';
import aiChatRouter from './routes/ai-chat-routes.js';
import liveStreamerProfileRouter from './routes/live-streamer-profile-routes.js';



//import endpoint routers
import authRouter from './auth-routes/user-auth-route.js';
import activeTripRouter from './routes/active_trip-routes.js';
import photoRouter from './routes/photo-routes.js';
import chatMessagesRouter from './routes/chat-messages-routes.js';
import scheduledChatMessagesRouter from './routes/scheduled-chat-messages-routes.js';
import spaceRouter from './routes/space-routes.js';
import pushRouter from './routes/push-routes.js';
import chatParticipantsRouter from './routes/chat-participants-routes.js';
import chatChannelRouter from './routes/chat_channel-routes.js';
import chatMediaRouter from './routes/chat-media-routes.js';
import chatContextRouter from './routes/chat-context-routes.js';
import journalRouter from './routes/journal-routes.js';
import checkoutRouter from './routes/checkout-routes.js';
import connectionsRouter from './routes/connections-routes.js';
import courierCustomerRouter from './routes/courier-customer-routes.js';
import courierOrderRouter from './routes/courier-order-routes.js';
import courierServiceProviderRouter from './routes/courier_service-provider.js';
import cyclePredictionRouter from './routes/cycle-prediction-routes.js';
import deliveryDriverRouter from './routes/delivery-driver-routes.js';
import dgCartRouter from './routes/dg-cart-routes.js';
import dgContentRouter from './routes/dg-content-routes.js';
import dgOrderRouter from './routes/dg-order-routes.js';
import donationRouter from './routes/donation-routes.js';
import driverProfileRouter from './routes/driver-profile-routes.js';
import driverSafetyRouter from './routes/driver-safety-routes.js';
import driverDocumentRouter from './routes/driver-document-routes.js';
import sellerPortalsRouter from './routes/seller-portals-routes.js';
import emergencyContactRouter from './routes/emergency-contact-routes.js';
import employeeAttendanceRouter from './routes/employee-attendance-routes.js';
import employeeRouter from './routes/employee-routes.js';
import rideRatingRouter from './routes/ride-rating-routes.js';
import riderRatingRouter from './routes/rider-rating-routes.js';
import rideTipRouter from './routes/ride-tip-routes.js';
import carpoolBookingRouter from './routes/carpool_booking-routes.js';


//sandaru
import propertyRouter from './routes/property-routes.js';
import projectsRouter from './routes/projects-routes.js';
import floUserRouter from './routes/flo-user-routes.js';
import foodRouter from './routes/food-routes.js';
import datingRouter from './routes/dating-routes.js';
import reservationRouter from './routes/reservation-routes.js';
import jobRouter from './routes/job-routes.js';
import rewardTierRouter from './routes/reward-tier-routes.js';
import campaignUpdateRouter from './routes/campaign-update-routes.js';
import campaignPayoutRouter from './routes/campaign-payout-routes.js';
import leaveRouter from './routes/leave-routes.js';
import meetupRouter from './routes/meetup-routes.js';
import meetupEventImageRouter from './routes/meetup-event-image-routes.js';

import serviceRatingsRouter from './routes/service-ratings-routes.js';
import serviceTypeRouter from './routes/service-type-routes.js';
import servicesRouter from './routes/services-routes.js';
import rentalCategoriesRouter from './routes/rental-categories-routes.js';
import socialCommentsRouter from './routes/social-comments-routes.js';
import socialInteractionsRouter from './routes/social-interactions-routes.js';
import rentalOrderRouter from './routes/rental-order-routes.js';
import socialMediaAttachmentsRouter from './routes/social-media-attachments-routes.js';
import streamRouter from './routes/stream-routes.js';
import streamCategoryRouter from './routes/stream-category-routes.js';
import rideRequestRouter from './routes/ride-request-routes.js';
import workCategoryRouter from './routes/work-category-routes.js';
import workJobRouter from './routes/work-job-routes.js';
import wishlistRouter from './routes/wishlist-routes.js';
import eventConciergeRouter from './routes/event-concierge-routes.js';
import eventTypeRouter from './routes/event-type-routes.js';
import workRouter from './routes/work-routes.js';
import workWalletRouter from './routes/work-wallet-routes.js';
import workNotificationRouter from './routes/work-notification-routes.js';
import notificationRouter from './routes/notification-routes.js';
import quoteCategoryRouter from './routes/quote-category-routes.js';
import quoteProviderRouter from './routes/quote-provider-routes.js';
import quoteRequestRouter from './routes/quote-request-routes.js';
import quoteNotificationRouter from './routes/quote-notification-routes.js';
import serviceCategoryRouter from './routes/service-category-routes.js';
import streamChatRouter from './routes/stream-chat-routes.js';
import streamerRouter from './routes/streamer-routes.js';
import serviceOrderRouter from './routes/service-order-routes.js';
import sharedRefCodeRouter from './routes/shared-ref-code-routes.js';
import referralRouter from './routes/referral-routes.js';
import providerOpportunitiesRouter from './routes/provider-opportunities-routes.js';
import shiftRouter from './routes/shift-routes.js';
import socialFeedRouter from './routes/social-feed-routes.js';
import socialRecommendationRouter from './routes/social-recommendation-routes.js';
import symptomLogRouter from './routes/symptom-log-routes.js';
import userRouter from './routes/user-routes.js';
import vehicleRouter from './routes/vehicle-routes.js';
import vehicleTypesRouter from './routes/vehicle-types-routes.js';
import testDriveRouter from './routes/test-drive-routes.js';
import productCartRouter from './routes/product-cart-routes.js';
import productListingRouter from './routes/product-listing-routes.js';
import productRatingsRouter from './routes/product-ratings-routes.js';
import productTypeRouter from './routes/product-type-routes.js';
import productVariationRouter from './routes/product-variation-routes.js';
import professionalProfileRouter from './routes/professional-profile-routes.js';
import payrollsRouter from './routes/payrolls-routes.js';
import periodRouter from './routes/period-routes.js';
import rentalCartRouter from './routes/rental-cart-routes.js';
import rentalListingRouter from './routes/rental-listing-routes.js';
import placeRouter from './routes/place-routes.js';
import placeOrdersRouter from './routes/place-orders-routes.js';
import placePicsRouter from './routes/place-pics-routes.js';
import productOrderRouter from './routes/product-order-routes.js';
import shippingZoneRouter from './routes/shipping-zone-routes.js';
import rentalListingPicsRouter from './routes/rental-listing-pics-routes.js';
import rentalRatingsRouter from './routes/rental-ratings-routes.js';
import rentalTypeRouter from './routes/rental-type-routes.js';
import serviceCartRouter from './routes/service-cart-routes.js';
import serviceCvRouter from './routes/service-cv-routes.js';
import symptomTypesRouter from './routes/symptom-types-routes.js';
import userServiceProviderRouter from './routes/user-service-provider-routes.js';
import vendorTypeRouter from './routes/vendor-type-routes.js';

import agentsRouter from './routes/agents-routes.js';
import candidateRouter from './routes/candidate-routes.js';
import appointmentsRouter from './routes/appointments-routes.js';
import calmLessonOrderBuyRouter from './routes/calm_lesson_order_buy-routes.js';
import appointmentServiceProvidersRouter from './routes/appointment_service_providers-routes.js';
import appointmentServiceCategoryRouter from './routes/appointment_service_category-routes.js';

import socialProfileRouter from './routes/social-profile-routes.js';
import verticalProfileRouter from './routes/vertical-profile-routes.js';
import socialFollowRouter from './routes/social-follow-routes.js';
import socialPostRouter from './routes/social-post-routes.js';
import socialStoryRouter from './routes/social-story-routes.js';
import socialDiscoveryRouter from './routes/social-discovery-routes.js';
import socialPrivacyRouter from './routes/social-privacy-routes.js';
import socialModerationRouter from './routes/social-moderation-routes.js';
import socialNotificationRouter from './routes/social-notification-routes.js';
import townHallRouter from './routes/town-hall-routes.js';
import socialAnalyticsRouter from './routes/social-analytics-routes.js';
// #452: Town Hall had no creator analytics at all — only social_feed posts did.
import townHallAnalyticsRouter from './routes/town-hall-analytics-routes.js';
import { startMediaCleanupCron } from './workers/townhall-media-cleanup.js';
import socialComplianceRouter from './routes/social-compliance-routes.js';
import { sanitizeInput } from './middleware/sanitizer.js';
import compression from 'compression';
import socialSystemRouter from './routes/social-system-routes.js';
import bugReportsRouter from './routes/bug-reports-routes.js';
import boardAuthRouter from './routes/board-auth-routes.js';
import boardMembersRouter from './routes/board-members-routes.js';
import boardRolesRouter from './routes/board-roles-routes.js';
import boardTasksRouter from './routes/board-routes.js';
import boardNotificationsRouter from './routes/board-notifications-routes.js';
import boardStaffChatRouter from './routes/board-staff-chat-routes.js';
import boardWebhookRouter from './routes/board-webhook-routes.js';
import boardAdminUsersRouter from './routes/board-admin-users-routes.js';
import boardAdminFinanceRouter from './routes/board-admin-finance-routes.js';
import boardAdminActivityRouter from './routes/board-admin-activity-routes.js';
import boardAdminOperationsRouter from './routes/board-admin-operations-routes.js';
import boardAdminVerticalManagementRouter from './routes/board-admin-vertical-management-routes.js';
import boardAdminCustomerSupportRouter from './routes/board-admin-customer-support-routes.js';
import boardAdminAnalyticsRouter from './routes/board-admin-analytics-routes.js';
import boardAdminProductRouter from './routes/board-admin-product-routes.js';
import boardAdminCommunicationsRouter from './routes/board-admin-communications-routes.js';
import boardAdminModerationRouter from './routes/board-admin-moderation-routes.js';
import boardPrReviewRouter from './routes/board-pr-review-routes.js';
import boardAdminRiskRouter from './routes/board-admin-risk-routes.js';
import boardAdminMarketingRouter from './routes/board-admin-marketing-routes.js';
import boardAdminCreatorOpsRouter from './routes/board-admin-creator-ops-routes.js';
import boardAdminEngineeringRouter from './routes/board-admin-engineering-routes.js';
import boardAdminKycRouter from './routes/board-admin-kyc-routes.js';
import boardAdminSocialRouter from './routes/board-admin-social-routes.js';
import boardAdminCampaignsRouter from './routes/board-admin-campaigns-routes.js';
import bookingEngineRouter, { bookingWebhookRouter } from './routes/booking-engine-routes.js';
import paymentRouter from './routes/payment-routes.js';
import decorRouter from './routes/decor-routes.js';
import experienceRouter from './routes/experience-routes.js';
import weddingRouter from './routes/wedding-routes.js';
import discountsRouter from './routes/discounts-routes.js';
import booksRouter from './routes/books-routes.js';
import locationRouter from './routes/location-routes.js';
import localeRouter from './routes/locale-routes.js';
import platformPublicRouter from './routes/platform-public-routes.js';
import liveSessionRouter from './routes/live-session-routes.js';
import liveMetricsRouter from './routes/live-metrics-routes.js';

import liveCommunityRouter from './routes/live-community-routes.js';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import liveDashboardRouter from './routes/live-dashboard-routes.js';
import liveGuestRouter from './routes/live-guest-routes.js';
import statusRouter from './routes/status-routes.js';
import liveChatRouter from './routes/live-chat-routes.js';
import liveVodRouter from './routes/live-vod-routes.js';
import liveMonetizationRouter from './routes/live-monetization-routes.js';
import liveWalletRouter from './routes/live-wallet-routes.js';
import liveSubscriptionRouter from './routes/live-subscription-routes.js';
import liveCoinsRouter from './routes/live-coins-routes.js';
import adsBiddingRouter from './routes/ads-bidding-routes.js';
import adsAnalyticsRouter from './routes/ads-analytics-routes.js';
import adminRoutes from './routes/admin_routes.js';
import adminMailRoutes from './routes/admin-mail-routes.js';
import mailWebhookRoutes from './routes/mail-webhook-routes.js';
import communitiesRouter from './routes/community-routes.js';
import communitiesPostRouter from './routes/community_posts-routes.js';
import savesRouter from './routes/saves-routes.js';
import pinRouter from './routes/pin-routes.js';
import communityPostCommentRouter from "./routes/community-post-comments-route.js"
import { latencyMonitor } from './middleware/latency-monitor.js';

import freelancerProfileRouter from './routes/freelancer-profile-routes.js';
import freelanceCategoriesRouter from './routes/freelance-categories-routes.js';
import freelanceGigsRouter from './routes/freelance-gigs-routes.js';
import freelanceOrdersRoutes from './routes/freelance-orders-routes.js';
import freelanceReviewsRoutes from './routes/freelance-reviews-routes.js';
import freelanceWalletRoutes from './routes/freelance-wallet-routes.js';
import celebrityRoutes from './routes/celebrity-routes.js';
import bookArtist from './routes/book-artist-routes.js';
import celebrityVideoRoutes from './routes/celebrity-video-routes.js';
import { telemetryRecorder } from './middleware/telemetry-recorder.js';

import controllerRouter from './routes/controller-routes.js';
import jailsRouter from './routes/jails-routes.js';
import dossierRouter from './routes/dossier-routes.js';
// Fail fast if payment API keys are misconfigured
if (process.env.NODE_ENV !== 'test') {
  if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.startsWith('sk_')) {
    throw new Error('Invalid STRIPE_SECRET_KEY — must start with "sk_". Refusing to start.');
  }
  if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) {
    if (!process.env.PAYPAL_CLIENT_ID.trim() || !process.env.PAYPAL_CLIENT_SECRET.trim()) {
      throw new Error('PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is empty. Refusing to start.');
    }
  }
}


const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 5000;

// M1: explicit origin allowlist — no regex wildcards in production
const ALLOWED_ORIGINS_PROD = [
  'https://app.strug.ca',
  'https://app.staging.strug.ca',
  'https://strug.ca',
  'https://www.strug.ca',
  'https://staging.strug.ca',
  // The prod Static Web App's own hostname. Keep this current: when the app.strug.ca
  // custom-domain binding broke (2026-07-12) this was the only way to reach the real
  // prod SPA, and the entry here was still the OLD, deleted SWA — so nothing could be
  // verified against prod until the domain came back.
  'https://purple-pebble-004a1d610.7.azurestaticapps.net',
  'https://strug-internal-dashboards.vercel.app', // internal company dashboards
  // "http://localhost:3000",
  // "http://localhost:5173"
  'https://soc.strug.ca',
  'https://soc.staging.strug.ca',
  'https://soc-staging.strug.ca',

];
const ALLOWED_ORIGINS_DEV = [
  /^https?:\/\/([a-zA-Z0-9-]+\.)?localhost:(3000|3001|5173|8081)$/,
  /^https?:\/\/127\.0\.0\.1:(3000|3001|5173|8081)$/,
  /^https:\/\/strug-final-frontend(-[a-z0-9]+)?(-[a-z0-9]+)?\.vercel\.app$/,
  /^https:\/\/[a-z0-9-]+-[a-z0-9]+\.azurestaticapps\.net$/,
];
// Staging and production BOTH deploy with NODE_ENV='production', so NODE_ENV cannot tell them
// apart. The dev origins (localhost:5173 et al) were therefore stripped on STAGING too, and a
// developer pointing a local frontend at api.staging.strug.ca got a preflight that 500'd with no
// CORS headers at all — surfacing in the browser as a bare "Network Error". That is why local dev
// "can't reach a real API": nothing was broken locally, staging was refusing the origin.
//
// APP_ENV is the discriminator, and it FAILS CLOSED: only an explicit 'staging' widens the
// allowlist. Unset, misspelled, or 'production' — including on any host that never sets it — is
// treated as production and gets NO localhost origins. Loosening prod requires a deliberate
// APP_ENV=staging, which is exactly the mistake we want to be impossible to make by omission.
export const isStagingEnv = (env = process.env) => env.APP_ENV === 'staging';
const isLocalEnv = (env = process.env) => env.NODE_ENV !== 'production';

export const allowedOriginsFor = (env = process.env) =>
  (isLocalEnv(env) || isStagingEnv(env))
    ? [...ALLOWED_ORIGINS_PROD, ...ALLOWED_ORIGINS_DEV]
    : ALLOWED_ORIGINS_PROD;

const ALLOWED_ORIGINS = allowedOriginsFor();

export const originAllowedBy = (origins, origin) => origins.some(entry =>
  typeof entry === 'string' ? entry === origin : entry.test(origin)
);

const isAllowedOrigin = (origin) => originAllowedBy(ALLOWED_ORIGINS, origin);

// Express CORS — per-request delegate so credentials can vary by origin.
//
// "null" / no-Origin: native mobile apps, curl, server-to-server, and — critically —
// sandboxed/opaque-origin browsers (Facebook & Instagram in-app WebViews, some Android
// WebViews, privacy-hardened browsers) send the Origin header as the literal string
// "null". The old guard only handled a *missing* Origin, so "null" fell through to the
// allowlist, got rejected with a 500 that carried no CORS headers, and the browser
// surfaced it as "Failed to fetch" on signup (the first call is /auth/register-request).
//
// We allow these but WITHOUT credentials: reflecting `Access-Control-Allow-Origin: null`
// together with `Access-Control-Allow-Credentials: true` is exploitable — any attacker
// page can spawn a sandboxed iframe (which gets Origin "null") and make credentialed
// cross-origin reads against an authenticated victim. Our auth fetches are non-credentialed,
// so signup/login still work from these browsers; only allowlisted origins get credentials.
const corsDelegate = (req, callback) => {
  const origin = req.header('Origin');
  if (!origin || origin === 'null') {
    return callback(null, { origin: true, credentials: false });
  }
  if (isAllowedOrigin(origin)) {
    return callback(null, { origin: true, credentials: true });
  }
  console.warn("Blocked by CORS:", origin);
  return callback(new Error("Not allowed by CORS"));
};

// Socket.IO CORS — sockets authenticate by token in the handshake (index.js), not by
// cookies, so a null-origin connection cannot read another user's data. Allow no-origin
// and "null" the same way; reject everything else.
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || origin === 'null' || isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    console.warn("Blocked by CORS (socket):", origin);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
};



// --- SWAGGER API DOCUMENTATION SETUP ---
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Strug Social API',
      version: '1.0.0',
      description: 'Strug Super-App Social Media Module Documentation'
    },
    servers: [{ url: `http://localhost:${PORT}` }]
  },
  apis: ['./routes/*.js'],
};

const swaggerDocs = swaggerJsdoc(swaggerOptions);
// #1288: do not expose the full attack-surface map on public production.
// Enable when ENABLE_API_DOCS=1, APP_ENV=staging, or non-production NODE_ENV (local/dev/test).
const enableApiDocs = process.env.ENABLE_API_DOCS === '1'
  || process.env.ENABLE_API_DOCS === 'true'
  || process.env.APP_ENV === 'staging'
  || process.env.NODE_ENV !== 'production';
if (enableApiDocs) {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));
} else {
  app.get('/api-docs', (_req, res) => res.status(404).json({ message: 'Not found' }));
  app.get('/api-docs/*', (_req, res) => res.status(404).json({ message: 'Not found' }));
}

app.use(cors(corsDelegate));

// Baseline security headers (helmet-equivalent, dependency-free). Applied to every response
// before routes. HSTS only over HTTPS in production.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Liveness / readiness probes. Mounted before the body parsers and before latencyMonitor:
// a probe needs no body, and probing every few seconds would otherwise flood the request log.
app.use('/health', healthRouter);

// GitHub webhook for the Task Board verifies HMAC over the RAW request bytes, so it must
// parse with express.raw BEFORE the global json() consumes the body. (M5)
app.use('/board/webhook/github', express.raw({ type: '*/*' }), boardWebhookRouter);

// Stripe booking webhook verifies the signature over the RAW bytes — must parse
// with express.raw BEFORE the global json() consumes the body.
app.use('/booking/webhook/stripe', express.raw({ type: '*/*' }), bookingWebhookRouter);


app.use(json());
app.use(cookieParser());
app.use(harvestAdContext);
app.use(i18nextMiddleware.handle(i18next));
app.use('/uploads', express.static('uploads'));
app.use(sanitizeInput); // M4: register before routes so it actually runs
app.use(telemetryRecorder);
app.use(compression({
  level: 6,
  threshold: 100 * 1024,
}));


app.use(latencyMonitor); // Register immediately after parsing to capture precise execution times!

//configure routers to redirect to endpoints
app.use('/carpool-booking', carpoolBookingRouter);
app.use('/auth', authRouter);
app.use('/admin', adminRoutes);
app.use('/admin/mail', adminMailRoutes);
app.use('/mail/webhook', mailWebhookRoutes);
app.use('/active-trip', activeTripRouter);
app.use('/carpool-offer', carpoolOfferRouter);
app.use('/photo', photoRouter);
app.use('/community', communitiesRouter);
app.use('/community-post', communitiesPostRouter);
app.use('/saves', savesRouter);
app.use('/pins', pinRouter);
app.use('/community-post-comments', communityPostCommentRouter);
app.use('/chat-messages', chatMessagesRouter);
app.use('/scheduled-chat-messages', scheduledChatMessagesRouter);
app.use('/spaces', spaceRouter);
app.use('/push', pushRouter);
app.use('/chat-participants', chatParticipantsRouter);
app.use('/chat-channel', chatChannelRouter);
app.use('/chat-media', chatMediaRouter);
app.use('/chat-context', chatContextRouter);
app.use('/journal', journalRouter);
app.use('/checkout', checkoutRouter);
app.use('/connections', connectionsRouter);
app.use('/courier-customer', courierCustomerRouter);
app.use('/courier-order', courierOrderRouter);
app.use('/courier-service-provider', courierServiceProviderRouter);
app.use('/cycle-prediction', cyclePredictionRouter);
app.use('/delivery-driver', deliveryDriverRouter);
// #1291: unused cloth/calm catalog/cam/discord/flash/cs/talent scaffolds unmounted.
app.use('/dg-cart', dgCartRouter);
app.use('/dg-content', dgContentRouter);
app.use('/dg-order', dgOrderRouter);
app.use('/donation', donationRouter);
// Mounted before '/driver-profile' — that router has GET /:driver_profile_id, which would
// otherwise greedily match '/driver-profile/documents' (treating "documents" as an id) since
// Express tries mounted routers in registration order.
app.use('/driver-profile/documents', driverDocumentRouter);
app.use('/driver-profile', driverProfileRouter);
app.use('/driver-safety', driverSafetyRouter);
app.use('/seller-portals', sellerPortalsRouter);
app.use('/emergency-contact', emergencyContactRouter);
app.use('/employee-attendance', employeeAttendanceRouter);
app.use('/employee', employeeRouter);
app.use('/ride-rating', rideRatingRouter);
app.use('/rider-rating', riderRatingRouter);
app.use('/ride-tip', rideTipRouter);
app.use('/carpool-waypoints', carpoolWaypointsRouter);

//sandaru
app.use('/property', propertyRouter);
app.use('/projects', projectsRouter);
app.use('/flo-user', floUserRouter);
app.use('/food', foodRouter);
app.use('/dating', datingRouter);
app.use('/reservation', reservationRouter);
app.use('/job', jobRouter);
app.use('/reward-tiers', rewardTierRouter);
app.use('/campaign-updates', campaignUpdateRouter);
app.use('/campaign-payouts', campaignPayoutRouter);
app.use('/leave', leaveRouter);
app.use('/meetup', meetupRouter);
app.use('/meetup-event-image', meetupEventImageRouter);
app.use('/service-ratings', serviceRatingsRouter);
app.use('/service-type', serviceTypeRouter);
app.use('/services', servicesRouter);
app.use('/rental-categories', rentalCategoriesRouter);
app.use('/social-comments', socialCommentsRouter);
app.use('/social-interactions', socialInteractionsRouter);
app.use('/rental-order', rentalOrderRouter);
app.use('/booking', bookingEngineRouter);
app.use('/social-media-attachments', socialMediaAttachmentsRouter);
app.use('/stream', (req, res, next) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Link', '</live-session>; rel="successor-version"');
  next();
}, streamRouter);
app.use('/stream-category', streamCategoryRouter);
app.use('/ride-request', rideRequestRouter);
app.use('/work-categories', workCategoryRouter);
app.use('/work-jobs', workJobRouter);
app.use('/wishlist', wishlistRouter);
app.use('/event-concierge', eventConciergeRouter);
app.use('/event-type', eventTypeRouter);
app.use('/workers', workRouter);
app.use('/work-wallet', workWalletRouter);
app.use('/work-notifications', workNotificationRouter);
app.use('/notifications', notificationRouter);
app.use('/quote-categories', quoteCategoryRouter);
app.use('/quote-providers', quoteProviderRouter);
app.use('/quote-requests', quoteRequestRouter);
app.use('/quote-notifications', quoteNotificationRouter);
app.use('/service-category', serviceCategoryRouter);
app.use('/stream-chat', (req, res, next) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Link', '</live-chat>; rel="successor-version"');
  next();
}, streamChatRouter);
app.use('/streamer', (req, res, next) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Link', '</live-streamer>; rel="successor-version"');
  next();
}, streamerRouter);
app.use('/service-order', serviceOrderRouter);
app.use('/shared-ref-code', sharedRefCodeRouter);
app.use('/referral', referralRouter);
// Phase S3: Recruit aliases — same handlers; Prefer /recruit in new clients.
app.use('/recruit', referralRouter);
app.use('/provider-opportunities', providerOpportunitiesRouter);
app.use('/shift', shiftRouter);
app.use('/symptom-log', symptomLogRouter);
app.use('/user', userRouter);
app.use('/vehicle', vehicleRouter);
app.use('/vehicle-types', vehicleTypesRouter);
app.use('/test-drive', testDriveRouter);
app.use('/product-cart', productCartRouter);
app.use('/product-listing', productListingRouter);
app.use('/product-ratings', productRatingsRouter);
app.use('/product-type', productTypeRouter);
app.use('/product-variation', productVariationRouter);
app.use('/professional-profile', professionalProfileRouter);
app.use('/payrolls', payrollsRouter);
app.use('/period', periodRouter);
app.use('/rental-cart', rentalCartRouter);
app.use('/rental-listing', rentalListingRouter);
app.use('/place', placeRouter);
app.use('/place-orders', placeOrdersRouter);
app.use('/place-pics', placePicsRouter);
app.use('/product-order', productOrderRouter);
app.use('/shipping', shippingZoneRouter);
app.use('/rental-listing-pics', rentalListingPicsRouter);
app.use('/rental-ratings', rentalRatingsRouter);
app.use('/rental-type', rentalTypeRouter);
app.use('/service-cart', serviceCartRouter);
app.use('/service-cv', serviceCvRouter);
app.use('/symptom-types', symptomTypesRouter);
app.use('/user-service-provider', userServiceProviderRouter);
app.use('/vendor-type', vendorTypeRouter);

app.use('/agents', agentsRouter);
app.use('/candidate', candidateRouter);
app.use('/appointments', appointmentsRouter);
app.use('/calm-lesson-order-buy', calmLessonOrderBuyRouter);
// Intentionally NOT mounting appointment_rating / appointment_reviews / appointment_service
// routers — Medical trust loop uses booking-engine reviews (see medical-maturity-audit Phase 1).
app.use('/appointment_service_providers', appointmentServiceProvidersRouter);
app.use('/appointment_service_category', appointmentServiceCategoryRouter);


app.use('/video', videoRouter);
app.use('/channel', channelRouter);
app.use('/creator-studio', creatorStudioRouter);
app.use('/voiceai', voiceaiRouter);
app.use('/video-engagement', videoEngagementRouter);
app.use('/video-friend-activity', videoFriendActivityRouter);
app.use('/video-discovery', videoDiscoveryRouter);
app.use('/playlist', playlistRouter);
app.use('/video-social', videoSocialRouter);
app.use('/ad-engine', adEngineRouter);
app.use('/ai-chat', aiChatRouter);
app.use('/social-follow', socialFollowRouter);
app.use('/social-profile', socialProfileRouter);
app.use('/vertical-profile', verticalProfileRouter);
app.use('/social-post', socialPostRouter);
app.use('/social-story', socialStoryRouter);
app.use('/social-comment', socialCommentsRouter);
app.use('/social-discovery', socialDiscoveryRouter);
app.use('/social-feed', socialFeedRouter);
app.use('/social-recommendations', socialRecommendationRouter);
app.use('/social-privacy', socialPrivacyRouter);
app.use('/social-moderation', socialModerationRouter);
app.use('/social-notification', socialNotificationRouter);
app.use('/town-hall', townHallRouter);
app.use('/social-analytics', socialAnalyticsRouter);
app.use('/town-hall-analytics', townHallAnalyticsRouter);
app.use('/social-system', socialSystemRouter);
app.use('/bug-reports', bugReportsRouter);
app.use('/board-auth', boardAuthRouter);
app.use('/board/members', boardMembersRouter);
app.use('/board/roles', boardRolesRouter);
app.use('/board/tasks', boardTasksRouter);
app.use('/board/notifications', boardNotificationsRouter);
app.use('/board/messages', boardStaffChatRouter);
app.use('/board-admin/users', boardAdminUsersRouter);
app.use('/board-admin/finance', boardAdminFinanceRouter);
app.use('/board-admin/activity', boardAdminActivityRouter);
app.use('/board-admin/operations', boardAdminOperationsRouter);
app.use('/board-admin/vertical-management', boardAdminVerticalManagementRouter);
app.use('/board-admin/customer-support', boardAdminCustomerSupportRouter);
app.use('/board-admin/analytics', boardAdminAnalyticsRouter);
app.use('/board-admin/product', boardAdminProductRouter);
app.use('/board-admin/communications', boardAdminCommunicationsRouter);
app.use('/board-admin/moderation', boardAdminModerationRouter);
// Super-admin-only PR review board (gated inside the router).
app.use('/board-pr-review', boardPrReviewRouter);
app.use('/board-admin/townhall', boardAdminTownHallRouter);
app.use('/board-admin/risk', boardAdminRiskRouter);
app.use('/board-admin/marketing', boardAdminMarketingRouter);
app.use('/board-admin/creator-ops', boardAdminCreatorOpsRouter);
app.use('/board-admin/engineering', boardAdminEngineeringRouter);
app.use('/board-admin/kyc', boardAdminKycRouter);
app.use('/board-admin/social', boardAdminSocialRouter);
app.use('/board-admin/campaigns', boardAdminCampaignsRouter);
app.use('/social-compliance', socialComplianceRouter);
app.use('/payments', paymentRouter);
app.use('/decor', decorRouter);
app.use('/experiences', experienceRouter);
app.use('/wedding', weddingRouter);
app.use('/discounts', discountsRouter);
app.use('/books', booksRouter);
app.use('/location', locationRouter);
app.use('/locale', localeRouter);
app.use('/platform', platformPublicRouter);
app.use('/live-chat', liveChatRouter);
app.use('/live-dashboard', liveDashboardRouter);
app.use('/status', statusRouter);
app.use('/live-community', liveCommunityRouter);
app.use('/live-session', liveMetricsRouter);
app.use('/live-session', liveSessionRouter);
app.use('/live-streamer', liveStreamerProfileRouter);
app.use('/live-guest', liveGuestRouter);
app.use('/live-vod', liveVodRouter);
app.use('/live-monetization', liveMonetizationRouter);
app.use('/live-wallet', liveWalletRouter);
app.use('/live-subscription', liveSubscriptionRouter);
app.use('/live-coins', liveCoinsRouter);

app.use('/ads-moderation', adsModerationRouter);
app.use('/ads-creative', adsCreativeRouter);
app.use('/ads-manager', adsManagerRouter);
app.use('/ads-wallet', adsWalletRouter);
app.use('/ads-campaign', adsCampaignRouter);
app.use('/ads-targeting', adsTargetingRouter);
app.use('/ads-bidding', adsBiddingRouter);
app.use('/ads-analytics', adsAnalyticsRouter);
app.use('/ads-security', adsSecurityRouter);

app.use('/freelancer-profile', freelancerProfileRouter);
app.use('/freelance-categories', freelanceCategoriesRouter);
app.use('/freelance-gigs', freelanceGigsRouter);
app.use('/freelance-orders', freelanceOrdersRoutes);
app.use('/freelance-reviews', freelanceReviewsRoutes);
app.use('/freelance-wallet', freelanceWalletRoutes);
// Freelance Stripe events are handled by the central booking webhook (mounted before json(),
// verified with STRIPE_WEBHOOK_SECRET). The old dedicated router lived here, mounted AFTER
// json(), so express.raw never saw the raw body and constructEvent 400'd on every delivery —
// paid freelance orders were left stuck PENDING. Removed; do not re-add a post-json() webhook.
app.use('/categories', categoriesRouter);
app.use('/celebrity', celebrityRoutes);
app.use('/celebrity-videos', celebrityVideoRoutes);
app.use('/book-artist', bookArtist);
app.use('/api/v1/dossiers', dossierRouter);
console.log("✅ Social Moderation Router Loaded Successfully!");

console.log("✅ Social Story Router Loaded Successfully!");

app.use('/social-interactions', socialInteractionsRouter);
app.use('/social-interaction', socialInteractionsRouter);
app.use(express.static('public'));

// S11: global error handler must be last app.use() — after all routes
app.use(globalErrorHandler);
app.use('/api/v1/controller', controllerRouter);
app.use('/api/v1/jails', jailsRouter);
app.use('/soc-auth', socAuthRouter);
app.use('/api/v1/auth', socAuthRouter);
app.use('/api/v1/telemetry', telemetryRouter);
export { app, corsOptions, PORT };
