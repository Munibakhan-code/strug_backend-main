import prisma from './prisma-client.js';
import { decrypt } from './crypto.js';
import i18next from './i18n.js';
import { emailLngFromUser } from './email-lang.js';
import { CRON_EMAIL_USER_SELECT } from './cron-inventory.js';
import { emitCronEmail, logCronError } from './cron-email.js';
// Single-flight across replicas: without this every replica fires the same tick.
import { scheduleCron } from './cron-lock.js';

export const initGhostDriverCron = (io) => {

    // =========================================================================
    // 1. GHOST DRIVER DETECTION
    // =========================================================================
    scheduleCron('ghost-driver', '* * * * *', async () => {
        try {
            const timeoutMinutes = 5;
            const threshold = new Date(Date.now() - timeoutMinutes * 60000);

            const abandonedTrips = await prisma.active_trip.findMany({
                where: {
                    started_at: { lt: threshold },
                    otp_code: { not: null },
                    ended_at: null,
                },
                include: {
                    ride_request: {
                        include: {
                            user: { select: CRON_EMAIL_USER_SELECT },
                        },
                    },
                },
            });

            for (const trip of abandonedTrips) {
                console.log(`[Cron ghost-driver] trip ${trip.trip_id} — reassigning`);

                await prisma.$transaction(async (tx) => {
                    await tx.ride_request.update({
                        where: { ride_request_id: trip.request_id },
                        data: { status: 'pending' }
                    });
                    await tx.active_trip.delete({ where: { trip_id: trip.trip_id } });
                });

                const passenger = trip.ride_request?.user;
                if (passenger?.email) {
                    emitCronEmail({
                        jobId: 'ghost-driver',
                        templateName: 'ghost-driver',
                        variables: { name: passenger.name },
                        to: decrypt(passenger.email),
                        subjectKey: 'emails.ghost_driver.subject',
                        user: passenger,
                    });
                }

                io.emit(`ride-reassigned-${trip.request_id}`, {
                    message: 'Driver not responding. Looking for a new driver...'
                });
            }
        } catch (err) {
            logCronError('ghost-driver', err);
        }
    });

    // =========================================================================
    // 2. STORY CLEANUP
    // =========================================================================
    scheduleCron('story-cleanup', '*/30 * * * *', async () => {
        try {
            const now = new Date();
            const result = await prisma.social_story.deleteMany({
                where: {
                    expires_at: { lt: now },
                    highlight_id: null
                }
            });
            if (result.count > 0) {
                console.log(`[Cron story-cleanup] deleted ${result.count} expired story/stories`);
            }
        } catch (err) {
            logCronError('story-cleanup', err);
        }
    });

    // =========================================================================
    // 3. PENDING RIDE TIMEOUT (3 minutes) — legacy; see ride-timeout-cron.js
    // =========================================================================
    scheduleCron('pending-ride-timeout-legacy', '* * * * *', async () => {
        try {
            const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);
            const timedOutRides = await prisma.ride_request.findMany({
                where: { status: 'pending', created_at: { lt: threeMinutesAgo } },
            });
            for (const ride of timedOutRides) {
                await prisma.ride_request.update({
                    where: { ride_request_id: ride.ride_request_id },
                    data: { status: 'cancelled' },
                });
                io.emit(`ride-timeout-${ride.ride_request_id}`, { message: 'No driver available. Please try again.' });
            }
            if (timedOutRides.length > 0) {
                console.log(`[Cron pending-ride-timeout-legacy] cancelled ${timedOutRides.length} ride(s)`);
            }
        } catch (err) {
            logCronError('pending-ride-timeout-legacy', err);
        }
    });

    // =========================================================================
    // 4. PENDING SERVICE ORDER TIMEOUT (3 minutes)
    // =========================================================================
    scheduleCron('service-order-timeout', '* * * * *', async () => {
        try {
            const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);
            const timedOut = await prisma.service_order.findMany({
                where: { status: 'pending', created_at: { lt: threeMinutesAgo } },
                include: {
                    user: { select: { name: true, email: true, language: true } },
                    service_type: true,
                },
            });
            for (const order of timedOut) {
                await prisma.service_order.update({
                    where: { order_id: order.order_id },
                    data: { status: 'cancelled' },
                });
                const { queueServiceOrderEmail } = await import('./service-order-email.js');
                queueServiceOrderEmail(order, 'cancelled');
                io.emit(`work-timeout-${order.order_id}`, { message: 'No provider available. Please try again.' });
            }
            if (timedOut.length > 0) {
                console.log(`[Cron service-order-timeout] cancelled ${timedOut.length} order(s)`);
            }
        } catch (err) {
            logCronError('service-order-timeout', err);
        }
    });

    // =========================================================================
    // 5. PENDING COURIER ORDER TIMEOUT (3 minutes)
    // =========================================================================
    scheduleCron('courier-order-timeout', '* * * * *', async () => {
        try {
            const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);
            const timedOut = await prisma.courier_order.findMany({
                where: { status: 'pending', last_update: { lt: threeMinutesAgo } },
            });
            for (const order of timedOut) {
                await prisma.courier_order.update({
                    where: { courier_order_id: order.courier_order_id },
                    data: { status: 'cancelled' },
                });
                io.emit(`courier-timeout-${order.courier_order_id}`, { message: 'No courier available. Please try again.' });
            }
            if (timedOut.length > 0) {
                console.log(`[Cron courier-order-timeout] cancelled ${timedOut.length} order(s)`);
            }
        } catch (err) {
            logCronError('courier-order-timeout', err);
        }
    });

    // =========================================================================
    // 6. APPOINTMENT REMINDERS
    // =========================================================================
    scheduleCron('appointment-reminder', '0 8 * * *', async () => {
        try {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const dateString = tomorrow.toISOString().split('T')[0];

            const upcomingAppointments = await prisma.appointments.findMany({
                where: {
                    date: new Date(dateString)
                },
                include: {
                    user: { select: CRON_EMAIL_USER_SELECT },
                    appointment_service: true,
                    appointment_service_providers: true
                }
            });

            let sent = 0;
            for (const app of upcomingAppointments) {
                if (app.user?.email) {
                    const lng = emailLngFromUser(app.user);
                    const t = i18next.getFixedT(lng);
                    emitCronEmail({
                        jobId: 'appointment-reminder',
                        templateName: 'service-appointment',
                        variables: {
                            title: t('emails.services.subjects.reminder'),
                            message: t('emails.services.messages.reminder'),
                            service_name: app.appointment_service?.service_name,
                            other_party_name: app.appointment_service_providers?.company_name,
                            date: dateString,
                            time: app.time_from ? new Date(app.time_from).toLocaleTimeString() : 'Scheduled Time'
                        },
                        to: decrypt(app.user.email),
                        subjectKey: 'emails.services.subjects.reminder',
                        user: app.user,
                    });
                    sent += 1;
                }
            }
            console.log(`[Cron appointment-reminder] sent ${sent}/${upcomingAppointments.length} reminder(s)`);
        } catch (err) {
            logCronError('appointment-reminder', err);
        }
    });

    // =========================================================================
    // 7. RENTAL EXPIRY NOTICES
    // =========================================================================
    scheduleCron('rental-expiry', '0 9 * * *', async () => {
        try {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const dateString = tomorrow.toISOString().split('T')[0];

            const expiringRentals = await prisma.rental_order.findMany({
                where: {
                    expire_date: new Date(dateString),
                    ispaid: true
                },
                include: {
                    user: { select: CRON_EMAIL_USER_SELECT },
                    rental_listing: true
                }
            });

            let sent = 0;
            for (const rental of expiringRentals) {
                if (rental.user?.email) {
                    emitCronEmail({
                        jobId: 'rental-expiry',
                        templateName: 'rental-expiry',
                        variables: {
                            item_name: rental.rental_listing?.rental_listing_name,
                            expire_date: dateString,
                            rental_id: rental.order_id
                        },
                        to: decrypt(rental.user.email),
                        subjectKey: 'emails.services.subjects.rental_expiry',
                        user: rental.user,
                    });
                    sent += 1;
                }
            }
            console.log(`[Cron rental-expiry] sent ${sent}/${expiringRentals.length} notice(s)`);
        } catch (err) {
            logCronError('rental-expiry', err);
        }
    });

    // =========================================================================
    // 8. CLEAN UP EXPIRED PASSWORD RESET TOKENS (hourly)
    // =========================================================================
    scheduleCron('password-reset-token-prune', '0 * * * *', async () => {
        try {
            const result = await prisma.password_reset_tokens.deleteMany({
                where: { expires_at: { lt: new Date() } }
            });
            if (result.count > 0) {
                console.log(`[Cron password-reset-token-prune] pruned ${result.count} token(s)`);
            }
        } catch (err) {
            logCronError('password-reset-token-prune', err);
        }
    });

    console.log('[Cron] initGhostDriverCron — 8 schedules registered');
};
