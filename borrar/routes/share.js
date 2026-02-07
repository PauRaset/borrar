// routes/share.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { createHash } = require('crypto');

const ShareLink = require('../models/ShareLink');
const Event = require('../models/Event');

// Genera refCode corto (compatible con Node antiguos)
function genRefCode() {
  // base64url compatible sin depender de `toString('base64url')`
  return crypto
    .randomBytes(6)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

// Hash helper (privacy-friendly): we never store raw IP/UA
function sha256(input) {
  return createHash('sha256').update(String(input || '')).digest('hex');
}


function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    return xff.split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || '';
}

function getRequestBaseUrl(req) {
  // Works behind proxies (Vercel/NGINX) if `trust proxy` is enabled
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  if (!host) return '';
  return `${proto}://${host}`;
}

function pickApiBase(req) {
  const envBase = (process.env.API_BASE_URL || '').trim().replace(/\/$/, '');
  if (envBase) return envBase;
  return getRequestBaseUrl(req).replace(/\/$/, '');
}

function pickShareBase(req) {
  // Prefer a public/share domain if provided (e.g. https://nightvibe.life)
  const envShare = (process.env.SHARE_BASE_URL || '').trim().replace(/\/$/, '');
  if (envShare) return envShare;

  // Fallback: use API base (absolute)
  return pickApiBase(req);
}

function joinUrl(base, path) {
  const b = (base || '').replace(/\/$/, '');
  const p = (path || '').startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

function buildDirectUrl({ apiBase, eventId, refCode, channel }) {
  const base = apiBase || '';
  const qs = new URLSearchParams();
  if (refCode) qs.set('ref', refCode);
  if (channel) qs.set('ch', channel);
  const q = qs.toString();
  return `${base}/api/payments/direct/${eventId}${q ? `?${q}` : ''}`;
}

// GET /api/share/r/:refCode
// Registra click (+ unique aproximado) y redirige al link de compra
router.get('/r/:refCode', async (req, res) => {
  try {
    const refCode = typeof req.params.refCode === 'string' ? req.params.refCode.trim().slice(0, 64) : '';
    if (!refCode) return res.status(400).send('Bad ref');

    const link = await ShareLink.findOne({ refCode });
    if (!link) return res.status(404).send('Not found');

    // Total clicks
    link.clicks = (link.clicks || 0) + 1;
    link.lastClickedAt = new Date();

    // Unique clicks (approx): hash(ip + ua) with daily salt window (today)
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] || '';
    const day = new Date().toISOString().slice(0, 10);
    const uniqueKey = sha256(`${day}|${ip}|${ua}`);

    // cookie-based unique (24h)
    const cookieName = `nv_uc_${refCode}`;
    const hasCookie = typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`${cookieName}=`);

    if (!hasCookie) {
      link.uniqueClicks = (link.uniqueClicks || 0) + 1;
      res.cookie(cookieName, uniqueKey, {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
      });
    }

    await link.save();

    const apiBase = pickApiBase(req);
    const directUrl = buildDirectUrl({
      apiBase,
      eventId: String(link.eventId),
      refCode: link.refCode,
      channel: link.channel ? String(link.channel) : null,
    });

    return res.redirect(302, directUrl);
  } catch (e) {
    console.error('[share/r]', e);
    return res.status(500).send('server_error');
  }
});

// POST /api/share/create
// body: { eventId, channel? }
router.post('/create', async (req, res) => {
  try {
    const { eventId, channel } = req.body || {};
    if (!eventId) return res.status(400).json({ ok: false, error: 'eventId required' });

    const event = await Event.findById(eventId).lean();
    if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });

    const clubId = String(event.clubId || event.createdBy || event.userId || '');

    // Si tienes middleware auth, aquí puedes sacar req.user?.id
    const createdByUserId = req.user?.id ? String(req.user.id) : null;

    let link = await ShareLink.findOne({
      eventId: String(eventId),
      createdByUserId,
      channel: channel ? String(channel) : null,
    });

    if (!link) {
      let refCode = genRefCode();
      while (await ShareLink.findOne({ refCode })) refCode = genRefCode();

      link = await ShareLink.create({
        refCode,
        eventId: String(eventId),
        clubId,
        createdByUserId,
        channel: channel ? String(channel) : null,
      });
    }

    const apiBase = pickApiBase(req);
    const shareBase = pickShareBase(req);

    // Prefer tracking redirect URL when sharing (use public domain if available)
    const shareUrl = joinUrl(shareBase, `/r/${encodeURIComponent(link.refCode)}`);

    // Keep direct URL for compatibility
    const directUrl = buildDirectUrl({
      apiBase,
      eventId: String(eventId),
      refCode: link.refCode,
      channel: link.channel ? String(channel) : null,
    });

    return res.json({ ok: true, refCode: link.refCode, shareUrl, directUrl });
  } catch (e) {
    console.error('[share/create]', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
