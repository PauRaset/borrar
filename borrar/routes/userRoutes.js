// routes/userRoutes.js
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const User = require("../models/User");
const Event = require("../models/Event");
const authenticateToken = require("../middlewares/authMiddleware");

require("../middlewares/firebaseAdmin");
const admin = require("firebase-admin");

function extractIdToken(req) {
  const h = req.headers || {};
  const auth = h.authorization || h.Authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  if (auth.startsWith("Firebase ")) return auth.slice(8).trim();
  return (
    h["x-firebase-id-token"] ||
    h["firebase-id-token"] ||
    h["firebase_token"] ||
    h["idtoken"] ||
    (req.body && (req.body.firebaseIdToken || req.body.idToken)) ||
    null
  );
}

async function anyAuth(req, res, next) {
  const token = extractIdToken(req);
  if (!token) return authenticateToken(req, res, next);
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.firebaseUser = { uid: decoded.uid, phone: decoded.phone_number || decoded.phoneNumber || null };
    return next();
  } catch (_) {
    return authenticateToken(req, res, next);
  }
}

async function ensureUserId(req, res, next) {
  if (req.user && req.user.id) return next();
  if (req.firebaseUser && req.firebaseUser.uid) {
    try {
      const u = await User.findOrCreateFromFirebase({
        uid: req.firebaseUser.uid,
        phoneNumber: req.firebaseUser.phone,
      });
      req.user = { id: u._id.toString() };
      return next();
    } catch (e) {
      console.error("[userRoutes.ensureUserId] Firebase→User fallo:", e);
      return res.status(401).json({ message: "No autorizado" });
    }
  }
  return res.status(401).json({ message: "Usuario no autenticado" });
}

function toAbs(base, rel) {
  if (!rel) return null;
  if (/^https?:\/\//i.test(rel)) return rel;
  const b = (base || "").replace(/\/+$/, "");
  const r = rel.replace(/^\/+/, "");
  return b ? `${b}/${r}` : `/${r}`;
}

// === Lista de eventos a los que asiste el usuario autenticado (Mongo puro)
router.get("/me/attending", anyAuth, ensureUserId, async (req, res) => {
  try {
    const userIdStr = req.user.id;

    const criteria = [];
    if (mongoose.isValidObjectId(userIdStr)) {
      criteria.push({ attendees: new mongoose.Types.ObjectId(userIdStr) });
    }
    criteria.push({ attendees: userIdStr });
    const query = criteria.length === 1 ? criteria[0] : { $or: criteria };

    const events = await Event.find(query)
      .sort({ date: -1 })
      .select("title date image city street createdBy")
      .populate("createdBy", "username profilePicture");

    const base = process.env.BACKEND_URL || "";
    const items = events.map((e) => ({
      eventId: e._id.toString(),
      eventTitle: e.title || "",
      eventDate: e.date || null,
      eventImageUrl: toAbs(base, e.image),
      createdBy: e.createdBy
        ? {
            id: e.createdBy._id?.toString?.() ?? null,
            username: e.createdBy.username || "",
            profilePicture: toAbs(base, e.createdBy.profilePicture),
          }
        : null,
      location: [e.city, e.street].filter(Boolean).join(", "),
    }));

    return res.json({ items });
  } catch (err) {
    console.error("[GET /api/users/me/attending] error:", err);
    return res.status(500).json({ message: "Error obteniendo asistencias", error: err.message });
  }
});

// === Obtener un usuario por id (para hidratar asistentes)
router.get("/:userId", async (req, res) => {
  try {
    const id = req.params.userId;
    const user = mongoose.isValidObjectId(id) ? await User.findById(id) : null;
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    const base = process.env.BACKEND_URL || "";
    return res.json({
      _id: user._id,
      username: user.username || "",
      name: user.username || "",
      profilePicture: toAbs(base, user.profilePicture),
    });
  } catch (e) {
    console.error("[GET /api/users/:userId] error:", e);
    return res.status(500).json({ message: "Error al obtener el usuario" });
  }
});

module.exports = router;
