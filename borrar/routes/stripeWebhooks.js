// routes/stripeWebhooks.js
const express2 = require('express');
const Stripe2 = require('stripe');
const crypto = require('crypto');
const QRCode = require('qrcode');
const Order2 = require('../models/Order');
const Event2 = require('../models/Event');
const Ticket = require('../models/Ticket');
const sendTicketEmail = require('../utils/sendTicketEmail');
const bodyParser = require('body-parser');

// Util de log seguro
function slog(label, obj) {
  try { console.log(label, JSON.stringify(obj)); } catch { console.log(label, obj); }
}

async function issueTicketsAndEmail({ session, order, evt, userId }) {
  // Actualiza contador de tickets
  if (evt && evt.capacity && evt.capacity > 0) {
    await Event2.updateOne(
      { _id: evt._id, $expr: { $lte: ['$ticketsSold', { $subtract: ['$capacity', order.qty || 1] }] } },
      { $inc: { ticketsSold: order.qty || 1 } }
    );
  } else if (evt) {
    await Event2.updateOne({ _id: evt._id }, { $inc: { ticketsSold: order.qty || 1 } });
  }

  // Genera tickets y QR
  const created = [];
  for (let i = 0; i < (order.qty || 1); i++) {
    const serial = genSerial();
    const token = makeToken(serial);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const qrPayload = JSON.stringify({ serial, token });
    const qrPngBuffer = await QRCode.toBuffer(qrPayload, { type: 'png', scale: 6, margin: 1 });

    const t = await Ticket.create({
      eventId: order.eventId || session?.metadata?.eventId,
      orderId: order._id,
      ownerUserId: userId,
      email: order.email,
      serial,
      tokenHash,
      status: 'issued',
    });
    created.push({ doc: t, qrPngBuffer });
  }

  // Email
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

router2.post('/', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  const platformSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const connectSecret  = process.env.STRIPE_WEBHOOK_SECRET_CONNECT;
  try {
    // Primero intentamos con el secreto de plataforma
    event = stripe2.webhooks.constructEvent(req.body, sig, platformSecret);
  } catch (e1) {
    // Si falla y tenemos secreto de connect, probamos con ese
    if (connectSecret) {
      try {
        event = stripe2.webhooks.constructEvent(req.body, sig, connectSecret);
      } catch (e2) {
        console.error('Webhook signature failed (both secrets):', e1.message, ' // ', e2.message);
        return res.status(400).send('Webhook Error: invalid signature');
      }
    } else {
      console.error('Webhook signature failed (platform secret):', e1.message);
      return res.status(400).send('Webhook Error: invalid signature');
    }
  }

  try {
    slog('[stripe webhook] type:', { type: event.type });

    const handleSessionPaid = async (session) => {
      const { orderId, eventId, userId } = session.metadata || {};
      if (!orderId) return;

      const order = await Order2.findById(orderId);
      if (!order) return;
      if (order.status === 'paid') return; // idempotencia

      order.status = 'paid';
      order.paymentIntentId = session.payment_intent || order.paymentIntentId;

      // email del comprador (fallbacks)
      order.email = order.email || session.customer_details?.email || session.customer_email || order.email;
      if (!order.email && session.customer) {
        try {
          const cust = await stripe2.customers.retrieve(session.customer);
          if (!cust.deleted) order.email = cust.email || order.email;
        } catch {}
      }
      await order.save();

      const evt = await Event2.findById(eventId).lean();
      await issueTicketsAndEmail({ session, order, evt, userId });
    };

    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      await handleSessionPaid(event.data.object);
    }

    if (event.type === 'payment_intent.succeeded') {
      // Fallback por si el session.completed no llegó pero sí el PI
      const pi = event.data.object;
      if (pi?.metadata?.orderId) {
        const order = await Order2.findById(pi.metadata.orderId);
        if (order && order.status !== 'paid') {
          const sessionId = order.stripeSessionId;
          let session = null;
          try { session = sessionId ? await stripe2.checkout.sessions.retrieve(sessionId) : null; } catch {}
          const fakeSession = session || { metadata: pi.metadata, payment_intent: pi.id, customer: pi.customer };
          await handleSessionPaid(fakeSession);
        }
      }
    }

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
