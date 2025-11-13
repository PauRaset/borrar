// routes/payments.js
const express = require('express');
const Stripe = require('stripe');
const Order = require('../models/Order');
const Event = require('../models/Event');
const Club = require('../models/Club');

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

const toCents = (n) => Math.round(Number(n) * 100);

// POST /api/payments/create-checkout-session
router.post('/create-checkout-session', async (req, res) => {
  try {
    const { eventId, userId, qty = 1, email } = req.body || {};
    if (!eventId || !userId) {
      return res.status(400).json({ error: 'Faltan eventId o userId' });
    }

    const event = await Event.findById(eventId).lean();
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });

    // Ventana de venta y publicación
    const now = new Date();
    if (event.isPublished === false) {
      return res.status(400).json({ error: 'Evento no publicado' });
    }
    if (event.salesStart && now < new Date(event.salesStart)) {
      return res.status(400).json({ error: 'Venta no iniciada' });
    }
    if (event.salesEnd && now > new Date(event.salesEnd)) {
      return res.status(400).json({ error: 'Venta finalizada' });
    }

    const unit = Number(event.price || event.priceEUR || 0);
    if (!unit || unit < 0) {
      return res.status(400).json({ error: 'Precio inválido' });
    }

    // Stock (capacity 0 = sin límite)
    const nQty = Math.max(1, Number(qty));
    if (event.capacity && event.capacity > 0) {
      if ((event.ticketsSold || 0) + nQty > event.capacity) {
        return res.status(409).json({ error: 'Sin stock suficiente' });
      }
    }

    // === Stripe Connect: cuenta del club y comisión de plataforma ===
    const clubId = event.clubId || event.club || event.organizerId || null;
    if (!clubId) {
      return res.status(400).json({
        error: 'club_not_set',
        message: 'El evento no tiene club asociado.',
      });
    }

    const club = await Club.findById(clubId).lean();
    if (!club || !club.stripeAccountId) {
      return res.status(400).json({
        error: 'club_without_connect',
        message: 'El club no tiene cuenta conectada en Stripe (LIVE).',
      });
    }

    // Comisión fija: 1,50 € por entrada
    const PLATFORM_FEE_CENTS = 150;
    const applicationFee = PLATFORM_FEE_CENTS * nQty;

    // Crea orden pendiente
    const order = await Order.create({
      userId,
      eventId,
      clubId,
      qty: nQty,
      amountEUR: unit * nQty,
      currency: 'eur',
      email: email || null,
      status: 'pending', // lo ajustamos en el schema para que sea válido
      applicationFeeCents: applicationFee,
      destinationAccount: club.stripeAccountId,
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      locale: 'es',
      currency: 'eur',
      line_items: [
        {
          price_data: {
            currency: 'eur',
            unit_amount: toCents(unit),
            product_data: {
              name: event.title || 'Entrada NightVibe',
              metadata: { eventId: String(event._id) },
            },
          },
          quantity: nQty,
        },
      ],
      success_url: `${process.env.APP_BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}&eventId=${eventId}`,
      cancel_url: `${process.env.APP_BASE_URL}/event/${eventId}?cancelled=1`,
      metadata: {
        eventId: String(event._id),
        orderId: String(order._id),   // 👈 clave para el webhook
        userId: String(userId),
        clubId: String(clubId),
      },
      customer_email: email || undefined,
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      payment_intent_data: {
        application_fee_amount: applicationFee,
        transfer_data: { destination: club.stripeAccountId },
        on_behalf_of: club.stripeAccountId,
      },
    });

    // Guarda el id de sesión para fallback en el webhook
    order.stripeSessionId = session.id;
    await order.save();

    console.log('♦♦  Created Checkout Session:', {
      clubId: String(clubId),
      destinationAccount: club.stripeAccountId,
      applicationFee,
      sessionId: session.id,
      orderId: String(order._id),
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('[create-checkout-session] error', err);
    return res.status(500).json({ error: 'No se pudo crear la sesión' });
  }
});

module.exports = router;
