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

// Permite precios con coma o punto, y acepta formatos como "12,50", "12.50", "12,50€", " 12.50 € "
const parsePrice = (value) => {
  if (value === null || value === undefined) return null;

  // Si ya es número, lo devolvemos tal cual si es finito
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  let str = String(value).trim();
  if (!str) return null;

  // Quitamos símbolo de euro y espacios
  str = str.replace(/[€\s]/g, '');

  // Normalizamos coma a punto (ej: "12,50" -> "12.50")
  str = str.replace(',', '.');

  const n = Number(str);
  if (!Number.isFinite(n)) return null;
  return n;
};

const toCents = (n) => {
  const parsed = parsePrice(n);
  if (parsed === null) return NaN;
  return Math.round(parsed * 100);
};


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
  
      // --- Precio: soporta decimales con punto o coma ("12,50", "12.50", etc.) ---
      const rawPrice =
        event.price !== undefined && event.price !== null && event.price !== ''
          ? event.price
          : event.priceEUR;

      const unit = parsePrice(rawPrice);

      if (unit === null || !Number.isFinite(unit) || unit <= 0) {
        console.error('[direct] Precio inválido en /direct:', {
          rawPrice,
          eventPrice: event.price,
          eventPriceEUR: event.priceEUR,
        });
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
        return res.status(400).send('El evento no tiene club asociado.');
      }
  
      const club = await Club.findById(clubId).lean();
      if (!club || !club.stripeAccountId) {
        return res
          .status(400)
          .send('El club no tiene cuenta conectada en Stripe (LIVE).');
      }
  
      // Comisión de plataforma por entrada:
      // - Por defecto: 1,50 €
      // - Si el evento tiene `platformFeeEUR`, se usa ese valor (en euros)
      const platformFeeEUR =
        typeof event.platformFeeEUR === 'number'
          ? event.platformFeeEUR
          : 1.5;

      const PLATFORM_FEE_CENTS = Math.round(platformFeeEUR * 100);
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
  
      // ==== Cartel / imagen del evento para Stripe Checkout ====
      // ==== Cartel / imagen del evento para Stripe Checkout ====
      let eventImageUrl = null;

      // Función auxiliar para montar una URL absoluta desde una ruta relativa
      const buildAbsoluteImageUrl = (relativePath) => {
        if (!relativePath) return null;

        // si ya es absoluta, la devolvemos tal cual
        if (/^https?:\/\//.test(relativePath)) return relativePath;

        // nos aseguramos de que empieza por '/'
        let cleanPath = relativePath;
        if (!cleanPath.startsWith('/')) {
          cleanPath = '/' + cleanPath;
        }

        // base URL: env o dominio actual del backend
        const base =
          process.env.PUBLIC_UPLOADS_BASE_URL ||
          `${req.protocol}://${req.get('host')}`;

        return `${base}${cleanPath}`;
      };

      // 1) Intentamos con event.image
      if (event.image) {
        eventImageUrl = buildAbsoluteImageUrl(event.image);
      }

      // 2) Si no hay, probamos con la primera foto de event.photos
      if (
        !eventImageUrl &&
        Array.isArray(event.photos) &&
        event.photos.length > 0 &&
        event.photos[0]
      ) {
        eventImageUrl = buildAbsoluteImageUrl(event.photos[0]);
      }
  
      // Descripción opcional para Stripe
      const descriptionParts = [];
      if (event.city) descriptionParts.push(event.city);
      if (event.date) descriptionParts.push(new Date(event.date).toLocaleDateString('es-ES'));
      const productDescription =
        descriptionParts.length > 0
          ? descriptionParts.join(' • ')
          : 'Entrada para evento NightVibe';
  
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
                description: productDescription,
                // 👇 solo añadimos images si tenemos una URL válida
                ...(eventImageUrl ? { images: [eventImageUrl] } : {}),
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
        automatic_tax: { enabled: false },
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
