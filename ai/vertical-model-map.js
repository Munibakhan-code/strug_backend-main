/**
 * Maps each verticalSlug to:
 *   - allowedModels: Prisma model names the chatbot may query
 *   - sensitiveFields: fields that must never appear in SELECT
 *   - allowedOperations: safe read-only Prisma operations only
 */

export const SENSITIVE_FIELDS = new Set([
  'password', 'ref_code', 'email', 'otp_code',
  'license_number', 'bank_account_number', 'encryption_key',
  'access_token', 'refresh_token',
])

export const ALLOWED_OPERATIONS = new Set(['findMany', 'findFirst', 'count'])

export const VERTICAL_MODEL_MAP = {
  // Core
  home: { allowedModels: [] },
  ondemand: { allowedModels: ['services', 'service_type', 'service_category', 'user_service_provider', 'service_order', 'service_ratings'] },
  videos: { allowedModels: ['video', 'channel', 'subscription', 'video_comments', 'video_likes', 'video_analytics', 'watch_history', 'stream', 'streamer', 'stream_chat', 'stream_category'] },

  // Commerce & Services
  shop: { allowedModels: ['product_listing', 'product_variation', 'product_type', 'product_order', 'product_ratings', 'dg_content', 'dg_categories'] },
  food: { allowedModels: ['food_vendor', 'food_item', 'food_category', 'food_order', 'food_order_items', 'delivery_driver', 'vendor_type'] },
  lessons: { allowedModels: ['lesson', 'language', 'lesson_user', 'question_option', 'flash_card'] },
  preconstruct: { allowedModels: ['property', 'projects'] },
  tempstay: { allowedModels: ['place', 'place_orders', 'place_pics', 'event_type'] },
  events: { allowedModels: ['meetup', 'meetup_event_image', 'event_type'] },
  venues: { allowedModels: ['place', 'place_orders', 'place_pics'] },
  groceries: { allowedModels: ['food_vendor', 'food_item', 'food_category', 'food_order', 'food_order_items', 'delivery_driver', 'vendor_type'] },
  equipment: { allowedModels: ['rental_listing', 'rental_categories', 'rental_type', 'rental_order', 'rental_ratings', 'rental_listing_pics'] },
  floral: { allowedModels: ['services', 'service_type', 'service_category', 'user_service_provider', 'service_order'] },
  realestate: { allowedModels: ['property', 'loans'] },
  decor: { allowedModels: ['booking_listing', 'booking', 'product_listing', 'product_order'] },
  automotive: { allowedModels: ['vehicle', 'vehicle_types'] },
  vehicles: { allowedModels: ['vehicle', 'vehicle_types'] },
  rideshare: { allowedModels: ['ride_request', 'active_trip', 'driver_profile', 'vehicle', 'vehicle_types', 'ride_rating', 'carpool_offer', 'carpool_booking'] },
  hotel: { allowedModels: ['place', 'place_orders', 'place_pics', 'rental_listing'] },
  courier: { allowedModels: ['courier_order', 'courier_customer', 'courier_service_provider'] },
  insurance: { allowedModels: ['services', 'service_type', 'service_category', 'service_order'] },
  mortgage: { allowedModels: ['property', 'loans'] },

  // Content & Creative
  pinboard: { allowedModels: ['social_media_attachments'] },
  favourites: { allowedModels: ['user'] },
  experiences: { allowedModels: ['place', 'meetup'] },
  wedding: { allowedModels: ['booking_listing', 'booking', 'booking_event', 'availability', 'product_listing', 'product_order', 'product_variation', 'product_type'] },
  proservices: { allowedModels: ['services', 'service_category', 'service_type', 'user_service_provider', 'service_order', 'service_ratings'] },
  digservices: { allowedModels: ['services', 'service_category', 'service_type', 'user_service_provider', 'service_order', 'service_ratings'] },
  artists: { allowedModels: ['talent', 'talent_category'] },
  secondhand: { allowedModels: ['product_listing', 'product_type'] },
  reservations: { allowedModels: ['place_orders', 'rental_order'] },
  celebrity: { allowedModels: ['influencer'] },

  // Social & Community
  social: { allowedModels: ['social_feed', 'social_comments', 'social_interactions', 'social_media_attachments', 'connections', 'professional_profile', 'platform_type'] },
  feed: { allowedModels: ['social_feed', 'social_comments', 'social_interactions', 'social_media_attachments', 'connections', 'professional_profile', 'platform_type'] },
  community: { allowedModels: ['connections', 'social_feed'] },
  live: { allowedModels: ['stream', 'streamer', 'stream_chat', 'stream_category'] },
  discounts: { allowedModels: ['promotion', 'product_listing', 'product_variation'] },
  portfolio: { allowedModels: ['professional_profile'] },
  influencer: { allowedModels: ['influencer'] },
  bookartist: { allowedModels: ['talent', 'talent_category'] },
  books: { allowedModels: ['product_listing'] },
  medical: { allowedModels: ['booking_listing', 'booking'] },
  catering: { allowedModels: ['food_vendor', 'food_item', 'food_category'] },
  raise: { allowedModels: ['kickstarter', 'donation'] },
  meet: { allowedModels: ['meetup', 'meetup_event_image'] },
  digproducts: { allowedModels: ['dg_content', 'dg_categories'] },
  learn: { allowedModels: ['lesson', 'language', 'lesson_user', 'question_option', 'flash_card'] },

  // Account
  refcodes: { allowedModels: ['shared_ref_code'] },
  wallet: { allowedModels: [] }, // avoid wallet direct queries via AI for security
  messages: { allowedModels: ['chat_messages', 'chat_participants'] },
  dashboard: { allowedModels: ['user'] },
  orders: { allowedModels: ['product_order', 'food_order', 'service_order', 'rental_order', 'courier_order'] },
  settings: { allowedModels: ['user'] },
  help: { allowedModels: [] },
  ai: { allowedModels: [] },

  // Backward compatibility / older mappings
  'food-groceries': { allowedModels: ['food_vendor', 'food_item', 'food_category', 'food_order', 'food_order_items', 'delivery_driver', 'vendor_type'] },
  restaurants: { allowedModels: ['food_vendor', 'food_item', 'food_category', 'food_order', 'food_order_items', 'delivery_driver'] },
  'on-demand': { allowedModels: ['services', 'service_type', 'service_category', 'user_service_provider', 'service_order', 'service_ratings'] },
  rentals: { allowedModels: ['rental_listing', 'rental_categories', 'rental_type', 'rental_order', 'rental_ratings', 'rental_listing_pics'] },
  ecommerce: { allowedModels: ['product_listing', 'product_variation', 'product_type', 'product_order', 'product_ratings', 'dg_content', 'dg_categories'] },
  'hosting-stay': { allowedModels: ['place', 'place_orders', 'place_pics', 'event_type'] },
  'real-estate': { allowedModels: ['property', 'loans'] },
  'financial-solutions': { allowedModels: ['loans'] },
  services: { allowedModels: ['services', 'service_type', 'service_category', 'user_service_provider', 'service_order', 'service_ratings', 'appointments'] },
'decor-services': { allowedModels: ['booking_listing', 'booking', 'product_listing', 'product_order'] },
  'wedding-services': { allowedModels: ['booking_listing', 'booking', 'booking_event', 'availability', 'product_listing', 'product_order', 'product_variation', 'product_type'] },
  'video-streaming': { allowedModels: ['video', 'channel', 'subscription', 'video_comments', 'video_likes', 'video_analytics', 'watch_history', 'stream', 'streamer', 'stream_chat', 'stream_category'] },
  assistant: { allowedModels: [] },
  analytics: { allowedModels: ['video_analytics', 'ad_impressions'] },
  freelance: { allowedModels: ['services', 'jobs', 'job_categories'] },
  hiring: { allowedModels: ['jobs', 'candidate', 'agents'] },
  marketing: { allowedModels: ['ads', 'ad_impressions'] },
  creators: { allowedModels: ['video', 'channel', 'video_analytics', 'revenue_share_log'] },
  learning: { allowedModels: ['lesson', 'language', 'lesson_user', 'question_option', 'flash_card'] },
  travel: { allowedModels: ['place', 'place_orders', 'rental_listing'] },
  business: { allowedModels: ['employees', 'payrolls', 'employee_attendance', 'shift', 'leave'] }
}

export function getAllowedModels(verticalSlug) {
  return VERTICAL_MODEL_MAP[verticalSlug]?.allowedModels ?? []
}

export function isModelAllowed(verticalSlug, modelName) {
  return getAllowedModels(verticalSlug).includes(modelName)
}

export function isOperationAllowed(operation) {
  return ALLOWED_OPERATIONS.has(operation)
}

export function sanitizeSelect(selectObj) {
  if (!selectObj || typeof selectObj !== 'object') return selectObj
  const cleaned = {}
  for (const [key, val] of Object.entries(selectObj)) {
    if (!SENSITIVE_FIELDS.has(key)) {
      cleaned[key] = val
    }
  }
  return cleaned
}
