const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const router = express.Router();

const User = require("../models/User");
const Event = require("../models/Event");
const { verifyFirebaseIdToken } = require("../middlewares/firebaseAdmin");

// ---------- helpers ----------
const isObjectId = (v) => mongoose.Types.ObjectId.isValid(v);
const toObjectId = (v) => new mongoose.Types.ObjectId(v);
const baseFromReq = (req) =>
  (process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

const abs = (req, p) => {
  if (!p) return null;
  if (typeof p === "string" && /^https?:\/\//i.test(p)) return p;
  const base = baseFromReq(req);
  return `${base}${p.startsWith("/") ? "" : "/"}${p}`;
};

// JWT propio (fallback cuando no viene Firebase)
const authenticateToken = (req, res, next) => {
  const token = req.header("Authorization")?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No autorizado" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET); // { id, role }
    next();
  } catch {
    return res.status(403).json({ message: "Token no válido" });
  }
};

// Acepta Firebase o tu JWT
function anyAuth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const hasFirebase =
    hdr.startsWith("Bearer ") ||
    hdr.startsWith("Firebase ") ||
    req.headers["x-firebase-id-token"] ||
    (req.body && req.body.firebaseIdToken);
  return hasFirebase ? verifyFirebaseIdToken(req, res, next) : authenticateToken(req, res, next);
}

// Normaliza: siempre deja req.user.id (ObjectId de User)
async function ensureUserId(req, res, next) {
  if (req.user?.id) return next();

  if (req.firebaseUser?.uid) {
    try {
      const { uid, phone } = req.firebaseUser;

      // intenta por UID o teléfono
      let user =
        (await User.findOne({ firebaseUid: uid })) ||
        (phone ? await User.findOne({ phoneNumber: phone }) : null);

      // crea si no existe
      if (!user) {
        user = await User.findOneAndUpdate(
          { firebaseUid: uid },
          {
            $setOnInsert: {
              firebaseUid: uid,
              phoneNumber: phone || undefined,
              username: phone
                ? `nv_${phone.replace(/\D/g, "").slice(-9)}`
                : `nv_${uid.slice(0, 8)}`,
              role: "spectator",
            },
          },
          { upsert: true, new: true }
        );
      }

      req.user = { id: user._id.toString(), role: user.role };
      return next();
    } catch (err) {
      console.error("[ensureUserId] error:", err);
      return res.status(401).json({ message: "No autorizado" });
    }
  }

  return res.status(401).json({ message: "Usuario no autenticado" });
}

// ===================================================================
// GET /api/users/me/attending  -> eventos a los que asiste el usuario
//    * súper tolerante con tipos en `attendees` (String u ObjectId)
// ===================================================================
router.get("/me/attending", anyAuth, ensureUserId, async (req, res) => {
  const userId = req.user.id;
  try {
    // Traemos sólo lo que necesitamos y filtramos en memoria para evitar CastError
    const events = await Event.find({}, { title: 1, date: 1, image: 1, attendees: 1 })
      .sort({ date: -1 })
      .lean();

    const items = [];
    for (const ev of events) {
      const arr = Array.isArray(ev.attendees) ? ev.attendees : [];
      const has = arr.some((a) => {
        if (!a) return false;
        // a puede ser ObjectId, String o incluso sub-doc
        try {
          if (typeof a === "string") return a === userId;
          if (typeof a === "object" && a._id) return String(a._id) === userId;
          return String(a) === userId; // ObjectId.toString()
        } catch {
          return false;
        }
      });
      if (has) {
        items.push({
          eventId: String(ev._id),
          eventTitle: ev.title,
          eventDate: ev.date,
          eventImageUrl: ev.image ? abs(req, ev.image.startsWith("/") ? ev.image : `/${ev.image}`) : null,
        });
      }
    }

    return res.json({ items, count: items.length });
  } catch (err) {
    console.error("GET /users/me/attending error:", err);
    return res.status(500).json({ message: "Error al obtener tus asistencias" });
  }
});

// ===================================================================
// GET /api/users/:userId -> info pública para hidratar asistentes
//  Acepta _id, firebaseUid o phoneNumber
// ===================================================================
router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    let user = null;
    if (isObjectId(userId)) {
      user = await User.findById(userId).select("username profilePicture").lean();
    }
    if (!user) {
      user = await User.findOne({
        $or: [{ firebaseUid: userId }, { phoneNumber: userId }],
      })
        .select("username profilePicture")
        .lean();
    }
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    return res.json({
      user: {
        _id: String(user._id),
        username: user.username || String(user._id),
        profilePicture: user.profilePicture ? abs(req, user.profilePicture) : null,
      },
    });
  } catch (err) {
    console.error("GET /users/:userId error:", err);
    return res.status(500).json({ message: "Error al obtener el usuario" });
  }
});

module.exports = router;
