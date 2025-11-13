// routes/stripeWebhooks.js
const express = require('express');
const Stripe = require('stripe');
const crypto = require('crypto');
const QRCode = require('qrcode');
const Order = require('../models/Order');
const Event = require('../models/Event');
const Ticket = require('../models/Ticket');
const sendTicketEmail = require('../utils/sendTicketEmail');

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

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

router.post(
  '/',
  // MUY IMPORTANTE: raw body para Stripe
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (e) {
      console.error('[stripe webhook] signature failed:', e.message);
      return res.status(400).send(`Webhook Error: ${e.message}`);
    }

    console.log('[stripe webhook] type:', event.type);

    try {
      // =========================================================
      // checkout.session.completed  -> generar tickets + email
      // =========================================================
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const { orderId, eventId, userId } = session.metadata || {};

        console.log('[stripe webhook] session.id:', session.id);
        console.log('[stripe webhook] metadata:', { orderId, eventId, userId });

        if (!orderId) {
          console.warn('[stripe webhook] checkout.completed sin orderId -> nada que hacer');
          return res.json({ received: true });
        }

        let order = await Order.findById(orderId);
        if (!order) {
          console.warn('[stripe webhook] order no encontrada para orderId=', orderId);
          return res.json({ received: true });
        }

        if (order.status === 'paid') {
          console.log('[stripe webhook] orden ya marcada como paid, saliendo (idempotente).');
          return res.json({ received: true });
        }

        // ==== Actualizamos order con datos reales de Stripe ====
        const sessionEmail =
          session.customer_details?.email ||
          session.customer_email ||
          null;

        order.status = 'paid';
        order.paymentIntentId = session.payment_intent || order.paymentIntentId || null;
        order.email = order.email || sessionEmail;

        await order.save();
        console.log('[stripe webhook] order actualizada:', {
          id: order._id.toString(),
          status: order.status,
          email: order.email,
          qty: order.qty,
        });

        // ==== Cargar evento y actualizar ticketsSold ====
        const evt = eventId ? await Event.findById(eventId).lean() : null;

        if (evt) {
          const qty = order.qty || 1;
          if (evt.capacity && evt.capacity > 0) {
            await Event.updateOne(
              {
                _id: evt._id,
                $expr: {
                  $lte: [
                    '$ticketsSold',
                    { $subtract: ['$capacity', qty] },
                  ],
                },
              },
              { $inc: { ticketsSold: qty } }
            );
          } else {
            await Event.updateOne({ _id: evt._id }, { $inc: { ticketsSold: qty } });
          }
        }

        // ==== Generar tickets ====
        const created = [];
        const ticketsQty = order.qty || 1;

        console.log('[stripe webhook] generando tickets:', ticketsQty);

        for (let i = 0; i < ticketsQty; i++) {
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

        console.log('[stripe webhook] tickets creados:', created.map(c => c.doc.serial));

        // ==== Enviar email de tickets ====
        const to = order.email;

        if (!to) {
          console.warn(
            '[stripe webhook] SIN EMAIL -> no se puede enviar ticket. sessionEmail=',
            sessionEmail
          );
        } else {
          try {
            const evtTitle = evt?.title || 'Entrada NightVibe';
            const clubName = evt?.clubName || evt?.club?.entityName || '';
            const venue = evt?.locationName || evt?.venue || '';
            const eventDate = evt?.startAt
              ? new Date(evt.startAt).toLocaleString('es-ES', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })
              : '';

            console.log('[stripe webhook] enviando mail de ticket a:', to);

            await sendTicketEmail({
              to,
              eventTitle: evtTitle,
              clubName,
              eventDate,
              venue,
              serial: created[0]?.doc?.serial,
              qrPngBuffer: created[0]?.qrPngBuffer,
              buyerName: '',
            });

            console.log('[stripe webhook] email de ticket enviado OK');
          } catch (e) {
            console.error('[stripe webhook] ERROR al enviar email de ticket:', e);
          }
        }
      }

      // =========================================================
      // charge.refunded / payment_intent.canceled  -> marcar refund
      // =========================================================
      if (
        event.type === 'charge.refunded' ||
        event.type === 'payment_intent.canceled'
      ) {
        const pi = event.data.object;
        console.log('[stripe webhook] marcando refund para PI:', pi.id);
        await Order.updateOne(
          { paymentIntentId: pi.id },
          { $set: { status: 'refunded' } }
        );
      }

      return res.json({ received: true });
    } catch (err) {
      console.error('[stripe webhook] handler error:', err);
      return res.status(500).send('Webhook handler failed');
    }
  }
);

module.exports = router;
