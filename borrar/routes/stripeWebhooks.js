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
  const raw = `${serial}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 8)}`;
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
      process.env.STRIPE_WEBHOOK_SECRET
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

      // Tema/plantilla para Email + PDF (idealmente viene desde Checkout metadata)
      const ticketThemeFromMeta = typeof meta.ticketTheme === 'string' ? meta.ticketTheme.trim() : '';

      console.log('[stripe webhook] metadata =', meta);

      const sessionId = session.id;
      const eventId = meta.eventId || null;
      const userId = meta.userId || null;
      const qtyMeta = meta.qty ? Number(meta.qty) : 1;

      // Email fiable desde Stripe
      const stripeEmail =
        session.customer_details?.email ||
        session.customer_email ||
        null;

      let order = null;
      if (meta.orderId) {
        order = await Order2.findById(meta.orderId);
        if (!order) {
          console.warn(
            '[stripe webhook] orderId en metadata pero no existe en Mongo:',
            meta.orderId
          );
        }
      }

      if (!order) {
        order = await Order2.findOne({ stripeSessionId: sessionId });
      }

      if (!order) {
        console.warn(
          '[stripe webhook] no Order found for session, creating on the fly:',
          sessionId
        );

        const amountTotal = typeof session.amount_total === 'number'
          ? session.amount_total
          : null;

        order = await Order2.create({
          stripeSessionId: sessionId,
          paymentIntentId: session.payment_intent || null,
          userId: userId || null,
          eventId: eventId,
          clubId: meta.clubId || null,
          qty: qtyMeta,
          amountEUR: amountTotal ? amountTotal / 100 : undefined,
          currency: session.currency || 'eur',
          email: stripeEmail,
          status: 'paid',
          sessionMetadata: meta,
        });
      } else {
        // Order existente: idempotencia
        if (order.status === 'paid') {
          console.log('[stripe webhook] order already paid:', order._id);
          return res.json({ ok: true });
        }
        order.status = 'paid';
        order.paymentIntentId = session.payment_intent || order.paymentIntentId;
        order.email = order.email || stripeEmail || order.email;
        await order.save();
      }

      const usedQty = order.qty || qtyMeta || 1;

      // --- Actualizar contador ticketsSold ---
      const evt = await Event2.findById(eventId).lean();

      // Fallback: si Stripe metadata no trae ticketTheme, lo leemos del evento
      const ticketThemeFromEvent = typeof evt?.ticketTheme === 'string' ? evt.ticketTheme.trim() : '';
      const ticketThemeResolved = ticketThemeFromMeta || ticketThemeFromEvent || 'default';
      console.log('[stripe webhook] ticketTheme resolved =', {
        fromMeta: ticketThemeFromMeta,
        fromEvent: ticketThemeFromEvent,
        final: ticketThemeResolved,
      });

      if (evt && evt.capacity && evt.capacity > 0) {
        await Event2.updateOne(
          {
            _id: eventId,
            $expr: {
              $lte: [
                '$ticketsSold',
                { $subtract: ['$capacity', usedQty] },
              ],
            },
          },
          { $inc: { ticketsSold: usedQty } }
        );
      } else {
        await Event2.updateOne(
          { _id: eventId },
          { $inc: { ticketsSold: usedQty } }
        );
      }

      // --- Generar tickets ---
      const created = [];
      for (let i = 0; i < usedQty; i++) {
        const serial = genSerial();
        const token = makeToken(serial);
        const tokenHash = crypto
          .createHash('sha256')
          .update(token)
          .digest('hex');
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
          email: order.email || stripeEmail,
          serial,
          tokenHash,
          status: 'issued',
        });

        created.push({ doc: t, qrPngBuffer });
      }

      // --- Enviar email (1 SOLO correo con N entradas) ---
      try {
        const freshEvt = evt || (await Event2.findById(eventId).lean());
        const clubName =
          freshEvt?.clubName || freshEvt?.club?.entityName || '';
        const venue = freshEvt?.locationName || freshEvt?.venue || '';
        const eventDate = freshEvt?.startAt
          ? new Date(freshEvt.startAt).toLocaleString('es-ES', {
              dateStyle: 'medium',
              timeStyle: 'short',
            })
          : '';

        const toEmail = order.email || stripeEmail;
        if (!toEmail) {
          console.warn('[stripe webhook] No email found in order/session; skipping email send.', {
            orderId: String(order._id),
            sessionId,
          });
        } else {
          // Nuevo payload: lista de tickets para PDF multipase (1 email, 1 PDF con N entradas)
          const tickets = created.map((x) => ({
            serial: x.doc.serial,
            qrPngBuffer: x.qrPngBuffer,
          }));

          console.log(
            '[stripe webhook] sending ticket email to',
            toEmail,
            'qty=',
            tickets.length
          );

          await sendTicketEmail({
            to: toEmail,
            eventTitle: freshEvt?.title || 'Entrada NightVibe',
            clubName,
            eventDate,
            venue,

            // ✅ NUEVO: todos los tickets
            tickets,

            // ✅ Retrocompatibilidad (por si sendTicketEmail aún espera 1)
            serial: tickets[0]?.serial,
            qrPngBuffer: tickets[0]?.qrPngBuffer,

            ticketTheme: ticketThemeResolved,
            buyerName: '',
          });
        }
      } catch (e) {
        console.error('Email ticket error:', e);
      }
    }

    // ---- Refunds / cancelaciones ----
    if (
      event.type === 'charge.refunded' ||
      event.type === 'payment_intent.canceled'
    ) {
      const pi = event.data.object;
      await Order2.updateOne(
        { paymentIntentId: pi.id },
        { $set: { status: 'refunded' } }
      );
      // TODO: invalidar tickets si hace falta
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).send('Webhook handler failed');
  }
});

module.exports = router2;
