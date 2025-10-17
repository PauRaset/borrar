// routes/clubRoutes.js
const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const Club = require('../models/Club');
const Order = require('../models/Order');

// ======================= Helpers ==========================
function asInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function ordersToCsv(orders = []) {
  // Una fila por item (así ves cantidades y totales por línea)
  const headers = [
    'order_id', 'created_at', 'status',
    'club_id', 'event_id',
    'buyer_email',
    'item_name', 'qty', 'unit_amount_cents', 'currency', 'line_total_cents'
  ];
  const rows = [headers.join(',')];

  for (const o of orders) {
    const created = o.createdAt ? new Date(o.createdAt).toISOString() : '';
    const email = o.email || '';
    const clubId = o.clubId || '';
    const eventId = o.eventId || '';
    const status = o.status || '';

    if (Array.isArray(o.items) && o.items.length) {
      for (const it of o.items) {
        const name = it?.name || 'Entrada';
        const qty = asInt(it?.qty, 1);
        const unit = asInt(it?.unitAmount, 0);
        const curr = (it?.currency || 'eur').toLowerCase();
        const lineTotal = qty * unit;

        rows.push([
          csvEscape(o._id),
          csvEscape(created),
          csvEscape(status),
          csvEscape(clubId),
          csvEscape(eventId),
          csvEscape(email),
          csvEscape(name),
          csvEscape(qty),
          csvEscape(unit),
          csvEscape(curr),
          csvEscape(lineTotal),
        ].join(','));
      }
    } else {
      rows.push([
        csvEscape(o._id),
        csvEscape(created),
        csvEscape(status),
        csvEscape(clubId),
        csvEscape(eventId),
        csvEscape(email),
        '', '', '', '', ''
      ].join(','));
    }
  }
  return rows.join('\n');
}

// (Opcional) Middleware mínimo para asegurar acceso del dueño.
// Adaptar a tu auth real (Firebase/Passport). De momento, permisivo.
async function requireClubOwnerOrManager(req, res, next) {
  try {
    const clubId = req.params.id;
    const club = await Club.findById(clubId).lean();
    if (!club) return res.status(404).json({ error: 'club_not_found' });

    // TODO: integrar con tu auth real.
    // Por ahora no bloqueamos para no romper tu flujo actual.
    req.club = club;
    next();
  } catch (e) {
    console.error('auth club error:', e);
    res.status(500).json({ error: 'auth_error' });
  }
}

// ================== 5) Reporting ==========================

// GET /api/clubs/:id/orders?from=YYYY-MM-DD&to=YYYY-MM-DD&status=paid
router.get('/:id/orders', requireClubOwnerOrManager, async (req, res) => {
  try {
    const clubId = req.params.id;
    const { from, to, status } = req.query;

    const q = { clubId };
    if (status) q.status = status;

    if (from || to) {
      q.createdAt = {};
      if (from) q.createdAt.$gte = new Date(`${from}T00:00:00.000Z`);
      if (to)   q.createdAt.$lte = new Date(`${to}T23:59:59.999Z`);
    }

    const orders = await Order.find(q)
      .sort({ createdAt: -1 })
      .lean();

    // Resumen sencillo: total céntimos y nº entradas
    let totalCents = 0;
    let totalTickets = 0;
    for (const o of orders) {
      for (const it of (o.items || [])) {
        totalCents += (it.unitAmount || 0) * (it.qty || 0);
        totalTickets += (it.qty || 0);
      }
    }

    res.json({
      count: orders.length,
      totalCents,
      totalTickets,
      orders,
    });
  } catch (e) {
    console.error('GET /clubs/:id/orders error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/clubs/:id/orders.csv  (mismos filtros)
router.get('/:id/orders.csv', requireClubOwnerOrManager, async (req, res) => {
  try {
    const clubId = req.params.id;
    const { from, to, status } = req.query;

    const q = { clubId };
    if (status) q.status = status;

    if (from || to) {
      q.createdAt = {};
      if (from) q.createdAt.$gte = new Date(`${from}T00:00:00.000Z`);
      if (to)   q.createdAt.$lte = new Date(`${to}T23:59:59.999Z`);
    }

    const orders = await Order.find(q).sort({ createdAt: -1 }).lean();
    const csv = ordersToCsv(orders);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="orders_${clubId}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('GET /clubs/:id/orders.csv error:', e);
    res.status(500).send('server_error');
  }
});

// ============== 5) Reembolso básico =======================
// POST /api/orders/:orderId/refund
router.post('/orders/:orderId/refund', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: 'order_not_found' });

    if (!order.paymentIntentId) {
      return res.status(400).json({ error: 'missing_payment_intent' });
    }

    // Si quieres devolver también tu fee, añade refund_application_fee:true
    const refund = await stripe.refunds.create({
      payment_intent: order.paymentIntentId,
      // refund_application_fee: true, // <- Decide tu política
      // amount: ... // <- parcial, si quisieras
    });

    // Marca orden como 'refunded' (si tu lógica lo contempla)
    order.status = 'refunded';
    await order.save();

    res.json({ ok: true, refund });
  } catch (e) {
    console.error('POST /orders/:id/refund error:', e);
    res.status(500).json({ error: 'refund_error', message: e?.message || 'refund_failed' });
  }
});

