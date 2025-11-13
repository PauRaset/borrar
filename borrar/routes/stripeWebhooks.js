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
const stripe2 = new Stripe2(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

function genSerial() {
  const a = crypto.randomBytes(2).toString('hex').toUpperCase();
  const b = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `NV-${a}-${b}`;
}

function makeToken(serial) {
  const raw = `${serial}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const sig = crypto
    .createHmac('sha256', process.env.QR_HMAC_KEY || 'nv_dev')
    .update(raw)
    .digest('hex')
    .slice(0, 16);
  return `${raw}.${sig}`;
}

router2.post('/', express2.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe2.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET   // 👈 usamos el webhook de "Your Account"
    );
  } catch (e) {
    console.error('Webhook signature failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try {
    console.log('[stripe webhook] type =', event.type);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const meta = session.metadata || {};

      console.log('[stripe webhook] metadata:', meta);

      // --- Resolución robusta de la Order ---
      let orderId = meta.orderId || null;
      let eventId = meta.eventId || null;
      let userId = meta.userId || null;
      let order = null;

      // 1) Buscar por orderId
      if (orderId) {
        order = await Order2.findById(orderId);
        if (order) console.log('[stripe webhook] matched by orderId', orderId);
      }

      // 2) Si no, buscar por stripeSessionId
      if (!order) {
        order = await Order2.findOne({ stripeSessionId: session.id });
        if (order) {
          console.log('[stripe webhook] matched by sessionId', session.id, '->', order._id);
          orderId = String(order._id);
          eventId = eventId || String(order.eventId);
          userId = userId || String(order.userId);
        }
      }

      if (!order) {
        console.warn('[stripe webhook] order not found for session', session.id, 'meta=', meta);
        return res.json({ ok: true });
      }

      if (order.status === 'paid') {
        console.log('[stripe webhook] order already paid', orderId);
        return res.json({ ok: true }); // idempotencia
      }

      // --- Actualizar orden ---
      order.status = 'paid';
      order.paymentIntentId = session.payment_intent;
      order.email =
        order.email ||
        session.customer_details?.email ||
        session.customer_email ||
        order.email;
      await order.save();

      const evt = await Event2.findById(eventId).lean();

      // --- Actualizar ticketsSold ---
      const qty = order.qty || order.totalTickets || 1;
      if (evt && evt.capacity && evt.capacity > 0) {
        await Event2.updateOne(
          {
            _id: eventId,
            $expr: {
              $lte: ['$ticketsSold', { $subtract: ['$capacity', qty] }],
            },
          },
          { $inc: { ticketsSold: qty } }
        );
      } else {
        await Event2.updateOne({ _id: eventId }, { $inc: { ticketsSold: qty } });
      }

      // --- Generar tickets ---
      const created = [];
      for (let i = 0; i < qty; i++) {
        const serial = genSerial();
        const token = makeToken(serial);
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const qrPayload = JSON.stringify({ serial, token });
        const qrPngBuffer = await QRCode.toBuffer(qrPayload, {
          type: 'png',
          scale: 6,
          margin: 1,
        });

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

      // --- Enviar email ---
      try {
        const clubName = evt?.clubName || evt?.club?.entityName || '';
        const venue = evt?.locationName || evt?.venue || '';
        const eventDate = evt?.startAt
          ? new Date(evt.startAt).toLocaleString('es-ES', {
              dateStyle: 'medium',
              timeStyle: 'short',
            })
          : '';

        console.log('[stripe webhook] sending email to', order.email);

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

    // Refunds / cancelaciones
    if (
      event.type === 'charge.refunded' ||
      event.type === 'payment_intent.canceled'
    ) {
      const pi = event.data.object;
      await Order2.updateOne(
        { paymentIntentId: pi.id },
        { $set: { status: 'refunded' } }
      );
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).send('Webhook handler failed');
  }
});

module.exports = router2;
