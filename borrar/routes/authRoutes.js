// routes/authRoutes.js
const express = require("express");
const jwt = require("jsonwebtoken");
const passport = require("passport");
const router = express.Router();

const User = require("../models/User");
const Event = require("../models/Event"); // <- para /me/attending
const multer = require("../uploads/multerConfig"); // si lo usas así
const authController = require("../controllers/authController");
const {
  authenticateToken,
  anyAuth,
  ensureUserId,
  verifyFirebaseIdToken,
} = require("../middlewares/authMiddleware");

const mongoose = require("mongoose");
const { Types: { ObjectId } } = mongoose;

function isValidObjectId(v) {
  return typeof v === "string" && ObjectId.isValid(v) && (new ObjectId(v)).toString() === v;
}

async function resolveUserFromRequest(req) {
  // 1) JWT legacy con ObjectId válido
  if (req.user && req.user.id && isValidObjectId(req.user.id)) {
    const u = await User.findById(req.user.id);
    if (u) return u;
  }
  // 2) Firebase: por firebaseUid o por teléfono
  const fu = req.firebaseUser;
  if (fu && fu.uid) {
    let u = await User.findOne({ firebaseUid: fu.uid });
    if (u) return u;
    if (fu.phone_number) {
      u = await User.findOne({ phoneNumber: fu.phone_number });
      if (u) return u;
    }
  }
  // 3) JWT con id no-ObjectId: probar como firebaseUid
  if (req.user && req.user.id && !isValidObjectId(req.user.id)) {
    const u = await User.findOne({ firebaseUid: req.user.id });
    if (u) return u;
  }
  return null;
}

/* ===================== Helpers ===================== */
const cleanEmail = (e) => (e || "").toLowerCase().trim();

function issueSessionToken(user) {
  return jwt.sign(
    { id: user._id.toString(), role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "1d" }
  );
}

/* ================= Middlewares base ================= */
const authorizeRole = (roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ message: "Acceso denegado" });
  }
  next();
};

/* ====================== RUTAS ======================= */

/* -------- Registro manual (clubs) -------- */
router.post("/register", async (req, res) => {
  try {
    const { username, email, entityName, password } = req.body;
    const normEmail = cleanEmail(email);

    const userExists = await User.findOne({ email: normEmail });
    if (userExists)
      return res.status(400).json({ message: "El correo ya está registrado" });

    const user = new User({
      username: (username || normEmail.split("@")[0]).trim(),
      email: normEmail,
      entName: entityName,
      entityName, // por si quieres ya sincronizado
      password,   // hook del modelo lo hashea
      role: "club",
    });

    await user.save();

    res.status(201).json({ message: "Usuario registrado correctamente" });
  } catch (error) {
    console.error("Error en el registro:", error);
    res.status(500).json({ message: "Error en el servidor" });
  }
});

/* -------- Login manual (clubs) -------- */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email: cleanEmail(email) });
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    const isPasswordCorrect = await user.matchPassword(password);
    if (!isPasswordCorrect)
      return res.status(401).json({ message: "Credenciales inválidas" });

    const token = issueSessionToken(user);

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        entityName: user.entityName || user.entName,
        profilePicture: user.profilePicture,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Error en el login:", error);
    res.status(500).json({ message: "Error en el servidor" });
  }
});

/* -------- Forgot / Reset password (JWT temporal por email) -------- */
/**
 * POST /api/auth/forgot
 * Envía un enlace de reseteo (también sirve para “primera contraseña”).
 * Crea un JWT corto con { id, kind:'pwdreset' } y 1h de validez.
 */
