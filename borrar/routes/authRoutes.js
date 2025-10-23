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
  anyAuth,
  ensureUserId,
  verifyFirebaseIdToken,
  authenticateToken
} = require("../middlewares/authMiddleware");
const sendSimpleEmail = require("../utils/sendSimpleEmail");

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
const authenticateToken = (req, res, next) => {
  const token = req.header("Authorization")?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No autorizado" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, role }
    next();
  } catch (error) {
    return res.status(403).json({ message: "Token no válido" });
  }
};

const authorizeRole = (roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ message: "Acceso denegado" });
  }
  next();
};

// ---------- Bridge de auth: acepta Firebase o tu JWT ----------
function anyAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const hasFirebase =
    authHeader.startsWith("Bearer ") || // ID token Firebase suele ir así
    authHeader.startsWith("Firebase ") ||
    req.headers["x-firebase-id-token"] ||
    (req.body && req.body.firebaseIdToken);

  if (hasFirebase) {
    // verifyFirebaseIdToken pondrá req.firebaseUser = { uid, phone }
    return verifyFirebaseIdToken(req, res, next);
  }
  // Tu JWT tradicional
  return authenticateToken(req, res, next);
}

// Garantiza req.user.id aunque venga de Firebase
async function ensureUserId(req, res, next) {
  if (req.user && req.user.id) return next(); // ya viene de tu JWT

  if (req.firebaseUser && req.firebaseUser.uid) {
    try {
      const { uid, phone } = req.firebaseUser;

      // Email sintético único (tu esquema permite email único y opcional)
      const syntheticEmail = `${uid}@firebase.local`;

      // Reutilizar si existe
      let user = await User.findOne({ email: syntheticEmail });

      if (!user) {
        const base =
          (phone ? phone.replace(/\D/g, "").slice(-9) : uid.substring(0, 8)) ||
          uid.substring(0, 8);

        user = new User({
          username: `nv_${base}`,
          email: syntheticEmail,
          role: "spectator", // tu enum admite "club" | "spectator"
        });

        await user.save();
      }

      // Normaliza como espera el resto del código
      req.user = { id: user._id.toString(), role: user.role };
      return next();
    } catch (err) {
      console.error("[ensureUserId] fallo resolviendo usuario desde Firebase:", err);
      return res.status(401).json({ message: "No autorizado" });
    }
  }

  // No hubo ni JWT ni Firebase
  return res.status(401).json({ message: "Usuario no autenticado" });
}

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
  verifyFirebaseIdToken, // setea req.firebaseUser
  ensureUserId,          // garantiza req.user.id
  async (req, res) => {
    try {
      const user = await User.findById(req.user.id);
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

      const user = await User.findById(req.user.id);
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
    const { username, email, entityName } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    if (username) user.username = username;
    if (email) user.email = cleanEmail(email);
    if (entityName) {
      user.entName = entityName;
      user.entityName = entityName;
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
    const events = await Event.find({ attendees: req.user.id })
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

/*// routes/authRoutes.js
const express = require("express");
const jwt = require("jsonwebtoken");
const passport = require("passport");
const router = express.Router();

const User = require("../models/User");
const Event = require("../models/Event"); // <- para /me/attending
const multer = require("../uploads/multerConfig"); // si lo usas así
const authController = require("../controllers/authController");
const { verifyFirebaseIdToken } = require("../middlewares/firebaseAdmin"); // <- para aceptar ID token de Firebase

// --------- Middlewares propios (como ya los tenías) ----------
const authenticateToken = (req, res, next) => {
  const token = req.header("Authorization")?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No autorizado" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, role }
    next();
  } catch (error) {
    return res.status(403).json({ message: "Token no válido" });
  }
};

const authorizeRole = (roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ message: "Acceso denegado" });
  }
  next();
};

// ---------- Bridge de auth: acepta Firebase o tu JWT ----------
function anyAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const hasFirebase =
    authHeader.startsWith("Bearer ") || // ID token Firebase suele ir así
    authHeader.startsWith("Firebase ") ||
    req.headers["x-firebase-id-token"] ||
    (req.body && req.body.firebaseIdToken);

  if (hasFirebase) {
    // verifyFirebaseIdToken pondrá req.firebaseUser = { uid, phone }
    return verifyFirebaseIdToken(req, res, next);
  }
  // Tu JWT tradicional
  return authenticateToken(req, res, next);
}

// Garantiza req.user.id aunque venga de Firebase
async function ensureUserId(req, res, next) {
  if (req.user && req.user.id) return next(); // ya viene de tu JWT

  if (req.firebaseUser && req.firebaseUser.uid) {
    try {
      const { uid, phone } = req.firebaseUser;

      // Email sintético único (tu esquema permite email único y opcional)
      const syntheticEmail = `${uid}@firebase.local`;

      // Reutilizar si existe
      let user = await User.findOne({ email: syntheticEmail });

      if (!user) {
        const base =
          (phone ? phone.replace(/\D/g, "").slice(-9) : uid.substring(0, 8)) ||
          uid.substring(0, 8);

        user = new User({
          username: `nv_${base}`,
          email: syntheticEmail,
          role: "spectator", // tu enum admite "club" | "spectator"
        });

        await user.save();
      }

      // Normaliza como espera el resto del código
      req.user = { id: user._id.toString(), role: user.role };
      return next();
    } catch (err) {
      console.error("[ensureUserId] fallo resolviendo usuario desde Firebase:", err);
      return res.status(401).json({ message: "No autorizado" });
    }
  }

  // No hubo ni JWT ni Firebase
  return res.status(401).json({ message: "Usuario no autenticado" });
}

// ================== RUTAS ==================

// Registro manual (clubs)
router.post("/register", async (req, res) => {
  try {
    const { username, email, entityName, password } = req.body;

    const userExists = await User.findOne({ email });
    if (userExists)
      return res.status(400).json({ message: "El correo ya está registrado" });

    const user = new User({
      username,
      email,
      entName: entityName,
      password,
      role: "club",
    });

    await user.save();
    res.status(201).json({ message: "Usuario registrado correctamente" });
  } catch (error) {
    console.error("Error en el registro:", error);
    res.status(500).json({ message: "Error en el servidor" });
  }
});

// Login manual (clubs)
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    const isPasswordCorrect = await user.matchPassword(password);
    if (!isPasswordCorrect)
      return res.status(401).json({ message: "Credenciales inválidas" });

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        entityName: user.entName,
        profilePicture: user.profilePicture,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Error en el login:", error);
    res.status(500).json({ message: "Error en el servidor" });
  }
});

// >>>>>>> NUEVO: Intercambio Firebase -> JWT propio (si lo usas)
router.post("/firebase", authController.firebaseLogin);

// Facebook (spectators) mediante Passport (como ya lo tenías)
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

// Perfil del usuario autenticado
router.get("/profile", authenticateToken, authController.getProfile);

// Subir/actualizar foto de perfil (ejemplo)
router.post(
  "/uploadProfilePicture",
  authenticateToken,
  multer.single("profilePicture"),
  async (req, res) => {
    try {
      if (!req.file)
        return res.status(400).json({ message: "Por favor, sube una imagen válida." });

      const user = await User.findById(req.user.id);
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

// Actualizar datos del usuario autenticado
router.put("/update", authenticateToken, async (req, res) => {
  try {
    const { username, email, entityName } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    if (username) user.username = username;
    if (email) user.email = email;
    if (entityName) user.entName = entityName;

    await user.save();
    res.json({ message: "Perfil actualizado correctamente", user });
  } catch (error) {
    console.error("Error al actualizar usuario:", error);
    res.status(500).json({ message: "Error en el servidor" });
  }
});

// Ruta protegida de ejemplo (solo clubs)
router.get("/protected", authenticateToken, authorizeRole(["club"]), (req, res) => {
  res.json({ message: "Acceso permitido a ruta protegida para clubs" });
});

// ===== NUEVO: Mis eventos donde asisto (acepta Firebase o tu JWT) =====
router.get("/me/attending", anyAuth, ensureUserId, async (req, res) => {
  try {
    const events = await Event.find({ attendees: req.user.id })
      .sort({ date: 1 })
      .populate("createdBy", "username email profilePicture")
      .lean();

    const formatted = events.map((ev) => ({
      ...ev,
      categories: Array.isArray(ev.categories)
        ? ev.categories
        : (typeof ev.categories === "string"
            ? (() => { try { return JSON.parse(ev.categories); } catch { return []; } })()
            : []),
    }));

    res.json(formatted);
  } catch (err) {
    console.error("[GET /users/me/attending] error:", err);
    res.status(500).json({ message: "Error al obtener tus eventos" });
  }
});

// Obtener usuario por id (pública) — DEBE ir al final para no tapar /me/attending
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

module.exports = router;*/
