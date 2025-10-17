// routes/clubRoutes.js
const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const Club = require('../models/Club');
const Order = require('../models/Order');
let User = null;
try { User = require('../models/User'); } catch (_) {}

/* ======================= Helpers genéricos ======================= */
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
  const headers = [
    'order_id','created_at','status',
    'club_id','event_id',
    'buyer_email',
    'item_name','qty','unit_amount_cents','currency','line_total_cents'
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

/* ======================= Auth mínima JWT ======================== */
function authenticateToken(req, res, next) {
  const hdr = req.header('Authorization') || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'No autorizado' });
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // { id, role }
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(403).json({ message: 'Token no válido' });
  }
}

/* (Opcional) Middleware mínimo para asegurar acceso del dueño.
   De momento sigue permisivo para no romper flujos. */
async function requireClubOwnerOrManager(req, res, next) {
  try {
    const clubId = req.params.id;
    const club = await Club.findById(clubId).lean();
    if (!club) return res.status(404).json({ error: 'club_not_found' });

    // TODO: integrar con tu auth real; aquí no bloqueamos.
    req.club = club;
    next();
  } catch (e) {
    console.error('auth club error:', e);
    res.status(500).json({ error: 'auth_error' });
  }
}

/* ======================= NUEVAS RUTAS BASE ======================= */
/**
 * GET /api/clubs/mine
 * Devuelve los clubs del usuario autenticado. Casamos por:
 *  - ownerUserId = user._id (string)
 *  - ownerUserId = user.email (porque en aprobación lo guardas así)
 *  - managers[] contiene user._id o user.email
 */
router.get('/mine', authenticateToken, async (req, res) => {
  try {
    const criteria = [];
    let email = null;

    // intenta obtener email del user
    if (User && req.user?.id) {
      try {
        const u = await User.findById(req.user.id).select('email').lean();
        email = (u?.email || '').toLowerCase().trim() || null;
      } catch (_) {}
    }
    const userId = req.user?.id?.toString();

    if (userId) criteria.push({ ownerUserId: userId });
    if (email)  criteria.push({ ownerUserId: email });
    if (userId) criteria.push({ managers: userId });
    if (email)  criteria.push({ managers: email });

    if (!criteria.length) return res.json([]);

    const clubs = await Club.find({ $or: criteria }).sort({ createdAt: -1 }).lean();
    return res.json(clubs);
  } catch (e) {
    console.error('GET /api/clubs/mine error:', e);
    return res.status(500).json({ message: 'Error al obtener tus clubs' });
  }
});

/**
 * GET /api/clubs
 * Filtros:
 *  - ownerUserId (o email): exacto (puede ser id o email)
 *  - manager: valor dentro de managers (id o email)
 *  - slug: exacto
 *  - id: exacto
 */
router.get('/', async (req, res) => {
  try {
    const { ownerUserId, email, manager, slug, id } = req.query || {};
    const q = {};

    if (id)   q._id  = id;
    if (slug) q.slug = slug;

    const owner = (ownerUserId || email || '').toString().trim();
    if (owner) q.ownerUserId = owner;

    const mgr = (manager || '').toString().trim();
    if (mgr) q.managers = mgr;

    const clubs = await Club.find(q).sort({ createdAt: -1 }).lean();
    return res.json(clubs);
  } catch (e) {
    console.error('GET /api/clubs error:', e);
    return res.status(500).json({ message: 'Error al listar clubs' });
  }
});

/* ======================= Reporting ======================= */
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

    const orders = await Order.find(q).sort({ createdAt: -1 }).lean();

    let totalCents = 0;
    let totalTickets = 0;
    for (const o of orders) {
      for (const it of (o.items || [])) {
        totalCents += (it.unitAmount || 0) * (it.qty || 0);
        totalTickets += (it.qty || 0);
      }
    }

    res.json({ count: orders.length, totalCents, totalTickets, orders });
  } catch (e) {
    console.error('GET /clubs/:id/orders error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/clubs/:id/orders.csv
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

/* =================== Reembolso básico =================== */
// POST /api/orders/:orderId/refund
router.post('/orders/:orderId/refund', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    if (!order.paymentIntentId) {
      return res.status(400).json({ error: 'missing_payment_intent' });
    }

    const refund = await stripe.refunds.create({
      payment_intent: order.paymentIntentId,
      // refund_application_fee: true,
      // amount: ...
    });

    order.status = 'refunded';
    await order.save();

    res.json({ ok: true, refund });
  } catch (e) {
    console.error('POST /orders/:id/refund error:', e);
    res.status(500).json({ error: 'refund_error', message: e?.message || 'refund_failed' });
  }
});

/* ============ Stripe Connect onboarding ============ */
// POST /api/clubs/:id/stripe/onboarding
router.post('/:id/stripe/onboarding', requireClubOwnerOrManager, async (req, res) => {
  try {
    const club = await Club.findById(req.params.id);
    if (!club) return res.status(404).json({ error: 'club_not_found' });

    if (!club.stripeAccountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        business_type: 'company',
        metadata: { clubId: String(club._id), clubName: club.name },
      });
      club.stripeAccountId = account.id;
      await club.save();
    }

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

/* ============ Scanner key: regenerar ============ */
// POST /api/clubs/:id/scanner-key/regenerate
router.post('/:id/scanner-key/regenerate', requireClubOwnerOrManager, async (req, res) => {
  try {
    const club = await Club.findById(req.params.id);
    if (!club) return res.status(404).json({ error: 'club_not_found' });

    if (!club.regenerateScannerApiKey) {
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
