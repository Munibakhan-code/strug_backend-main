/**
 * Static knowledge base for all Strug verticals and AI pages.
 * Each document is a rich text chunk that will be embedded and stored
 * in the MemoryVectorStore for RAG retrieval.
 */

export const KNOWLEDGE_BASE_DOCS = [

  // ─── VERTICALS ────────────────────────────────────────────────────────────

  {
    id: 'vertical-rideshare',
    verticalSlug: ['rideshare', 'automotive', 'vehicles'],
    content: `
Vertical: Rideshare — "Drive your way"
Description: A rideshare platform where drivers keep 92% of every fare. Only an 8% platform fee, no surge exploitation, no hidden deductions.
Key features:
- Fair pricing: Drivers keep the majority of every fare. The 8% fee is less than a restaurant tip.
- No surge exploitation: Dynamic pricing that's fair for riders and drivers alike.
- Driver-first tools: Scheduling, route optimization, and earnings tracking built for drivers.
- Real-time driver-rider matching with optimized routes that minimize wait times.
- Safety built in: Ride verification, live trip sharing, emergency support, transparent driver and rider ratings.
- Fleet management: Tools for fleet operators to manage drivers, vehicles, compliance, and performance.
- Multiple vehicle types: Economy, premium, XL, and specialty vehicle classes with separate pricing tiers.
- Payment flexibility: Cards, digital wallets, and cash. Drivers get paid fast.
Stats: 8% platform fee, 92% driver keeps, 0 surge multiplier.
Database models: ride_request, active_trip, driver_profile, vehicle, vehicle_types, ride_rating, carpool_offer, carpool_booking.
    `.trim(),
  },

  {
    id: 'vertical-food-groceries',
    verticalSlug: ['food', 'groceries', 'catering'],
    content: `
Vertical: Food & Groceries Delivery
Description: Order food from local restaurants and grocery vendors. Fast delivery, live tracking, multiple cuisines.
Key features:
- Browse food vendors by cuisine type, location, and availability.
- Add items to cart, checkout, and track delivery in real time.
- Delivery drivers are matched automatically based on proximity.
- OTP-based order confirmation for secure handoff.
- Support for platform fee on every order.
- Vendors manage their own menus: categories, items, prices, and availability.
- Multiple payment methods supported (card, wallet, cash).
Database models: food_vendor, food_item, food_category, food_order, food_order_items, food_cart, delivery_driver, vendor_type.
    `.trim(),
  },

  {
    id: 'vertical-restaurants',
    verticalSlug: ['restaurants'],
    content: `
Vertical: Restaurants
Description: Discover and order from local restaurants. Dine-in, takeout, and delivery options.
Key features:
- Browse restaurant menus by category and food type.
- Place orders online with real-time status tracking.
- Restaurant owners manage menus, item availability, and pricing.
- Delivery driver dispatch included.
- Ratings and reviews for restaurants and delivery.
Database models: food_vendor, food_item, food_category, food_order, food_order_items, delivery_driver.
    `.trim(),
  },

  {
    id: 'vertical-on-demand',
    verticalSlug: ['ondemand', 'floral'],
    content: `
Vertical: On-Demand Services
Description: Book any professional service on demand — mechanics, cleaners, plumbers, electricians, and more.
Key features:
- Browse service providers by category and service type.
- Book services with flexible scheduling.
- Rate and review providers after service.
- Secure payment through the platform.
- Service CVs and provider profiles for trust-building.
Database models: services, service_type, service_category, user_service_provider, service_order, service_cart, service_ratings, service_cv.
    `.trim(),
  },

  {
    id: 'vertical-rentals',
    verticalSlug: ['rentals', 'equipment'],
    content: `
Vertical: Rentals
Description: Rent anything — vehicles, equipment, tools, electronics. Short and long-term rental listings.
Key features:
- Browse rental listings by category and type.
- Check availability and pricing per duration.
- Place rental orders with payment processing.
- Rate and review after your rental.
- Owners list their items with images, descriptions, and pricing.
Database models: rental_listing, rental_categories, rental_type, rental_order, rental_cart, rental_ratings, rental_listing_pics.
    `.trim(),
  },

  {
    id: 'vertical-ecommerce',
    verticalSlug: ['shop', 'secondhand', 'books', 'digproducts'],
    content: `
Vertical: E-Commerce
Description: Buy and sell physical and digital products. Seller storefronts, product variations, and global checkout.
Key features:
- Sellers list products with multiple variations (size, color, etc.).
- Buyers browse, add to cart, and checkout securely.
- Full order management with payment tracking.
- Product ratings and feedback system.
- Digital goods marketplace included (downloadable content).
Database models: product_listing, product_variation, product_type, product_order, product_cart, product_ratings, dg_content, dg_categories, dg_order.
    `.trim(),
  },

  {
    id: 'vertical-hosting-stay',
    verticalSlug: ['tempstay', 'hotel', 'venues', 'reservations', 'events'],
    content: `
Vertical: Hosting & Stay
Description: Rent out or book places for events — party venues, studios, conference rooms, sports facilities.
Key features:
- Browse places by event type, location, and price per hour.
- Reserve a place for a specific date, time window, and duration.
- Owners list venues with photos and descriptions.
- Flexible hourly pricing.
Database models: place, place_orders, place_pics, event_type.
    `.trim(),
  },

  {
    id: 'vertical-real-estate',
    verticalSlug: ['realestate', 'mortgage', 'preconstruct'],
    content: `
Vertical: Real Estate
Description: Property listings, mortgage management, and pre-construction investment opportunities.
Key features:
- Browse property listings by type, address, and estimated value.
- Apply for loans connected to properties.
- Loan providers manage loan offers with interest rates and terms.
- Track loan payments and remaining balances.
Database models: property, loans, loan_provider, loan_payment.
    `.trim(),
  },

  {
    id: 'vertical-discounts',
    verticalSlug: ['discounts'],
    content: `
Vertical: Discounts — Local deals & sale aggregator
Description: Anytime a seller puts a product on sale (discount_pct) in Shop, SecondHand, Decor, Wedding, or other product categories, it appears in Discounts. Coupons and local deals are real promotion records with codes, windows, and redemption caps.
Key features:
- Cross-category sale feed from product_listing variations with active markdown windows.
- Coupons/deals via promotion table (percent or fixed), validated and applied server-side at checkout.
- Sellers manage markdowns from List Discounts without creating a "Discounts" product type.
- Report false discounts; schedule/expire deals; per-user and quantity caps.
Database models: product_listing, product_variation, promotion, promotion_redemption, discount_report.
    `.trim(),
  },

  {
    id: 'vertical-financial-solutions',
    verticalSlug: ['wallet', 'raise'],
    content: `
Vertical: Financial Solutions
Description: Strug Wallet, cross-vertical payments, loans, and revenue sharing for creators.
Key features:
- Strug Wallet: every user has a digital wallet with balance in local currency.
- Wallet transactions track credits and debits from all verticals (food orders, rides, ad revenue).
- Loan management for property financing.
- Revenue sharing for video creators and ad impressions.
Database models: strug_wallet, wallet_transaction, loans, loan_provider, loan_payment, revenue_share_log.
    `.trim(),
  },

  {
    id: 'vertical-services',
    verticalSlug: ['services', 'proservices', 'digservices'],
    content: `
Vertical: Professional Services
Description: Book professionals for appointments — doctors, lawyers, consultants, beauty services.
Key features:
- Browse service providers by specialization and category.
- Book appointments with time slots, notes, and service selection.
- Rate and review after appointments.
- Providers set their own pricing and availability windows.
Database models: appointments, appointment_service, appointment_service_category, appointment_service_providers, appointment_rating, appointment_reviews.
    `.trim(),
  },

  {
    id: 'vertical-medical',
    verticalSlug: ['medical'],
    content: `
Vertical: Medical
Description: Book in-person or online consultations with doctors listed on Strug Medical.
Key features:
- Public directory is booking_listing rows with vertical=medical (paired online + in-person legs).
- Search by doctor name, specialty, credentials, bio, or common symptoms (e.g. knee pain → Orthopedics).
- Self-reported insurance on listing attributes (not a live payer network). Sort by rating, price, or availability.
- This is not emergency care. Direct users to 911 (or local emergency services) and 988 for mental-health crisis.
- Flo symptom_log / symptom_types are a separate period-tracking product — do not query them for doctor search.
Database models: booking_listing, booking.
    `.trim(),
  },

  {
    id: 'vertical-decor-services',
    verticalSlug: ['decor'],
    content: `
Vertical: Décor
Description: Multi-mode décor marketplace — bookable services/rentals/seasonal packages plus a Décor product shop.
Key features:
- Services, rentals, and seasonal packages use the shared booking engine (vertical=decor, attributes.type discriminator).
- Shop mode sells physical décor products via product_listing with product_type_name=Decor.
- Hosts manage bookings and listings from the Décor provider portal (sd-decor).
Database models: booking_listing, booking, product_listing, product_order.
    `.trim(),
  },

  {
    id: 'vertical-wedding-services',
    verticalSlug: ['wedding'],
    content: `
Vertical: Wedding Services
Description: Plan your wedding with photographers, caterers, florists, venues, and all wedding vendors in one place.
Key features:
- Browse bookable wedding vendors (venues, florists, photography, catering, rentals) via booking_listing vertical=wedding.
- Book vendors through the shared booking engine with dated availability and payments.
- Shop wedding products (dresses, rings, accessories) via product_listing type Wedding, including try-on requests.
- Seller portal (sd-wedding) manages booking listings and Wedding shop products.
Database models: booking_listing, booking, booking_event, availability, product_listing, product_order, product_variation, product_type.
    `.trim(),
  },

  {
    id: 'vertical-insurance',
    verticalSlug: ['insurance'],
    content: `
Vertical: Insurance
Description: Compare and purchase insurance products across health, vehicle, property, and life categories.
Key features:
- Browse insurance providers and plans.
- Get quotes and purchase coverage.
- Manage policies through your dashboard.
Database models: services, service_type, service_category, service_order.
    `.trim(),
  },

  {
    id: 'vertical-courier',
    verticalSlug: ['courier'],
    content: `
Vertical: Courier & Delivery
Description: Send packages across the city with real-time tracking and door-to-door delivery.
Key features:
- Request courier pickup from any address.
- Real-time tracking from pickup to delivery.
- Multiple courier service providers with per-km pricing.
- OTP-based delivery confirmation.
- Payment method flexibility.
Database models: courier_order, courier_customer, courier_service_provider.
    `.trim(),
  },

  // ─── SOCIAL VERTICALS ─────────────────────────────────────────────────────

  {
    id: 'vertical-social',
    verticalSlug: ['social', 'feed', 'community', 'pinboard'],
    content: `
Vertical: Social Media — Strug Social
Description: A multi-format social platform. Post content, follow creators, like and comment, build connections.
Key features:
- Social feed with text, image, and video posts.
- Like, comment, and share posts across platform types.
- Connections (follow/connect) system.
- Platform types: social media, Q&A, forums, boards, influencer market.
- Professional profiles for job seekers.
- Live posts and stories.
Database models: social_feed, social_comments, social_interactions, social_media_attachments, connections, professional_profile, platform_type.
    `.trim(),
  },

  {
    id: 'vertical-video-streaming',
    verticalSlug: ['videos', 'live'],
    content: `
Vertical: Video & Live Streaming
Description: Upload, watch, and monetize videos. Long-form videos, shorts, and live streams — like YouTube and Twitch combined.
Key features:
- Creators have channels with display names, handles, and subscriber counts.
- Upload long-form videos and shorts with HLS streaming.
- Video analytics: views, watch time, audience country.
- Creator monetization via ad revenue sharing.
- Subscription system with notifications.
- Comments, likes, and watch history.
- Live streaming with real-time chat.
Database models: video, channel, subscription, video_comments, video_likes, video_analytics, watch_history, stream, streamer, stream_chat.
    `.trim(),
  },

  // ─── STRUG-AI PAGES ───────────────────────────────────────────────────────

  {
    id: 'strug-ai-assistant',
    verticalSlug: ['assistant', 'ai'],
    content: `
Strug AI: AI Assistant
Description: Intelligent digital teammate for customer support, scheduling, and workflow automation.
Key features:
- Customer support chatbot that resolves tickets using your knowledge base.
- Multi-step workflow automation with visual builder.
- Smart scheduling across calendars and time zones.
- Approval chains, task routing, and escalation handling.
- Native integrations with Zendesk, Slack, Google Calendar, HubSpot.
    `.trim(),
  },

  {
    id: 'strug-ai-analytics',
    verticalSlug: ['analytics'],
    content: `
Strug AI: AI Analytics
Description: Predictive analytics and real-time business intelligence powered by AI.
Key features:
- Automated report generation from your data.
- Predictive forecasting for sales, demand, and churn.
- Anomaly detection and alert system.
- Cross-vertical analytics dashboard.
    `.trim(),
  },

  {
    id: 'strug-ai-freelance',
    verticalSlug: ['freelance'],
    content: `
Strug AI: Freelance AI
Description: AI tools for freelancers — proposal writing, client matching, project estimation.
Key features:
- AI-written proposals tailored to job descriptions.
- Smart client-project matching.
- Auto-generated project timelines and milestones.
- Earnings optimizer suggesting best-fit gigs.
    `.trim(),
  },

  {
    id: 'strug-ai-hiring',
    verticalSlug: ['hiring'],
    content: `
Strug AI: AI Hiring
Description: Automate recruitment — screening, ranking, and interviewing candidates with AI.
Key features:
- Resume screening and candidate scoring.
- AI-generated interview questions per role.
- Bias-reduction tools for fairer hiring.
- Integration with job postings and application tracking.
Database models: jobs, job_application, job_categories, candidate, agents.
    `.trim(),
  },

  {
    id: 'strug-ai-marketing',
    verticalSlug: ['marketing'],
    content: `
Strug AI: AI Marketing
Description: Generate campaigns, ad copy, and content strategies using AI.
Key features:
- AI ad copy generation for multiple verticals.
- Campaign performance prediction.
- Audience segmentation recommendations.
- Ad engine integration across video, food, and social.
Database models: ads, ad_impressions.
    `.trim(),
  },

  {
    id: 'strug-ai-creators',
    verticalSlug: ['creators', 'influencer', 'celebrity', 'artists', 'bookartist', 'portfolio'],
    content: `
Strug AI: Creator AI
Description: AI tools for content creators — video ideas, captions, thumbnail concepts, monetization advice.
Key features:
- Video topic and title generation.
- Auto-generated captions and descriptions.
- Thumbnail design prompts.
- Revenue optimization based on analytics.
Database models: video, channel, video_analytics, revenue_share_log.
    `.trim(),
  },

  {
    id: 'strug-ai-learning',
    verticalSlug: ['learn', 'lessons'],
    content: `
Strug AI: Learning AI
Description: Personalized AI tutor that adapts to your learning pace and style.
Key features:
- Adaptive lessons based on performance.
- Flashcard generation from study material.
- Language learning assistance.
- Quiz creation and scoring.
Database models: lesson, language, lesson_user, question_option, flash_card, flash_card_deck.
    `.trim(),
  },

  {
    id: 'strug-ai-travel',
    verticalSlug: ['travel', 'experiences', 'meet'],
    content: `
Strug AI: Travel AI
Description: AI-powered travel planning, itinerary building, and accommodation matching.
Key features:
- Itinerary generation from destination and preferences.
- Stay and venue recommendations.
- Budget estimation and optimization.
- Integration with hosting and rental verticals.
    `.trim(),
  },

  {
    id: 'strug-ai-business',
    verticalSlug: ['business'],
    content: `
Strug AI: Business AI
Description: AI co-pilot for business operations — financial summaries, HR insights, inventory management.
Key features:
- Payroll analysis and anomaly detection.
- Employee attendance and shift reporting.
- Financial summary generation.
Database models: employees, payrolls, employee_attendance, shift, leave.
    `.trim(),
  },

  // ─── HOME / GENERAL ───────────────────────────────────────────────────────

  {
    id: 'home-general',
    verticalSlug: ['home', 'dashboard', 'settings', 'messages', 'orders', 'favourites', 'refcodes', 'help'],
    content: `
Strug Platform Overview
Strug is a super-app that combines everything in one platform:
- Social media (posts, videos, live streaming)
- E-commerce (physical products, digital goods, rentals)
- On-demand services (food delivery, rideshare, courier, mechanics)
- Professional services (appointments, freelancing, hiring)
- Financial tools (wallet, loans, revenue sharing)
- Learning (language lessons, flashcards, adaptive quizzes)
- Events and venues (place booking)
- Creator economy (video monetization, influencer marketplace)
Strug charges minimal platform fees and returns most value to service providers, drivers, and creators.
Key principle: fair fees, driver-first, creator-first, service-provider-first.
    `.trim(),
  },
]
