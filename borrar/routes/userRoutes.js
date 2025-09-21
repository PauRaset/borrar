// routes/userRoutes.js
const express = require("express");
const admin = require("firebase-admin"); // inicializado por middlewares/firebaseAdmin
const User = require("../models/User");
const router = express.Router();

/* ------------ helpers token Firebase ------------ */
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
    null
  );
}

async function getUidFromRequest(req) {
  const idToken = extractIdToken(req);
  if (!idToken) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded.uid || decoded.user_id || null;
  } catch (_) {
    return null;
  }
}

/* ------------ GET /api/users/me/attending ------------ */
/* Devuelve documentos de la colección 'attendances' (Firestore)
   con los campos que el perfil/render ya espera. */
router.get("/me/attending", async (req, res) => {
  try {
    const uid = await getUidFromRequest(req);
    if (!uid) return res.status(401).json({ message: "No autorizado" });

    const db = admin.firestore();
    const snap = await db
      .collection("attendances")
      .where("userId", "==", uid)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ items });
  } catch (err) {
    console.error("[/users/me/attending] error:", err);
    return res.status(500).json({ message: "Error en el servidor" });
  }
});

/* ------------ GET /api/users/:id ------------ */
/* Hidrata asistentes en el front (nombre/foto) */
router.get("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const user = await User.findById(id).select("username name profilePicture");
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    const profilePicture = user.profilePicture
      ? `${process.env.BACKEND_URL || ""}${user.profilePicture}`
      : null;

    return res.json({
      user: {
        id: user._id,
        username: user.username || "",
        name: user.name || user.username || "",
        profilePicture,
      },
    });
  } catch (err) {
    console.error("[/users/:id] error:", err);
    return res.status(500).json({ message: "Error al obtener el usuario" });
  }
});

module.exports = router;
