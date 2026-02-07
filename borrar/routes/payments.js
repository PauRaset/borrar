/*// routes/payments.js
const express = require('express');
const Stripe = require('stripe');
const Order = require('../models/Order');
const Event = require('../models/Event');
const Club = require('../models/Club');
const User = require('../models/User');

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

// Selección de tema/plantilla para Email + PDF de entradas (se consume en el webhook)
// Nota: esto NO cambia el flujo de pago; solo añade metadata para que el webhook
// pueda decidir qué estética/plantilla aplicar.
const resolveTicketTheme = ({ event, club }) => {
  // 1) Si en el futuro guardas un tema en el evento, lo respetamos
  const eventTheme = event && typeof event.ticketTheme === 'string' ? event.ticketTheme.trim() : '';
  if (eventTheme) return eventTheme;

  // 2) Forzar tema para una cuenta concreta vía ENV (clubId o stripeAccountId)
  // Ejemplos:
  // - TICKET_THEME_CLUB_ID=655e... (Mongo ObjectId)
  // - TICKET_THEME_STRIPE_ACCOUNT_ID=acct_...
  // - TICKET_THEME_NAME=clubX
  const THEME_NAME = (process.env.TICKET_THEME_NAME || 'clubX').trim();
  const THEME_CLUB_ID = (process.env.TICKET_THEME_CLUB_ID || '').trim();
  const THEME_STRIPE_ACCOUNT_ID = (process.env.TICKET_THEME_STRIPE_ACCOUNT_ID || '').trim();

  if (THEME_CLUB_ID && String(club?._id || '') === THEME_CLUB_ID) return THEME_NAME;
  if (THEME_STRIPE_ACCOUNT_ID && String(club?.stripeAccountId || '') === THEME_STRIPE_ACCOUNT_ID) {
    return THEME_NAME;
  }

  // 3) Default
  return 'default';
};


  // GET /api/payments/direct/:eventId
// Enlace estable que puedes compartir (no caduca).
// Crea la sesión de Checkout y hace redirect 303 a Stripe.
router.get('/direct/:eventId', async (req, res) => {
    try {
      const { eventId } = req.params;

      // === Share tracking (optional, non-breaking) ===
      // You can append these params to the /direct link when sharing:
      //   /api/payments/direct/:eventId?ref=XXXX&ch=ig_story
      // They will be persisted in Stripe session metadata so the webhook can attribute sales.
      const refCodeRaw = typeof req.query.ref === 'string' ? req.query.ref : '';
      const channelRaw = typeof req.query.ch === 'string' ? req.query.ch : '';

      const refCode = refCodeRaw.trim().slice(0, 64); // keep it short & safe
      const shareChannel = channelRaw.trim().slice(0, 64);
  
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
  
      // === Stripe Connect (robusto y retrocompatible) ===
      // IMPORTANTE: en algunos eventos `clubId` puede ser el USER (owner) y `club` puede ser el documento Club.
      // Para no romper eventos antiguos que ya funcionan, resolvemos en este orden:
      // 1) event.club (Club._id)
      // 2) event.clubId (si realmente era un Club._id)
      // 3) Club por ownerUserId (createdBy/clubId/organizerId)
      // 4) Fallback legacy: User.stripeAccountId

      let club = null;
      let clubId = null;

      // 1) Preferimos event.club (si existe)
      if (event.club) {
        club = await Club.findById(event.club).lean();
        if (club) clubId = club._id;
      }

      // 2) Si no, probamos event.clubId como Club._id (eventos antiguos)
      if (!club && event.clubId) {
        club = await Club.findById(event.clubId).lean();
        if (club) clubId = club._id;
      }

      // 3) Si sigue sin salir, probamos por ownerUserId (event.clubId/createdBy suelen ser el USER)
      if (!club) {
        const ownerUserId = event.createdBy || event.clubId || event.organizerId || null;
        if (!ownerUserId) {
          return res.status(400).send('El evento no tiene club asociado.');
        }
        club = await Club.findOne({ ownerUserId }).lean();
        if (club) clubId = club._id;
      }

      // 4) Fallback legacy: stripeAccountId guardado en el usuario
      if (!club || !club.stripeAccountId) {
        const ownerUserId = event.createdBy || event.clubId || event.organizerId || null;
        if (ownerUserId) {
          const user = await User.findById(ownerUserId).lean();
          if (user && user.stripeAccountId) {
            club = { _id: user._id, stripeAccountId: user.stripeAccountId };
            clubId = user._id;
          }
        }
      }

      if (!club || !club.stripeAccountId) {
        console.error('[direct] No se pudo resolver stripeAccountId (LIVE):', {
          eventId: String(event._id),
          eventClub: event.club ? String(event.club) : null,
          eventClubId: event.clubId ? String(event.clubId) : null,
          eventCreatedBy: event.createdBy ? String(event.createdBy) : null,
          eventOrganizerId: event.organizerId ? String(event.organizerId) : null,
        });
        return res.status(400).send('El club no tiene cuenta conectada en Stripe (LIVE).');
      }

      // Tema/plantilla para Email + PDF (se aplicará en el webhook)
      const ticketTheme = resolveTicketTheme({ event, club });
  
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
                metadata: {
                  eventId: String(event._id),
                  ticketTheme,
                  ...(refCode ? { refCode } : {}),
                  ...(shareChannel ? { shareChannel } : {}),
                },
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
          ticketTheme,
          // Share attribution (optional)
          ...(refCode ? { refCode } : {}),
          ...(shareChannel ? { shareChannel } : {}),
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
      order.sessionMetadata = {
        ...(session.metadata || {}),
        ...(refCode ? { refCode } : {}),
        ...(shareChannel ? { shareChannel } : {}),
      };
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

module.exports = router;*/


