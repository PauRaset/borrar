// routes/authRoutes.js
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

module.exports = router;