router.post("/forgot", async (req, res) => {
  try {
    const email = cleanEmail(req.body.email);
    const user = await User.findOne({ email });
    // Para no filtrar si existe o no:
    if (!user) return res.json({ ok: true });

    const token = jwt.sign(
      { id: user._id.toString(), kind: "pwdreset" },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    const frontend = (process.env.FRONTEND_URL || "https://clubs.nightvibe.life").replace(/\/+$/,'');
    const link = `${frontend}/login/reset?token=${encodeURIComponent(token)}`;

    await sendSimpleEmail({
      to: email,
      subject: "Restablecer contraseña – NightVibe Clubs",
      html: `
        <p>Hola ${user.username || ""},</p>
        <p>Para establecer o restablecer tu contraseña, haz clic en el siguiente enlace:</p>
        <p><a href="${link}">Establecer contraseña</a></p>
        <p>El enlace caduca en 1 hora. Si tú no lo solicitaste, ignora este mensaje.</p>
      `,
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("forgot error:", e);
    res.status(500).json({ ok: false, message: "No se pudo enviar el correo" });
  }
});

/**
 * POST /api/auth/reset
 * Body: { token, password }
 * Verifica el JWT y fija la nueva contraseña.
 */
router.post("/reset", async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ message: "Faltan datos" });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(400).json({ message: "Token inválido o expirado" });
    }

    if (payload.kind !== "pwdreset" || !payload.id) {
      return res.status(400).json({ message: "Token inválido" });
    }

    const user = await User.findById(payload.id);
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    // Usa helper del modelo para hashear
    await user.setPassword(password);
    await user.save();

    return res.json({ ok: true, message: "Contraseña actualizada" });
  } catch (e) {
    console.error("reset error:", e);
    res.status(500).json({ message: "Error en el servidor" });
  }
});

/* -------- Intercambio Firebase -> JWT propio -------- */
// Permite a la app intercambiar un Firebase ID token por tu JWT legacy
// Headers: Authorization: Bearer <FirebaseIdToken>
router.post(
  "/exchangeFirebase",
  anyAuth,       // acepta JWT propio o Firebase ID token
  ensureUserId,  // garantiza req.user.id (si viene Firebase, usa uid)
  async (req, res) => {
    try {
      let user = await resolveUserFromRequest(req);

      // Si no existe y venimos con Firebase, crea espectador mínimo
      if (!user && req.firebaseUser && req.firebaseUser.uid) {
        const phone = req.firebaseUser.phone_number || "";
        const username = phone ? `user_${phone.replace(/\D/g, '').slice(-6)}` : `user_${Date.now()}`;
        user = await User.create({
          username,
          phoneNumber: phone,
          firebaseUid: req.firebaseUser.uid,
          role: "spectator",
        });
      }

      if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

      const token = issueSessionToken(user);
      return res.json({ token });
    } catch (e) {
      console.error("[POST /api/auth/exchangeFirebase]", e);
      return res.status(500).json({ message: "Error en el servidor" });
    }
  }
);

router.post("/firebase", authController.firebaseLogin);

/* -------- Facebook (spectators) mediante Passport -------- */
router.get(
  "/facebook",
  passport.authenticate("facebook", { scope: ["email", "public_profile"] })
);

router.get(
  "/facebook/callback",
  passport.authenticate("facebook", {
    session: false,
    failureRedirect: "https://event-app-prod.vercel.app/login",
  }),
  authController.loginWithFacebook
);

/* -------- Perfil del usuario autenticado -------- */
router.get("/profile", authenticateToken, authController.getProfile);

/* -------- Subir/actualizar foto de perfil -------- */
router.post(
  "/uploadProfilePicture",
  anyAuth,
  ensureUserId,
  multer.single("profilePicture"),
  async (req, res) => {
    try {
      if (!req.file)
        return res.status(400).json({ message: "Por favor, sube una imagen válida." });

      const user = await resolveUserFromRequest(req);
      if (!user) return res.status(404).json({ message: "Usuario no encontrado." });

      user.profilePicture = `/uploads/profilePictures/${req.file.filename}`;
      await user.save();

      res.json({
        message: "Foto de perfil actualizada.",
        profilePicture: user.profilePicture,
      });
    } catch (error) {
      console.error("Error al actualizar la foto de perfil:", error);
      res.status(500).json({ message: "Error en el servidor." });
    }
  }
);

