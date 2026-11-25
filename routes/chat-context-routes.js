import express from 'express';
import { authenticateToken } from '../middleware/authentication.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { sendChatError } from '../services/chat-service.js';
import {
  openFoodConversation,
  openJobApplicationConversation,
  openProductOrderConversation,
  openRentalConversation,
  openRideConversation,
  openServiceConversation,
  openSupportConversation,
  openWorkJobConversation,
} from '../services/chat-context-service.js';

const router = express.Router();

function contextRoute(handler) {
  return async (req, res) => {
    try {
      const result = await handler(req);
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) {
      sendChatError(res, err, 'Failed to open contextual conversation');
    }
  };
}

router.post('/rideshare/:ride_request_id', authenticateToken, contextRoute((req) =>
  openRideConversation({ rideRequestId: req.params.ride_request_id, userId: req.user.user_id })
));

router.post('/food/:order_id', authenticateToken, contextRoute((req) =>
  openFoodConversation({ orderId: req.params.order_id, userId: req.user.user_id })
));

router.post('/services/:order_id', authenticateToken, contextRoute((req) =>
  openServiceConversation({ orderId: req.params.order_id, userId: req.user.user_id })
));

router.post('/marketplace/rental/:order_id', authenticateToken, contextRoute((req) =>
  openRentalConversation({ orderId: req.params.order_id, userId: req.user.user_id })
));

router.post('/shop/:order_id', authenticateToken, contextRoute((req) =>
  openProductOrderConversation({ orderId: req.params.order_id, userId: req.user.user_id })
));

router.post('/ondemand/:job_id', authenticateToken, contextRoute((req) =>
  openWorkJobConversation({ jobId: req.params.job_id, userId: req.user.user_id })
));

router.post('/job-application/:application_id', authenticateToken, contextRoute((req) =>
  openJobApplicationConversation({
    applicationId: req.params.application_id,
    userId: req.user.user_id,
  })
));

router.post('/support/:ticket_id', authenticateToken, requireAdmin, contextRoute((req) =>
  openSupportConversation({
    ticketId: req.params.ticket_id,
    customerUserId: req.body.customer_user_id,
    agentUserId: req.user.user_id,
  })
));

export default router;
