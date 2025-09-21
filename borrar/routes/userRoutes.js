// routes/userRoutes.js
const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();

const User = require("../models/User");
const Event = require("../models/Event");

// Verificador de ID Token de Firebase (ya inicializado en middlewares/firebaseAdmin)
const { verifyFirebaseIdToken } = require("../middlewares/firebaseAdmin");

// ----------------- helpers -----------------
const makeAbs = (p) => {
  if (!p) return null;
  // si ya es absoluto, lo dejamos
  if (typeof p === "string" && (p.startsWith("http://") || p.startsWith("https://"))) return p;
  const base = process.env.BACKEND_URL?.replace(/\/+$/, "") || "";
  // si te llega "uploads/..." desde el modelo, antepón "/"
  return `${base}${p.startsWith("/") ? "" : "/"}${p}`;
};

// JWT propio (fallback a Firebase)
const authenticateToken = (req, res, next) => {
  const token = req.header("Authorization")?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No autorizado" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, role }
    return next();
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

  if (hasFirebase) {
    // verifyFirebaseIdToken pondrá req.firebaseUser = { uid, phone }
    return verifyFirebaseIdToken(req, res, next);
  }
  return authenticateToken(req, res, next);
}

// Normaliza para que siempre tengamos req.user.id (ObjectId de User)
async function ensureUserId(req, res, next) {
  if (req.user?.id) return next();

  if (req.firebaseUser?.uid) {
    try {
      const { uid, phone } = req.firebaseUser;

      // Busca por firebaseUid o phoneNumber
      let user =
        (await User.findOne({ firebaseUid: uid })) ||
        (phone ? await User.findOne({ phoneNumber: phone }) : null);

      if (!user) {
        // crea mínimo si no existe
        user = await User.findOneAndUpdate(
          { firebaseUid: uid },
          {
            $setOnInsert: {
              firebaseUid: uid,
              phoneNumber: phone || undefined,
              username: phone ? `nv_${phone.replace(/\D/g, "").slice(-9)}` : `nv_${uid.slice(0, 8)}`,
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

// ================== RUTAS ==================

/**
 * Devuelve los eventos a los que asiste el usuario autenticado
 * GET /api/users/me/attending
 * Respuesta: { items: [{eventId, eventTitle, eventDate, eventImageUrl}], count }
 */
router.get("/me/attending", anyAuth, ensureUserId, async (req, res) => {
  try {
    const userId = req.user.id;

    // Buscar eventos donde attendees contenga userId
    const events = await Event.find({ attendees: userId })
      .sort({ date: -1 })
      .limit(100)
      .select("title date image");

    const items = events.map((e) => ({
      eventId: e._id.toString(),
      eventTitle: e.title,
      eventDate: e.date,
      eventImageUrl: e.image ? makeAbs(e.image.startsWith("/") ? e.image : `/${e.image}`) : null,
    }));

    res.json({ items, count: items.length });
  } catch (err) {
    console.error("GET /me/attending error:", err);
    res.status(500).json({ message: "Error al obtener tus asistencias" });
  }
});

/**
 * Devuelve info pública de un usuario por _id (para hidratar asistentes)
 * GET /api/users/:userId
 * Respuesta: { user: { _id, username, profilePicture } }
 */
router.get("/:userId", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select("username profilePicture");
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    res.json({
      user: {
        _id: user._id.toString(),
        username: user.username || user._id.toString(),
        profilePicture: user.profilePicture ? makeAbs(user.profilePicture) : null,
      },
    });
  } catch (err) {
    console.error("GET /users/:userId error:", err);
    res.status(500).json({ message: "Error al obtener el usuario" });
  }
});

module.exports = router;
