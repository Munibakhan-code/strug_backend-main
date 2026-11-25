# Mail template inventory

_Generated from `EMAIL_TEMPLATE_REGISTRY`. Do not edit by hand; run `npm run email:inventory:md`._

| Template | Vertical | Owner | Audience | Priority | Subject key | Trigger |
|---|---|---|---|---|---|---|
| `welcome` | auth | platform | user | high | `emails.subjects.welcome` | auth-routes/user-auth-route.js — register |
| `otp` | auth | platform | user | critical | `emails.subjects.otp` | auth — OTP send |
| `password-reset` | auth | platform | user | critical | `emails.subjects.password_reset` | auth — password-reset-request |
| `login-alert` | auth | platform | user | high | `emails.subjects.login_alert` | auth — login |
| `password-change-success` | auth | platform | user | high | `emails.password_changed.subject` | auth — reset/change password |
| `shop-order-receipt` | shop | commerce | user | high | `emails.shop.subjects.order_confirm_buyer` | product-order-email.js |
| `shop-order-status` | shop | commerce | user | normal | `emails.shop.status.subjects.confirmed` | product-order-email.js — status |
| `digital-delivery` | shop | commerce | user | high | `emails.digital.subject` | product-order-email.js — digital |
| `food-order-receipt` | food | commerce | user | high | `emails.food.subjects.order_confirm_buyer` | food-routes — order confirm |
| `food-order-status` | food | commerce | user | normal | `emails.food_status.subjects.preparing` | food-routes — status update |
| `ride-receipt` | rides | mobility | user | high | `emails.subjects.ride_receipt` | active_trip-routes — trip complete |
| `ride-status` | rides | mobility | user | high | `emails.ride_status.subjects.assigned` | ride-request accept + active_trip arrived |
| `ghost-driver` | rides | mobility | user | normal | `emails.ghost_driver.subject` | cron-jobs — ghost driver |
| `carpool-booking` | rides | mobility | user | normal | `emails.carpool_booking.subject` | carpool_booking-routes |
| `service-appointment` | services | services | user | high | `emails.services.subjects.confirmed_customer` | appointments-routes, service-order-email, cron |
| `rental-expiry` | services | services | user | normal | `emails.services.subjects.rental_expiry` | cron-jobs — rental expiry |
| `ads-low-balance` | ads | ads | user | normal | `emails.ads.low_balance_subject` | ads-wallet-routes, ads-delivery-engine |
| `ads-spend-alert` | ads | ads | user | normal | `emails.ads.spend_alert_subject` | ads-wallet-routes |
| `shift-update` | jobs | hr | user | normal | `emails.shift_update.subject` | shift-routes |
| `leave-status` | jobs | hr | user | normal | `emails.leave_status.subject_approved` | leave-routes |
| `payslip` | jobs | hr | user | high | `emails.payroll.subject` | payrolls-routes |
| `job-application-alert` | jobs | jobs | user | high | `emails.job_alert.subject` | job-routes |
| `job-application-status` | jobs | jobs | user | normal | `emails.job_status.subject` | job-routes — application status |
| `job-saved-search` | jobs | jobs | user | low | `emails.job_saved_search.subject` | job-saved-search-cron (JOB_SAVED_SEARCH_EMAIL) |
| `fintech-mail` | donations | community | user | normal | `emails.fintech.subjects.donation` | donation-routes — donor receipt |
| `community-mail` | donations | community | user | normal | `emails.community.donation_subject` | donation-routes — owner notify |
| `event-invite` | events | events | user | high | `emails.event_invite.subject` | event-concierge-routes — send-invite |
| `board-invite` | board | platform | ops | high | `emails.board_invite.subject` | board-members-routes — create member |
| `property-saved-search` | property | property | user | low | `emails.property_saved_search.subject` | property-saved-search-cron (PROPERTY_SAVED_SEARCH_EMAIL) |
| `dating-match` | dating | dating | user | high | `emails.dating_match.subject` | dating-routes — mutual match |
| `dating-worth-it-invite` | dating | dating | user | high | `emails.dating_worth_it_invite.subject` | dating-routes — worth-it invite |
| `medical-booking-confirmed` | medical | medical | user | high | `emails.medical_booking_confirmed.subject` | booking-engine — medical confirmed |
| `medical-booking-request` | medical | medical | user | high | `emails.medical_booking_request.subject` | booking-engine — medical host request |
| `venue-booking-confirmed` | venues | venues | user | high | `emails.venue_booking_confirmed.subject` | booking-engine — venue confirmed |
| `venue-booking-request` | venues | venues | user | high | `emails.venue_booking_request.subject` | booking-engine — venue host request |
| `social-new-follower` | social | social | user | low | `emails.social_new_follower.subject` | social-follow — FOLLOW accepted |
