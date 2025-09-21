// routes/userRoutes.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const User = require('../models/User');
const Event = require('../models/Event');

// Middlewares existentes
const authenticateToken = require('../middlewares/authMiddleware'); // tu JWT (clubs)
const { verifyFirebaseIdToken } = require('../middlewares/firebaseAdmin'); // Firebase ID token

// Acepta Firebase o tu JWT
function anyAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const hasFirebase =
    authHeader.startsWith('Bearer ') ||
    authHeader.startsWith('Firebase ') ||
    req.headers['x-firebase-id-token'] ||
    (req.body && req.body.firebaseIdToken);

  if (hasFirebase) return verifyFirebaseIdToken(req, res, next);
  return authenticateToken(req, res, next);
}

// Garantiza req.user.id (ObjectId string en tu BD)
// - Si vino con tu JWT: ya lo tienes
// - Si vino con Firebase: localiza/crea usuario y setea req.user.id
async function ensureUserId(req, res, next) {
  if (req.user && req.user.id) return next();

  if (req.firebaseUser && req.firebaseUser.uid) {
    try {
      const { uid, phone } = req.firebaseUser;

      // Usa el mismo criterio de "usuario sintético" que ya pusimos en events.js
      const syntheticEmail = `${uid}@firebase.local`;

      let user =
        (await User.findOne({ firebaseUid: uid })) ||
        (await User.findOne({ phoneNumber: phone })) ||
        (await User.findOne({ email: syntheticEmail }));

      if (!user) {
        const base =
          (phone ? phone.replace(/\D/g, '').slice(-9) : uid.substring(0, 8)) ||
          uid.substring(0, 8);

        user = new User({
          username: `nv_${base}`,
          email: syntheticEmail,
          firebaseUid: uid,
          phoneNumber: phone || undefined,
          role: 'spectator',
        });
        await user.save();
      }

      req.user = { id: user._id.toString() };
      return next();
    } catch (err) {
      console.error('[users.ensureUserId] error:', err);
      return res.status(401).json({ message: 'No autorizado' });
    }
  }

  return res.status(401).json({ message: 'Usuario no autenticado' });
}

/**
 * GET /api/users/me/attending
 * Devuelve los eventos donde el usuario actual está en "attendees"
 * Soporta attendees como String u ObjectId e incluso estructuras mixtas.
 */
router.get('/me/attending', anyAuth, ensureUserId, async (req, res) => {
  try {
    const uidStr = req.user.id.toString();
    const maybeOid =
      mongoose.Types.ObjectId.isValid(uidStr) ? new mongoose.Types.ObjectId(uidStr) : null;

    // Query tolerante a distintos formatos de 'attendees'
    const or = [{ attendees: uidStr }];
    if (maybeOid) {
      or.push(
        { attendees: maybeOid },           // array de ObjectId
        { 'attendees._id': maybeOid },     // array de subdocs con _id
        { 'attendees.user': maybeOid },    // subdoc { user: ObjectId }
        { 'attendees.userId': maybeOid },  // subdoc { userId: ObjectId }
        { 'attendees.userId': uidStr },    // subdoc { userId: "string" }
      );
    }

    const events = await Event.find({ $or: or })
      .select('title date image city street createdBy categories attendees')
      .sort({ date: -1 })
      .populate('createdBy', 'username profilePicture');

    // Normaliza categories por si vienen string/array mixto
    const normalized = events.map((ev) => {
      const obj = ev.toObject();
      if (Array.isArray(obj.categories)) return obj;
      if (typeof obj.categories === 'string') {
        try { obj.categories = JSON.parse(obj.categories); }
        catch { obj.categories = []; }
      } else if (!obj.categories) {
        obj.categories = [];
      }
      return obj;
    });

    return res.json({ events: normalized });
  } catch (e) {
    console.error('[GET /api/users/me/attending] 500:', e);
    return res.status(500).json({ message: 'Error interno', error: e.message });
  }
});

module.exports = router;