// ============== 6) Stripe Connect onboarding ===============

// POST /api/clubs/:id/stripe/onboarding
router.post('/:id/stripe/onboarding', requireClubOwnerOrManager, async (req, res) => {
  try {
    const club = await Club.findById(req.params.id);
    if (!club) return res.status(404).json({ error: 'club_not_found' });

    // 1) Crear cuenta si no existe
    if (!club.stripeAccountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        business_type: 'company', // o 'individual' si tus clubs pueden ser personas físicas
        metadata: {
          clubId: String(club._id),
          clubName: club.name,
        },
      });
      club.stripeAccountId = account.id;
      await club.save();
    }

    // 2) Crear Account Link de onboarding
    const portalBase = (process.env.CLUBS_PORTAL_URL || process.env.FRONTEND_URL || 'https://clubs.nightvibe.life').replace(/\/+$/, '');
    const accountLink = await stripe.accountLinks.create({
      account: club.stripeAccountId,
      refresh_url: `${portalBase}/dashboard?club=${club._id}&onboarding=refresh`,
      return_url:  `${portalBase}/dashboard?club=${club._id}&onboarding=return`,
      type: 'account_onboarding',
    });

    res.json({ url: accountLink.url, accountId: club.stripeAccountId });
  } catch (e) {
    console.error('POST /clubs/:id/stripe/onboarding error:', e);
    res.status(500).json({ error: 'onboarding_error', message: e?.message || 'onboarding_failed' });
  }
});

// GET /api/clubs/:id/stripe/status
router.get('/:id/stripe/status', requireClubOwnerOrManager, async (req, res) => {
  try {
    const club = await Club.findById(req.params.id).lean();
    if (!club) return res.status(404).json({ error: 'club_not_found' });
    if (!club.stripeAccountId) {
      return res.json({ connected: false, requirements: null });
    }

    const acct = await stripe.accounts.retrieve(club.stripeAccountId);
    res.json({
      connected: !acct.requirements?.currently_due?.length,
      details_submitted: acct.details_submitted,
      payouts_enabled: acct.payouts_enabled,
      requirements: {
        currently_due: acct.requirements?.currently_due || [],
        eventually_due: acct.requirements?.eventually_due || [],
        disabled_reason: acct.requirements?.disabled_reason || null,
      },
    });
  } catch (e) {
    console.error('GET /clubs/:id/stripe/status error:', e);
    res.status(500).json({ error: 'status_error', message: e?.message || 'status_failed' });
  }
});

// ============== 6) Scanner key: regenerar ==================

// POST /api/clubs/:id/scanner-key/regenerate
router.post('/:id/scanner-key/regenerate', requireClubOwnerOrManager, async (req, res) => {
  try {
    const club = await Club.findById(req.params.id);
    if (!club) return res.status(404).json({ error: 'club_not_found' });

    if (!club.regenerateScannerApiKey) {
      // por si no has pegado el método en el modelo
      club.scannerApiKey = require('crypto').randomBytes(32).toString('base64url');
      await club.save();
      return res.json({ ok: true, scannerApiKey: club.scannerApiKey });
    }

    const key = await club.regenerateScannerApiKey();
    res.json({ ok: true, scannerApiKey: key });
  } catch (e) {
    console.error('POST /clubs/:id/scanner-key/regenerate error:', e);
    res.status(500).json({ error: 'scanner_key_error', message: e?.message || 'regenerate_failed' });
  }
});

module.exports = router;
