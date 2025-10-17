// routes/registrationRoutes.js
const express = require('express');
const crypto = require('crypto');
const Club = require('../models/Club'); // ya lo tienes
const ClubApplication = require('../models/ClubApplication');
const sendSimpleEmail = require('../utils/sendSimpleEmail');

const router = express.Router();

// ✅ Ruta de prueba para verificar que el router está montado correctamente
router.get('/ping', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

/**
 * POST /api/registration/apply
 * Crea una solicitud y envía email con enlace de verificación.
 */
router.post('/apply', async (req, res) => {
  try {
    const { email, clubName, contactName, phone, website, instagram } = req.body || {};
    if (!email || !clubName) return res.status(400).json({ ok:false, error:'missing_fields' });

    // token de verificación  (válido 48h)
    const verifyToken = crypto.randomBytes(20).toString('base64url');
    const verifyTokenExpiresAt = new Date(Date.now() + 48*60*60*1000);

    const appDoc = await ClubApplication.findOneAndUpdate(
      { email },
      { email, clubName, contactName, phone, website, instagram, verifyToken, verifyTokenExpiresAt, status:'pending' },
      { upsert: true, new: true }
    );

// link al frontend (página /register/verify)
const frontend = (process.env.FRONTEND_URL || 'https://clubs.nightvibe.life').replace(/\/+$/, '');
const link = `${frontend}/register/verify?token=${verifyToken}`;

// ⬇️ No bloquees el flujo si el email falla
try {
  await sendSimpleEmail({
    to: email,
    subject: 'Verifica tu email – NightVibe Clubs',
    html: `
      <p>Hola ${contactName || ''},</p>
      <p>Para continuar con el registro de <b>${clubName}</b>, confirma tu correo:</p>
      <p><a href="${link}">Verificar email</a></p>
      <p>Enlace válido durante 48 horas.</p>
    `
  });
} catch (err) {
  console.error('sendSimpleEmail error:', err?.message || err);
  // Si quieres, añade una bandera para el frontend:
  // return res.json({ ok:true, mail:false });   // y el frontend avisa “no pudimos enviar el email”
}

// pase lo que pase arriba, confirma la creación
return res.json({ ok:true, mail:true });
});

/**
 * POST /api/registration/verify
 * Marca la solicitud como email_verified si el token es válido.
 */
router.post('/verify', async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ ok:false, error:'missing_token' });

    const appDoc = await ClubApplication.findOne({ verifyToken: token });
    if (!appDoc) return res.status(404).json({ ok:false, error:'invalid_token' });
    if (!appDoc.verifyTokenExpiresAt || appDoc.verifyTokenExpiresAt < new Date()) {
      return res.status(400).json({ ok:false, error:'token_expired' });
    }

    appDoc.status = 'email_verified';
    await appDoc.save();

    res.json({ ok:true });
  } catch (e) {
    console.error('verify error', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

/**
 * GET /api/registration/applications (ADMIN)
 * Lista solicitudes (filtros simples).
 */
router.get('/applications', async (req, res) => {
  try {
    // TODO: proteger con tu middleware admin
    const { status = 'pending' } = req.query;
    const list = await ClubApplication.find({ status }).sort({ createdAt: -1 }).lean();
    res.json({ ok:true, items: list });
  } catch (e) {
    console.error('list apps', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

/**
 * POST /api/registration/:id/approve (ADMIN)
 * Crea el Club + genera scannerApiKey y marca approved.
 */
router.post('/applications/:id/approve', async (req, res) => {
  try {
    // TODO: proteger con tu middleware admin
    const { id } = req.params;
    const appDoc = await ClubApplication.findById(id);
    if (!appDoc) return res.status(404).json({ ok:false, error:'not_found' });
    if (appDoc.status !== 'email_verified' && appDoc.status !== 'pending') {
      // permitimos aprobar aunque esté 'pending' si quieres atajar
    }

    // generar slug básico
    const base = (appDoc.clubName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g,'') || 'club';
    const slug = `${base}-${Math.random().toString(36).slice(2,6)}`;

    // scanner key por club
    const scannerApiKey = crypto.randomBytes(24).toString('base64url');

    const club = await Club.create({
      name: appDoc.clubName,
      slug,
      ownerUserId: appDoc.email,         // si luego ligas con UID de Firebase, actualízalo
      managers: [],
      stripeAccountId: null,
      scannerApiKey,
      status: 'active',
    });

    appDoc.status = 'approved';
    appDoc.approvedAt = new Date();
    // appDoc.approvedBy = req.user?.email || null; // si tienes auth admin
    await appDoc.save();

    // Email de bienvenida
    await sendSimpleEmail({
      to: appDoc.email,
      subject: 'Tu cuenta de organizador ha sido aprobada 🎉',
      html: `
        <p>¡Enhorabuena!</p>
        <p>Tu panel: <a href="${(process.env.FRONTEND_URL || 'https://clubs.nightvibe.life').replace(/\/+$/,'')}">${(process.env.FRONTEND_URL || 'https://clubs.nightvibe.life').replace(/\/+$/,'')}</a></p>
        <p>Clave del escáner (guárdala): <code>${scannerApiKey}</code></p>
        <p>Próximo paso: conecta Stripe desde el dashboard para cobrar.</p>
      `
    });

    res.json({ ok:true, club });
  } catch (e) {
    console.error('approve error', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

/**
 * POST /api/registration/applications/:id/reject (ADMIN)
 */
router.post('/applications/:id/reject', async (req, res) => {
  try {
    // TODO: proteger con tu middleware admin
    const { id } = req.params;
    const { reason = '' } = req.body || {};
    const appDoc = await ClubApplication.findById(id);
    if (!appDoc) return res.status(404).json({ ok:false, error:'not_found' });

    appDoc.status = 'rejected';
    appDoc.notes = reason;
    await appDoc.save();

    await sendSimpleEmail({
      to: appDoc.email,
      subject: 'Solicitud rechazada',
      html: `<p>Lo sentimos, tu solicitud ha sido rechazada.</p><p>${reason}</p>`
    });

    res.json({ ok:true });
  } catch (e) {
    console.error('reject error', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
