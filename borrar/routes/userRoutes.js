// routes/userRoutes.js
const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const sharp = require("sharp");

const User = require("../models/User");
const Event = require("../models/Event");
const authenticateToken = require("../middlewares/authMiddleware");

// Inicializa firebase-admin (igual que en eventRoutes)
require("../middlewares/firebaseAdmin");
const admin = require("firebase-admin");

/* -------------------------------------------------------------
   Helpers
------------------------------------------------------------- */
function backendBase(req) {
  return process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;
}

function absUrlFromUpload(req, p) {
  if (!p) return null;
  const base = backendBase(req);

  if (typeof p !== "string") p = String(p);

  if (p.startsWith("http")) {
    const idx = p.indexOf("/uploads/");
    if (idx !== -1) return `${base}${p.substring(idx)}`;
    return p; // URL externa no /uploads
  }
  const clean = p.startsWith("/") ? p : `/${p}`;
  return `${base}${clean}`;
}

// Saca idToken de headers, si viene
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

/* -------------------------------------------------------------
   AUTH BRIDGE: acepta Firebase O tu JWT propio
------------------------------------------------------------- */
async function anyAuth(req, res, next) {
  const token = extractIdToken(req);
  if (!token) {
    // sin token Firebase -> intenta tu JWT
    return authenticateToken(req, res, next);
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.firebaseUser = {
      uid: decoded.uid,
      phone: decoded.phone_number || decoded.phoneNumber || null,
      displayName: decoded.name || null,
      photoURL: decoded.picture || null,
    };
    return next();
  } catch (_) {
    // no era Firebase válido -> usa tu JWT
    return authenticateToken(req, res, next);
  }
}

// Garantiza req.user.id (ObjectId string de Mongo)
// - si viene de tu JWT: ya lo pone el middleware
// - si viene de Firebase: crea/encuentra el User y lo setea
async function ensureUserId(req, res, next) {
  if (req.user && req.user.id) return next();
  if (req.firebaseUser && req.firebaseUser.uid) {
    try {
      const user = await User.findOrCreateFromFirebase({
        uid: req.firebaseUser.uid,
        phoneNumber: req.firebaseUser.phone,
        displayName: req.firebaseUser.displayName,
        photoURL: req.firebaseUser.photoURL,
      });
      req.user = { id: user._id.toString() };
      return next();
    } catch (err) {
      console.error("[ensureUserId] error:", err);
      return res.status(401).json({ message: "No autorizado" });
    }
  }
  return res.status(401).json({ message: "Usuario no autenticado" });
}

/* -------------------------------------------------------------
   Multer + Sharp para avatar
------------------------------------------------------------- */
const ROOT_UPLOADS_DIR = path.join(__dirname, "..", "uploads");
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureDir(ROOT_UPLOADS_DIR);
    cb(null, ROOT_UPLOADS_DIR);
  },
  filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname),
});
const upload = multer({ storage });

async function processImageToJpg(srcPath, outDir, baseName) {
  ensureDir(outDir);
  const outPath = path.join(outDir, `${baseName}.jpg`);
  try {
    await sharp(srcPath)
      .rotate()
      .resize(800, 800, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(outPath);
    return outPath;
  } catch (e) {
    const fallback = path.join(outDir, `${baseName}${path.extname(srcPath) || ""}`);
    fs.copyFileSync(srcPath, fallback);
    return fallback;
  } finally {
    try { fs.unlinkSync(srcPath); } catch {}
  }
}

/* -------------------------------------------------------------
   GET /api/users/me/attending  (ahora con anyAuth)
------------------------------------------------------------- */
router.get("/me/attending", anyAuth, ensureUserId, async (req, res) => {
  try {
    const userId = req.user.id;
    const events = await Event.find({ attendees: userId })
      .select("title date image createdBy")
      .sort({ date: -1 })
      .lean();

    const out = events.map((e) => ({
      id: e._id.toString(),
      title: e.title,
      date: e.date,
      imageUrl: absUrlFromUpload(req, e.image),
    }));

    res.json(out);
  } catch (err) {
    console.error("[/me/attending] error:", err);
    res.status(500).json({ message: "Error obteniendo tus eventos" });
  }
});

/* -------------------------------------------------------------
   GET /api/users/me  (JWT o Firebase)
------------------------------------------------------------- */
router.get("/me", anyAuth, ensureUserId, async (req, res) => {
  try {
    const u = await User.findById(req.user.id).lean();
    if (!u) return res.status(404).json({ message: "Usuario no encontrado" });

    const avatarRaw = u.profilePicture || u.avatar || null;

    return res.json({
      _id: u._id,
      id: u._id,
      username: u.username,
      email: u.email || null,
      phoneNumber: u.phoneNumber || null,
      role: u.role || null,
      entName: u.entName || "",
      wUser: u.wUser || "",
      profilePicture: u.profilePicture || "",
      profilePictureUrl: absUrlFromUpload(req, avatarRaw),
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    });
  } catch (err) {
    console.error("[GET /api/users/me] error:", err);
    return res.status(500).json({ message: "No se pudo obtener el usuario actual" });
  }
});

/* -------------------------------------------------------------
   PATCH/PUT /api/users/me  (actualiza perfil)
   Campos permitidos: username, entName, wUser, role (opcional)
------------------------------------------------------------- */
function sanitizeProfileUpdate(body) {
  const allowed = ["username", "entName", "wUser", "role"];
  const out = {};
  for (const k of allowed) {
    if (typeof body[k] !== "undefined") out[k] = body[k];
  }
  return out;
}

router.patch("/me", anyAuth, ensureUserId, async (req, res) => {
  try {
    const update = sanitizeProfileUpdate(req.body);
    const user = await User.findByIdAndUpdate(req.user.id, update, { new: true }).lean();
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    return res.json({
      _id: user._id,
      id: user._id,
      username: user.username,
      entName: user.entName || "",
      wUser: user.wUser || "",
      role: user.role || null,
      profilePictureUrl: absUrlFromUpload(req, user.profilePicture || user.avatar || null),
    });
  } catch (err) {
    console.error("[PATCH /api/users/me] error:", err);
    res.status(500).json({ message: "No se pudo actualizar el perfil" });
  }
});

router.put("/me", anyAuth, ensureUserId, async (req, res) => {
  // mismo handler que PATCH
  return router.handle({ ...req, method: "PATCH" }, res);
});

/* -------------------------------------------------------------
   POST /api/users/me/avatar  (subir/cambiar avatar)
------------------------------------------------------------- */
router.post("/me/avatar", anyAuth, ensureUserId, upload.single("avatar"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Falta el archivo "avatar"' });

    const processedDir = ROOT_UPLOADS_DIR;
    const processedImagePath = await processImageToJpg(
      req.file.path,
      processedDir,
      `avatar-${Date.now()}-${path.parse(req.file.originalname).name}`
    );

    const rel = path.relative(path.join(__dirname, ".."), processedImagePath).replace(/\\/g, "/");

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { profilePicture: rel },
      { new: true }
    ).lean();

    return res.json({
      _id: user._id,
      id: user._id,
      profilePicture: rel,
      profilePictureUrl: absUrlFromUpload(req, rel),
    });
  } catch (err) {
    console.error("[POST /api/users/me/avatar] error:", err);
    res.status(500).json({ message: "No se pudo subir el avatar", error: err.message });
  }
});

module.exports = router;
