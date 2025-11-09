// routes/stripeWebhooks.js
const express2 = require('express');
const Stripe2 = require('stripe');
const crypto = require('crypto');
const QRCode = require('qrcode');
const Order2 = require('../models/Order');
const Event2 = require('../models/Event');
const Ticket = require('../models/Ticket');
const sendTicketEmail = require('../utils/sendTicketEmail');

const router2 = express2.Router();
const stripe2 = new Stripe2(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

function genSerial() {
  const a = crypto.randomBytes(2).toString('hex').toUpperCase();
  const b = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `NV-${a}-${b}`;
}

function makeToken(serial) {
  const raw = `${serial}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const sig = crypto.createHmac('sha256', process.env.QR_HMAC_KEY || 'nv_dev').update(raw).digest('hex').slice(0, 16);
  return `${raw}.${sig}`;
}

router2.post('/', express2.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe2.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Webhook signature failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { orderId, eventId, userId } = session.metadata || {};
      if (!orderId) return res.json({ ok: true });

      const order = await Order2.findById(orderId);
      if (!order) return res.json({ ok: true });
      if (order.status === 'paid') return res.json({ ok: true }); // idempotencia

      order.status = 'paid';
      order.paymentIntentId = session.payment_intent;
      order.email = order.email || session.customer_details?.email || session.customer_email || order.email;
      await order.save();

      const evt = await Event2.findById(eventId).lean();

      // Actualiza contador ticketsSold de forma atómica (si hay capacity)
      if (evt && evt.capacity && evt.capacity > 0) {
        await Event2.updateOne(
          { _id: eventId, $expr: { $lte: ['$ticketsSold', { $subtract: ['$capacity', order.qty || 1] }] } },
          { $inc: { ticketsSold: order.qty || 1 } }
        );
      } else {
        await Event2.updateOne({ _id: eventId }, { $inc: { ticketsSold: order.qty || 1 } });
      }

      // Genera tickets
      const created = [];
      for (let i = 0; i < (order.qty || 1); i++) {
        const serial = genSerial();
        const token = makeToken(serial);
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const qrPayload = JSON.stringify({ serial, token });
        const qrPngBuffer = await QRCode.toBuffer(qrPayload, { type: 'png', scale: 6, margin: 1 });

        const t = await Ticket.create({
          eventId,
          orderId: order._id,
          ownerUserId: userId,
          email: order.email,
          serial,
          tokenHash,
          status: 'issued',
        });
        created.push({ doc: t, qrPngBuffer });
      }

      // Enviar email (un único PDF con el primer QR; si quieres 1 por ticket, iterar)
      try {
        const clubName = evt?.clubName || evt?.club?.entityName || '';
        const venue = evt?.locationName || evt?.venue || '';
        const eventDate = evt?.startAt ? new Date(evt.startAt).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }) : '';

        await sendTicketEmail({
          to: order.email,
          eventTitle: evt?.title || 'Entrada NightVibe',
          clubName,
          eventDate,
          venue,
          serial: created[0]?.doc?.serial,
          qrPngBuffer: created[0]?.qrPngBuffer,
          buyerName: '',
        });
      } catch (e) {
        console.error('Email ticket error:', e);
      }
    }

    // (Opcional) refunds/cancellations
    if (event.type === 'charge.refunded' || event.type === 'payment_intent.canceled') {
      const pi = event.data.object;
      await Order2.updateOne({ paymentIntentId: pi.id }, { $set: { status: 'refunded' } });
      // TODO: invalidar tickets relacionados si procede
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).send('Webhook handler failed');
  }
});

module.exports = router2;
