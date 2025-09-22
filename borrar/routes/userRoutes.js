// routes/userRoutes.js
const express = require("express");
const router = express.Router();
const admin = require("../middlewares/firebaseAdmin");
const User = require("../models/User");
const Event = require("../models/Event");

// --- helpers ---
function absUrlFromUpload(req, p) {
  if (!p) return null;
  const base = process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;

  // si ya es http(s) y contiene /uploads/, reengancha al dominio actual
  if (p.startsWith("http")) {
    const idx = p.indexOf("/uploads/");
    if (idx !== -1) return `${base}${p.substring(idx)}`;
    return p; // no es de /uploads, devuélvela tal cual
  }
  const clean = p.startsWith("/") ? p : `/${p}`;
  return `${base}${clean}`;
}

// Permite "Bearer <firebaseIdToken>" o "Firebase <firebaseIdToken>"
async function authFirebase(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.split(" ")[1];
    if (!token) return res.status(401).json({ message: "Falta Authorization" });

    const decoded = await admin.auth().verifyIdToken(token);
    req.firebase = { uid: decoded.uid, phone: decoded.phone_number || decoded.phoneNumber || null };
    next();
  } catch (err) {
    console.error("[authFirebase] error:", err);
    return res.status(401).json({ message: "Token Firebase no válido" });
  }
}

// Mapea el uid de Firebase a un User de Mongo (crea si no existe)
async function ensureMongoUser(req, res, next) {
  try {
    const { uid, phone } = req.firebase || {};
    if (!uid) return res.status(401).json({ message: "Sin UID" });

    let user = await User.findOne({ firebaseUid: uid });
    if (!user) {
      user = new User({
        firebaseUid: uid,
        username: phone ? phone.replace("+", "") : `user_${uid.slice(0, 6)}`,
        phoneNumber: phone || null,
        role: "spectator",
      });
      await user.save();
    }
    req.userMongo = user;
    next();
  } catch (err) {
    console.error("[ensureMongoUser] error:", err);
    res.status(500).json({ message: "No se pudo resolver el usuario" });
  }
}

/**
 * GET /api/users/me/attending
 */
router.get("/me/attending", authFirebase, ensureMongoUser, async (req, res) => {
  try {
    const userId = req.userMongo._id;

    const events = await Event.find({ attendees: userId })
      .select("title date image")
      .sort({ date: -1 })
      .lean();

    const out = events.map((e) => ({
      id: e._id.toString(),
      title: e.title,
      date: e.date,
      imageUrl: absUrlFromUpload(req, e.image), // 👈 siempre absoluta
    }));

    res.json(out);
  } catch (err) {
    console.error("[/me/attending] error:", err);
    res.status(500).json({ message: "Error obteniendo tus eventos" });
  }
});

module.exports = router;