/* -------- Actualizar datos del usuario autenticado -------- */
router.put("/update", anyAuth, ensureUserId, async (req, res) => {
  try {
    const {
      username,
      email,
      entityName,
      profilePicture,
      instagram,
      bio,
      isPrivate,
    } = req.body || {};

    const user = await resolveUserFromRequest(req);
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    // Campos legacy (clubs)
    if (typeof username === 'string' && username.trim()) user.username = username.trim();
    if (typeof email === 'string' && email.trim()) user.email = cleanEmail(email);
    if (typeof entityName === 'string' && entityName.trim()) {
      user.entName = entityName.trim();
      user.entityName = entityName.trim();
    }

    // Quitar foto de perfil si viene cadena vacía
    if (typeof profilePicture === 'string' && profilePicture.trim() === '') {
      user.profilePicture = '';
    }

    // Instagram: normalizar a URL https; permitir "@usuario"
    if (typeof instagram === 'string') {
      let val = instagram.trim();
      if (val.startsWith('@')) val = `https://instagram.com/${val.slice(1)}`;
      if (val && !/^https?:\/\//i.test(val)) val = `https://${val}`;
      user.instagram = val;
    }

    // Bio: texto libre controlado por cliente
    if (typeof bio === 'string') {
      user.bio = bio;
    }

    // isPrivate: booleano
    if (typeof isPrivate !== 'undefined') {
      user.isPrivate = Boolean(isPrivate);
    }

    await user.save();
    res.json({ message: "Perfil actualizado correctamente", user });
  } catch (error) {
    console.error("Error al actualizar usuario:", error);
    res.status(500).json({ message: "Error en el servidor" });
  }
});

/* -------- Ruta protegida de ejemplo (solo clubs) -------- */
router.get("/protected", authenticateToken, authorizeRole(["club"]), (req, res) => {
  res.json({ message: "Acceso permitido a ruta protegida para clubs" });
});

/* -------- Mis eventos donde asisto (acepta Firebase o tu JWT) -------- */
router.get("/me/attending", anyAuth, ensureUserId, async (req, res) => {
  try {
    const me = await resolveUserFromRequest(req);
    if (!me) return res.status(404).json({ message: "Usuario no encontrado" });
    const events = await Event.find({ attendees: me._id })
      .sort({ date: 1 })
      .populate("createdBy", "username email profilePicture")
      .lean();

    const formatted = events.map((ev) => ({
      ...ev,
      categories: Array.isArray(ev.categories)
        ? ev.categories
        : typeof ev.categories === "string"
        ? (() => {
            try {
              return JSON.parse(ev.categories);
            } catch {
              return [];
            }
          })()
        : [],
    }));

    res.json(formatted);
  } catch (err) {
    console.error("[GET /me/attending] error:", err);
    res.status(500).json({ message: "Error al obtener tus eventos" });
  }
});

/* -------- Alias: Mis eventos donde asisto (para cliente móvil) -------- */
router.get("/users/me/attending", anyAuth, ensureUserId, async (req, res) => {
  try {
    const me = await resolveUserFromRequest(req);
    if (!me) return res.status(404).json({ message: "Usuario no encontrado" });
    const events = await Event.find({ attendees: me._id })
      .sort({ date: 1 })
      .populate("createdBy", "username email profilePicture")
      .lean();

    const formatted = events.map((ev) => ({
      ...ev,
      categories: Array.isArray(ev.categories)
        ? ev.categories
        : typeof ev.categories === "string"
        ? (() => {
            try {
              return JSON.parse(ev.categories);
            } catch {
              return [];
            }
          })()
        : [],
    }));

    res.json(formatted);
  } catch (err) {
    console.error("[GET /users/me/attending] error:", err);
    res.status(500).json({ message: "Error al obtener tus eventos" });
  }
});

/* -------- Obtener usuario por id (pública) — al final -------- */
router.get("/:userId", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user)
      return res.status(404).json({ message: "Usuario no encontrado" });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: "Error al obtener el usuario" });
  }
});

module.exports = router;
