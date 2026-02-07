// routes/referralAnalytics.js
const express = require('express');
const router = express.Router();

const Order = require('../models/Order');
const Event = require('../models/Event');

// (Opcional) clicks/uniqueClicks desde ShareLink
let ShareLink;
try { ShareLink = require('../models/ShareLink'); } catch (_) { ShareLink = null; }

// (Opcional) si quieres devolver username
let User;
try { User = require('../models/User'); } catch (_) { User = null; }

/**
 * GET /api/referrals/club/:clubId/event/:eventId
 * Ventas atribuidas por usuario que compartió + canal
 */
router.get('/club/:clubId/event/:eventId', async (req, res) => {
  try {
    const { clubId, eventId } = req.params;

    // validar evento pertenece al club (según tu Event.js)
    const ev = await Event.findById(eventId).select('clubId').lean();
    if (!ev) return res.status(404).json({ ok: false, error: 'Event not found' });
    if (String(ev.clubId || '') !== String(clubId || '')) {
      return res.status(403).json({ ok: false, error: 'Event does not belong to club' });
    }

    const pipeline = [
      {
        $match: {
          clubId: String(clubId),
          eventId: String(eventId),
          status: 'paid',
          refUserId: { $ne: null },
        },
      },
      {
        $group: {
          _id: {
            refUserId: '$refUserId',
            shareChannel: { $ifNull: ['$shareChannel', 'unknown'] },
          },
          orders: { $sum: 1 },

          // ✅ tu schema: qty = nº entradas
          tickets: { $sum: { $ifNull: ['$qty', 0] } },

          // ✅ tu schema: amountEUR = total en euros
          revenueEUR: { $sum: { $ifNull: ['$amountEUR', 0] } },
        },
      },
      { $sort: { revenueEUR: -1, tickets: -1, orders: -1 } },
    ];

    const rows = await Order.aggregate(pipeline);

    // === Click analytics (from ShareLink) ===
    let clickRows = [];
    if (ShareLink) {
      clickRows = await ShareLink.aggregate([
        {
          $match: {
            clubId: String(clubId),
            eventId: String(eventId),
            createdByUserId: { $ne: null },
          },
        },
        {
          $group: {
            _id: {
              refUserId: '$createdByUserId',
              shareChannel: { $ifNull: ['$channel', 'unknown'] },
            },
            links: { $sum: 1 },
            clicks: { $sum: { $ifNull: ['$clicks', 0] } },
            uniqueClicks: { $sum: { $ifNull: ['$uniqueClicks', 0] } },
            lastClickedAt: { $max: '$lastClickedAt' },
          },
        },
      ]);
    }

    // bucket por usuario
    const byUser = new Map();
    for (const r of rows) {
      const uid = String(r._id.refUserId);
      const ch = String(r._id.shareChannel || 'unknown');

      if (!byUser.has(uid)) {
        byUser.set(uid, {
          refUserId: uid,
          totals: { orders: 0, tickets: 0, revenueEUR: 0, clicks: 0, uniqueClicks: 0, links: 0 },
          channels: [],
        });
      }
      const u = byUser.get(uid);

      u.channels.push({
        channel: ch,
        orders: r.orders || 0,
        tickets: r.tickets || 0,
        revenueEUR: r.revenueEUR || 0,
        clicks: 0,
        uniqueClicks: 0,
        links: 0,
        lastClickedAt: null,
      });

      u.totals.orders += r.orders || 0;
      u.totals.tickets += r.tickets || 0;
      u.totals.revenueEUR += r.revenueEUR || 0;
    }

    // Merge clicks into the same structure (includes users with clicks but 0 sales)
    for (const c of clickRows) {
      const uid = String(c._id.refUserId);
      const ch = String(c._id.shareChannel || 'unknown');

      if (!byUser.has(uid)) {
        byUser.set(uid, {
          refUserId: uid,
          totals: { orders: 0, tickets: 0, revenueEUR: 0, clicks: 0, uniqueClicks: 0, links: 0 },
          channels: [],
        });
      }
      const u = byUser.get(uid);

      // Find or create channel bucket
      let bucket = u.channels.find(x => x.channel === ch);
      if (!bucket) {
        bucket = {
          channel: ch,
          orders: 0,
          tickets: 0,
          revenueEUR: 0,
          clicks: 0,
          uniqueClicks: 0,
          links: 0,
          lastClickedAt: null,
        };
        u.channels.push(bucket);
      }

      bucket.clicks += c.clicks || 0;
      bucket.uniqueClicks += c.uniqueClicks || 0;
      bucket.links += c.links || 0;
      bucket.lastClickedAt = c.lastClickedAt || bucket.lastClickedAt;

      u.totals.clicks += c.clicks || 0;
      u.totals.uniqueClicks += c.uniqueClicks || 0;
      u.totals.links += c.links || 0;
    }

    // Normalize fields for consistent frontend rendering
    for (const u of byUser.values()) {
      u.totals = {
        orders: u.totals.orders || 0,
        tickets: u.totals.tickets || 0,
        revenueEUR: u.totals.revenueEUR || 0,
        clicks: u.totals.clicks || 0,
        uniqueClicks: u.totals.uniqueClicks || 0,
        links: u.totals.links || 0,
      };
      u.channels = (u.channels || []).map(ch => ({
        channel: ch.channel,
        orders: ch.orders || 0,
        tickets: ch.tickets || 0,
        revenueEUR: ch.revenueEUR || 0,
        clicks: ch.clicks || 0,
        uniqueClicks: ch.uniqueClicks || 0,
        links: ch.links || 0,
        lastClickedAt: ch.lastClickedAt || null,
      }));
    }

    let referrals = Array.from(byUser.values()).sort(
      (a, b) =>
        (b.totals.revenueEUR - a.totals.revenueEUR) ||
        (b.totals.tickets - a.totals.tickets) ||
        (b.totals.clicks - a.totals.clicks) ||
        (b.totals.orders - a.totals.orders)
    );

    // opcional: enriquecer con username
    if (User && referrals.length) {
      const ids = referrals.map(x => x.refUserId);
      const users = await User.find({ _id: { $in: ids } })
        .select('username profilePicture')
        .lean();

      const m = new Map(users.map(u => [String(u._id), u]));
      referrals = referrals.map(x => ({ ...x, user: m.get(String(x.refUserId)) || null }));
    }

    return res.json({ ok: true, clubId, eventId, referrals });
  } catch (e) {
    console.error('[referrals analytics]', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
