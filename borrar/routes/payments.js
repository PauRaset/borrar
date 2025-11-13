// routes/payments.js
const express = require('express');
const Stripe = require('stripe');
const Order = require('../models/Order');
const Event = require('../models/Event');
const Club = require('../models/Club');

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const toCents = (n) => Math.round(Number(n) * 100);

/*// POST /api/payments/create-checkout-session
router.post('/create-checkout-session', async (req, res) => {
  try {
    const { eventId, userId, qty = 1, email, phone } = req.body || {};
    if (!eventId || !userId) {
      return res.status(400).json({ error: 'Faltan eventId o userId' });
    }

    const event = await Event.findById(eventId).lean();
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });

    // Ventana de venta y publicación
    const now = new Date();
    if (event.isPublished === false)
      return res.status(400).json({ error: 'Evento no publicado' });
    if (event.salesStart && now < new Date(event.salesStart))
      return res.status(400).json({ error: 'Venta no iniciada' });
    if (event.salesEnd && now > new Date(event.salesEnd))
      return res.status(400).json({ error: 'Venta finalizada' });

    const unit = Number(event.price || event.priceEUR || 0);
    if (!unit || unit < 0)
      return res.status(400).json({ error: 'Precio inválido' });

    // Stock (capacity 0 = sin límite)
    const nQty = Math.max(1, Number(qty));
    if (event.capacity && event.capacity > 0) {
      if ((event.ticketsSold || 0) + nQty > event.capacity) {
        return res.status(409).json({ error: 'Sin stock suficiente' });
      }
    }

    // === Stripe Connect: cuenta del club y comisión fija ===
    const clubId = event.clubId || event.club || event.organizerId || null;
    if (!clubId) {
      return res
        .status(400)
        .json({ error: 'club_not_set', message: 'El evento no tiene club asociado.' });
    }

    const club = await Club.findById(clubId).lean();
    if (!club || !club.stripeAccountId) {
      return res.status(400).json({
        error: 'club_without_connect',
        message: 'El club no tiene cuenta conectada en Stripe (LIVE).',
      });
    }

    // Comisión fija de plataforma: 1,50 € por entrada
    const PLATFORM_FEE_CENTS = 150;
    const applicationFee = PLATFORM_FEE_CENTS * nQty;

    // 1) Crear Order en estado pending/created
    const order = await Order.create({
      userId,
      eventId,
      clubId,
      qty: nQty,
      amountEUR: unit * nQty,
      currency: 'eur',
      email: email || null,
      phone: phone || null,
      status: 'created',
    });

    // 2) Crear Checkout Session
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
        orderId: String(order._id),   // 👈 CLAVE
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

    // 3) Guardar referencia de sesión en la Order
    order.stripeSessionId = session.id;
    order.sessionMetadata = session.metadata || {};
    await order.save();

    console.log('◆ Created Checkout Session:', {
      orderId: String(order._id),
      sessionId: session.id,
      email,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('[create-checkout-session] error', err);
    return res.status(500).json({ error: 'No se pudo crear la sesión' });
  }
});*/

// GET /api/payments/direct/:eventId
// Enlace estable que puedes compartir (no caduca).
// Crea la sesión de Checkout y hace redirect 303 a Stripe.
router.get('/direct/:eventId', async (req, res) => {
    try {
      const { eventId } = req.params;
  
      const event = await Event.findById(eventId).lean();
      if (!event) {
        return res.status(404).send('Evento no encontrado');
      }
  
      // Misma lógica de validaciones que en create-checkout-session
      const now = new Date();
      if (event.isPublished === false) {
        return res.status(400).send('Evento no publicado');
      }
      if (event.salesStart && now < new Date(event.salesStart)) {
        return res.status(400).send('La venta todavía no ha empezado');
      }
      if (event.salesEnd && now > new Date(event.salesEnd)) {
        return res.status(400).send('La venta ya ha finalizado');
      }
  
      const unit = Number(event.price || event.priceEUR || 0);
      if (!unit || unit < 0) {
        return res.status(400).send('Precio inválido');
      }
  
      const qty = 1;
  
      // Stock (capacity 0 = sin límite)
      if (event.capacity && event.capacity > 0) {
        if ((event.ticketsSold || 0) + qty > event.capacity) {
          return res.status(409).send('Sin stock suficiente');
        }
      }
  
      // === Stripe Connect: misma lógica que en create-checkout-session ===
      const clubId = event.clubId || event.club || event.organizerId || null;
      if (!clubId) {
        return res
          .status(400)
          .send('El evento no tiene club asociado.');
      }
  
      const club = await Club.findById(clubId).lean();
      if (!club || !club.stripeAccountId) {
        return res
          .status(400)
          .send('El club no tiene cuenta conectada en Stripe (LIVE).');
      }
  
      // Comisión fija de plataforma: 1,50 € por entrada
      const PLATFORM_FEE_CENTS = 150;
      const applicationFee = PLATFORM_FEE_CENTS * qty;
  
      // Order "guest": sin userId ni email (Stripe nos dará el email)
      const order = await Order.create({
        userId: null,
        eventId,
        clubId,
        qty,
        amountEUR: unit * qty,
        currency: 'eur',
        email: null,
        status: 'created',
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
            quantity: qty,
          },
        ],
        // Mismo success/cancel que el flujo normal
        success_url: `${process.env.APP_BASE_URL}/purchase/success?sid={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.APP_BASE_URL}/event/${eventId}?cancelled=1`,
        metadata: {
          eventId: String(event._id),
          orderId: String(order._id),
          userId: '', // invitado
          clubId: String(clubId),
        },
        allow_promotion_codes: true,
        automatic_tax: { enabled: true },
        payment_intent_data: {
          application_fee_amount: applicationFee,
          transfer_data: { destination: club.stripeAccountId },
          on_behalf_of: club.stripeAccountId,
        },
      });
  
      order.stripeSessionId = session.id;
      order.sessionMetadata = session.metadata || {};
      await order.save();
  
      console.log('◆ [direct] Created Checkout Session:', {
        orderId: String(order._id),
        sessionId: session.id,
      });
  
      // Redirige al Checkout de Stripe
      return res.redirect(303, session.url);
    } catch (err) {
      console.error('[direct-checkout] error:', err?.raw || err);
      const msg = err?.raw?.message || 'No se pudo iniciar el pago';
      return res.status(500).send(msg);
    }
  });

module.exports = router;
