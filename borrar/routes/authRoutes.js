const express = require("express");
const jwt = require("jsonwebtoken");
const passport = require("passport");
const User = require("../models/User");
const multer = require("../uploads/multerConfig"); // si lo usas así
const router = express.Router();

const authController = require("../controllers/authController");

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

// >>>>>>> NUEVO: Intercambio Firebase -> JWT propio
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

// Obtener usuario por id (pública)
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