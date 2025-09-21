const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const router = express.Router();

const User = require("../models/User");
const Event = require("../models/Event");
const { verifyFirebaseIdToken } = require("../middlewares/firebaseAdmin"); // ya lo tienes

// -------- helpers --------
const makeAbs = (p) => {
  if (!p) return null;
  if (typeof p === "string" && (p.startsWith("http://") || p.startsWith("https://"))) return p;
  const base = (process.env.BACKEND_URL || "").replace(/\/+$/, "");
  return `${base}${p.startsWith("/") ? "" : "/"}${p}`;
};

// JWT propio (fallback a Firebase)
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
      let user =
        (await User.findOne({ firebaseUid: uid })) ||
        (phone ? await User.findOne({ phoneNumber: phone }) : null);

      if (!user) {
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

// ===================================================================
// GET /api/users/me/attending  -> eventos a los que asiste el usuario
// ===================================================================
router.get("/me/attending", anyAuth, ensureUserId, async (req, res) => {
  try {
    const userId = req.user.id;

    // Soporta que attendees sea String o ObjectId
    const cond = [{ attendees: userId }];
    if (mongoose.Types.ObjectId.isValid(userId)) {
      cond.push({ attendees: new mongoose.Types.ObjectId(userId) });
    }

    const events = await Event.find({ $or: cond })
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
    console.error("GET /users/me/attending error:", err);
    res.status(500).json({ message: "Error al obtener tus asistencias" });
  }
});

// ===================================================================
// GET /api/users/:userId  -> info pública (para hidratar asistentes)
// ===================================================================
router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    const user = await User.findById(userId).select("username profilePicture");
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
