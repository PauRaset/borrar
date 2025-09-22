// routes/userRoutes.js
const express = require("express");
const router = express.Router();
const admin = require("../middlewares/firebaseAdmin");
const User = require("../models/User");
const Event = require("../models/Event");

// Permite "Bearer <firebaseIdToken>" o "Firebase <firebaseIdToken>"
async function authFirebase(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const parts = auth.split(" ");
    const token = parts.length === 2 ? parts[1] : null;
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

    // Busca por firebaseUid o crea rápido
    let user = await User.findOne({ firebaseUid: uid });
    if (!user) {
      user = new User({
        firebaseUid: uid,
        username: phone ? phone.replace("+", "") : `user_${uid.slice(0, 6)}`,
        phoneNumber: phone || null,
        role: user?.role || "spectator",
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
 * Devuelve los eventos donde el usuario aparece en Event.attendees
 */
router.get("/me/attending", authFirebase, ensureMongoUser, async (req, res) => {
  try {
    const userId = req.userMongo._id;

    const events = await Event.find({ attendees: userId })
      .select("title date image createdBy")
      .sort({ date: -1 })
      .lean();

    const out = events.map((e) => ({
      id: e._id,
      title: e.title,
      date: e.date,
      image: e.image || null, // relativa: "/uploads/.."
    }));

    res.json(out);
  } catch (err) {
    console.error("[/me/attending] error:", err);
    res.status(500).json({ message: "Error obteniendo tus eventos" });
  }
});

module.exports = router;
