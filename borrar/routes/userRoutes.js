// routes/userRoutes.js
const express = require("express");
const router = express.Router();
const admin = require("../middlewares/firebaseAdmin");
const mongoose = require("mongoose");
const User = require("../models/User");
const Event = require("../models/Event");

const PUBLIC_BASE =
  process.env.BACKEND_URL ||
  process.env.BACKEND_PUBLIC_URL ||
  "https://api.nightvibe.life";

// --- Auth con Firebase ID token (Bearer|Firebase <token>) ---
async function authFirebase(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const [scheme, tokenMaybe] = auth.split(" ");
    const token = tokenMaybe || auth; // por si te mandan solo el token

    if (!token) return res.status(401).json({ message: "Falta Authorization" });

    // No hace falta validar el scheme; si viene token, probamos a verificarlo
    const decoded = await admin.auth().verifyIdToken(token);
    req.firebase = {
      uid: decoded.uid,
      phone: decoded.phone_number || decoded.phoneNumber || null,
    };
    next();
  } catch (err) {
    console.error("[authFirebase] error:", err);
    return res.status(401).json({ message: "Token Firebase no válido" });
  }
}

// --- Asegura usuario de Mongo a partir del uid de Firebase ---
async function ensureMongoUser(req, res, next) {
  try {
    const { uid, phone } = req.firebase || {};
    if (!uid) return res.status(401).json({ message: "Sin UID" });

    // 1º por firebaseUid; 2º por phoneNumber (por si ya existía)
    let user = await User.findOne({ firebaseUid: uid });
    if (!user && phone) {
      user = await User.findOne({ phoneNumber: phone });
    }

    if (!user) {
      user = await User.create({
        firebaseUid: uid,
        username: phone ? phone.replace(/\+/g, "") : `user_${uid.slice(0, 6)}`,
        phoneNumber: phone || null,
        role: "spectator",
      });
    }

    req.userMongo = user;
    next();
  } catch (err) {
    console.error("[ensureMongoUser] error:", err);
    res.status(500).json({ message: "No se pudo resolver el usuario" });
  }
}

const toAbs = (p) => {
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) return p;
  const clean = p.startsWith("/") ? p.slice(1) : p;
  return `${PUBLIC_BASE}/${clean}`;
};

/**
 * GET /api/users/me/attending
 * Devuelve eventos donde el usuario está en Event.attendees
 */
router.get("/me/attending", authFirebase, ensureMongoUser, async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.userMongo._id);

    const events = await Event.find({ attendees: userId })
      .select("_id title date image createdBy")
      .sort({ date: -1 })
      .lean();

    const out = events.map((e) => ({
      _id: e._id,
      id: e._id?.toString(),
      title: e.title,
      date: e.date,
      image: toAbs(e.image), // devolver absoluta
    }));

    res.json(out);
  } catch (err) {
    console.error("[/me/attending] error:", err);
    res.status(500).json({ message: "Error obteniendo tus eventos" });
  }
});

module.exports = router;