// routes/payments.js
const express = require('express');
const Stripe = require('stripe');
const Order = require('../models/Order');
const Event = require('../models/Event');
const Club = require('../models/Club');
const User = require('../models/User');
const mongoose = require('mongoose');


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

// Selección de tema/plantilla para Email + PDF de entradas (se consume en el webhook)
// Nota: esto NO cambia el flujo de pago; solo añade metadata para que el webhook
// pueda decidir qué estética/plantilla aplicar.
const resolveTicketTheme = ({ event, club }) => {
  // 1) Si en el futuro guardas un tema en el evento, lo respetamos
  const eventTheme = event && typeof event.ticketTheme === 'string' ? event.ticketTheme.trim() : '';
  if (eventTheme) return eventTheme;

  // 2) Forzar tema para una cuenta concreta vía ENV (clubId o stripeAccountId)
  // Ejemplos:
  // - TICKET_THEME_CLUB_ID=655e... (Mongo ObjectId)
  // - TICKET_THEME_STRIPE_ACCOUNT_ID=acct_...
  // - TICKET_THEME_NAME=clubX
  const THEME_NAME = (process.env.TICKET_THEME_NAME || 'clubX').trim();
  const THEME_CLUB_ID = (process.env.TICKET_THEME_CLUB_ID || '').trim();
  const THEME_STRIPE_ACCOUNT_ID = (process.env.TICKET_THEME_STRIPE_ACCOUNT_ID || '').trim();

  if (THEME_CLUB_ID && String(club?._id || '') === THEME_CLUB_ID) return THEME_NAME;
  if (THEME_STRIPE_ACCOUNT_ID && String(club?.stripeAccountId || '') === THEME_STRIPE_ACCOUNT_ID) {
    return THEME_NAME;
  }

  // 3) Default
  return 'default';
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

      // Cantidad desde query: /direct/:eventId?qty=3
      const MAX_QTY_PER_ORDER = Number(process.env.MAX_QTY_PER_ORDER || 10);
      
      let qty = parseInt(String(req.query.qty || '1'), 10);
      if (!Number.isFinite(qty) || qty < 1) qty = 1;
      if (qty > MAX_QTY_PER_ORDER) qty = MAX_QTY_PER_ORDER;

      // Stock (capacity 0 = sin límite)
      if (event.capacity && event.capacity > 0) {
        if ((event.ticketsSold || 0) + qty > event.capacity) {
          return res.status(409).send('Sin stock suficiente');
        }
      }

  
      // === Stripe Connect (robusto y retrocompatible) ===
      // IMPORTANTE: en algunos eventos `clubId` puede ser el USER (owner) y `club` puede ser el documento Club.
      // Para no romper eventos antiguos que ya funcionan, resolvemos en este orden:
      // 1) event.club (Club._id)
      // 2) event.clubId (si realmente era un Club._id)
      // 3) Club por ownerUserId (createdBy/clubId/organizerId)
      // 4) Fallback legacy: User.stripeAccountId

      let club = null;
      let clubId = null;

      // 1) Preferimos event.club (si existe)
      if (event.club) {
        club = await Club.findById(event.club).lean();
        if (club) clubId = club._id;
      }

      // 2) Si no, probamos event.clubId como Club._id (eventos antiguos)
      if (!club && event.clubId) {
        club = await Club.findById(event.clubId).lean();
        if (club) clubId = club._id;
      }

      // 3) Si sigue sin salir, probamos por ownerUserId (event.clubId/createdBy suelen ser el USER)
      if (!club) {
        const ownerUserId = event.createdBy || event.clubId || event.organizerId || null;
        if (!ownerUserId) {
          return res.status(400).send('El evento no tiene club asociado.');
        }
        club = await Club.findOne({ ownerUserId }).lean();
        if (club) clubId = club._id;
      }

      // 4) Fallback legacy: stripeAccountId guardado en el usuario
      if (!club || !club.stripeAccountId) {
        const ownerUserId = event.createdBy || event.clubId || event.organizerId || null;
        if (ownerUserId) {
          const user = await User.findById(ownerUserId).lean();
          if (user && user.stripeAccountId) {
            club = { _id: user._id, stripeAccountId: user.stripeAccountId };
            clubId = user._id;
          }
        }
      }

      if (!club || !club.stripeAccountId) {
        console.error('[direct] No se pudo resolver stripeAccountId (LIVE):', {
          eventId: String(event._id),
          eventClub: event.club ? String(event.club) : null,
          eventClubId: event.clubId ? String(event.clubId) : null,
          eventCreatedBy: event.createdBy ? String(event.createdBy) : null,
          eventOrganizerId: event.organizerId ? String(event.organizerId) : null,
        });
        return res.status(400).send('El club no tiene cuenta conectada en Stripe (LIVE).');
      }

      // Tema/plantilla para Email + PDF (se aplicará en el webhook)
      const ticketTheme = resolveTicketTheme({ event, club });
  
      // Comisión de plataforma por entrada:
      // - Por defecto: 1,50 €
      // - Si el evento tiene `platformFeeEUR`, se usa ese valor (en euros)
      // Comisión de plataforma por entrada:
      // - Por defecto: 1,50 €
      // - Si el evento tiene `platformFeeEUR`, se usa ese valor (admite number o string "1,50")
      const platformFeeParsed = parsePrice(event.platformFeeEUR);
      const platformFeeEUR =
        platformFeeParsed !== null && Number.isFinite(platformFeeParsed) && platformFeeParsed >= 0
          ? platformFeeParsed
          : 1.5;
      
      const TICKET_CENTS = toCents(unit);
      const PLATFORM_FEE_CENTS = Math.round(platformFeeEUR * 100);
      
      // Si fee = 0, no añadimos línea de gastos (Stripe no acepta unit_amount 0 en line_items en muchos casos)
      const hasPlatformFee = PLATFORM_FEE_CENTS > 0;
      
      // Comisión total (por entrada)
      const applicationFee = (hasPlatformFee ? PLATFORM_FEE_CENTS : 0) * qty;
      
      // Total que paga el comprador (entrada + gastos) * qty
      const totalEUR = (unit + (hasPlatformFee ? platformFeeEUR : 0)) * qty;
      
      // Order "guest": sin userId ni email (Stripe nos dará el email)
      const order = await Order.create({
        userId: null,
        eventId,
        clubId,
        qty,
        amountEUR: totalEUR,
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
            unit_amount: TICKET_CENTS,
            product_data: {
              name: event.title || 'Entrada NightVibe',
              description: productDescription,
              ...(eventImageUrl ? { images: [eventImageUrl] } : {}),
              metadata: { eventId: String(event._id), ticketTheme },
            },
          },
          quantity: qty,
        },
      
        // Gastos de gestión (tu comisión visible para el comprador)
        ...(hasPlatformFee
          ? [
              {
                price_data: {
                  currency: 'eur',
                  unit_amount: PLATFORM_FEE_CENTS,
                  product_data: {
                    name: 'Gastos de gestión',
                    description: 'Comisión de plataforma NightVibe',
                    metadata: { eventId: String(event._id), ticketTheme },
                  },
                },
                quantity: qty,
              },
            ]
          : []),
      ],

        // Mismo success/cancel que el flujo normal
        success_url: `${process.env.APP_BASE_URL}/purchase/success?sid={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.APP_BASE_URL}/event/${eventId}?cancelled=1`,
        metadata: {
          eventId: String(event._id),
          orderId: String(order._id),
          userId: '', // invitado
          clubId: String(clubId),
          ticketTheme,
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
