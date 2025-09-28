// routes/eventRoutes.js
const express = require("express");
const multer = require("multer");
const path = require("path");
const sharp = require("sharp");
const fs = require("fs");
const mongoose = require("mongoose");

const router = express.Router();

const Event = require("../models/Event");
const User = require("../models/User");

// Tu middleware JWT actual
const authenticateToken = require("../middlewares/authMiddleware");

// Inicializa firebase-admin (y permite usar admin directamente)
require("../middlewares/firebaseAdmin");
const admin = require("firebase-admin");

/* -------------------------------------------------------------
   Helpers
------------------------------------------------------------- */
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

function backendBase(req) {
  return process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;
}

/**
 * Devuelve URL absoluta para cualquier path/URL de /uploads.
 * - Si ya es http(s) y contiene /uploads/, lo re-mapea al dominio actual.
 * - Si ya es http(s) y no es de /uploads, lo deja tal cual.
 * - Si es relativo (p.ej. "uploads/..." o "/uploads/..."), lo normaliza.
 */
function absUrlFromUpload(req, p) {
  if (!p) return null;
  const base = backendBase(req);
  if (typeof p !== "string") p = String(p);

  if (p.startsWith("http")) {
    const idx = p.indexOf("/uploads/");
    if (idx !== -1) return `${base}${p.substring(idx)}`;
    return p; // URL externa ajena a /uploads
  }
  const clean = p.startsWith("/") ? p : `/${p}`;
  return `${base}${clean}`;
}

function joinUrl(base, rel) {
  if (!base) return rel || null;
  if (!rel) return null;
  const b = base.replace(/\/+$/, "");
  const r = rel.replace(/^\/+/, "");
  return `${b}/${r}`;
}

/* Directorio por evento para las fotos */
function ensureEventUploadsDir(eventId) {
  const dir = path.join("uploads", "events", String(eventId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ------------------------------------------------------------------
   AUTH BRIDGE
------------------------------------------------------------------- */
async function anyAuth(req, res, next) {
  const token = extractIdToken(req);
  if (!token) {
    return authenticateToken(req, res, next);
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.firebaseUser = {
      uid: decoded.uid,
      phone: decoded.phone_number || decoded.phoneNumber || null,
    };
    return next();
  } catch (_) {
    return authenticateToken(req, res, next);
  }
}

async function ensureUserId(req, res, next) {
  if (req.user && req.user.id) return next();

  if (req.firebaseUser && req.firebaseUser.uid) {
    try {
      const user = await User.findOrCreateFromFirebase({
        uid: req.firebaseUser.uid,
        phoneNumber: req.firebaseUser.phone,
      });
      req.user = { id: user._id.toString() };
      return next();
    } catch (err) {
      console.error("[ensureUserId] fallo resolviendo usuario desde Firebase:", err);
      return res.status(401).json({ message: "No autorizado" });
    }
  }
  return res.status(401).json({ message: "Usuario no autenticado" });
}

/* ------------------------------------------------------------------
   Multer (igual que tenías)
------------------------------------------------------------------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads"),
  filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname),
});
const upload = multer({ storage });
// Para aceptar cualquier nombre de campo: file, files, photo, photos, image, images...
const uploadAny = upload.any();

/* ------------------------------------------------------------------
   CREAR EVENTO (igual que tenías)
------------------------------------------------------------------- */
router.post("/", anyAuth, ensureUserId, upload.single("image"), async (req, res) => {
  try {
    const {
      title,
      description,
      date,
      city,
      street,
      postalCode,
      categories,
      age,
      dressCode,
      price,
    } = req.body;

    let image = null;
    const userId = req.user.id;

    if (req.file) {
      const processedImagePath = `uploads/resized-${Date.now()}-${req.file.originalname}`;
      await sharp(req.file.path).resize(800, 450, { fit: "cover" }).toFile(processedImagePath);
      image = processedImagePath;
      fs.unlinkSync(req.file.path);
    }

    let parsedCategories = categories;
    if (typeof parsedCategories === "string") {
      try {
        parsedCategories = JSON.parse(parsedCategories);
        if (!Array.isArray(parsedCategories)) parsedCategories = [];
      } catch (err) {
        console.error("✸ Error al parsear categorías:", err);
        return res.status(400).json({ message: "Formato de categorías inválido" });
      }
    }

    const newEvent = new Event({
      title,
      description,
      date,
      city,
      street,
      postalCode,
      image,
      categories: parsedCategories || [],
      age,
      dressCode,
      price,
      // 👇 importante: el modelo ya tiene photos: []
      photos: [],
      createdBy: userId,
    });

    const savedEvent = await newEvent.save();
    res.status(201).json(savedEvent);
  } catch (error) {
    console.error("Error al guardar el evento:", error);
    res.status(500).json({ message: "Error al guardar el evento", error: error.message });
  }
});

/* ------------------------------------------------------------------
   LISTAR EVENTOS (público)
------------------------------------------------------------------- */
router.get("/", async (req, res) => {
  try {
    const events = await Event.find().populate("createdBy", "username email profilePicture").lean();

    const formattedEvents = events.map((event) => ({
      ...event,
      imageUrl: absUrlFromUpload(req, event.image),
      photos: Array.isArray(event.photos)
        ? event.photos.map((p) => absUrlFromUpload(req, p))
        : [],
      createdBy: event.createdBy
        ? {
            ...event.createdBy,
            profilePictureUrl: absUrlFromUpload(req, event.createdBy.profilePicture),
          }
        : null,
      categories: Array.isArray(event.categories)
        ? event.categories
        : typeof event.categories === "string"
        ? JSON.parse(event.categories)
        : [],
    }));

    res.json(formattedEvents);
  } catch (error) {
    console.error("Error al obtener los eventos:", error);
    res.status(500).json({ message: "Error al obtener los eventos", error });
  }
});

/* ------------------------------------------------------------------
   Devuelve asistentes (ya lo tenías)
------------------------------------------------------------------- */
router.get("/:id/attendees", async (req, res) => {
  try {
    const event = await Event.findById(req.params.id)
      .populate("attendees", "username profilePicture phoneNumber")
      .lean();

    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    const attendees = (event.attendees || []).map((u) => ({
      id: u._id.toString(),
      username: u.username || (u.phoneNumber ? u.phoneNumber.replace("+", "") : "Usuario"),
      profilePictureUrl: absUrlFromUpload(req, u.profilePicture),
    }));

    res.json({ attendees });
  } catch (err) {
    console.error("[GET /events/:id/attendees] error:", err);
    res.status(500).json({ message: "Error obteniendo asistentes" });
  }
});

/* ------------------------------------------------------------------
   DETALLE DE EVENTO (público; añade photos absolutas)
------------------------------------------------------------------- */
router.get("/:id", async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).populate(
      "createdBy",
      "username email profilePicture"
    );
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    const obj = event.toObject();

    const formattedEvent = {
      ...obj,
      imageUrl: absUrlFromUpload(req, obj.image),
      photos: Array.isArray(obj.photos) ? obj.photos.map((p) => absUrlFromUpload(req, p)) : [],
      createdBy: obj.createdBy
        ? {
            ...obj.createdBy,
            profilePictureUrl: absUrlFromUpload(req, obj.createdBy.profilePicture),
          }
        : null,
      categories: Array.isArray(obj.categories)
        ? obj.categories
        : (obj.categories || []).map((cat) => (typeof cat === "string" ? cat : String(cat))),
    };

    const userId = req.user ? req.user.id : null;
    const isOwner = userId && obj.createdBy?._id?.toString() === userId;

    res.json({ ...formattedEvent, isOwner });
  } catch (error) {
    console.error("Error al obtener el evento:", error);
    res.status(500).json({ message: "Error al obtener el evento", error });
  }
});

/* ------------------------------------------------------------------
   ELIMINAR EVENTO (igual)
------------------------------------------------------------------- */
router.delete("/:id", anyAuth, ensureUserId, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    if (event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: "No tienes permiso para eliminar este evento" });
    }

    await Event.findByIdAndDelete(req.params.id);
    res.json({ message: "Evento eliminado correctamente" });
  } catch (error) {
    console.error("Error al eliminar el evento:", error);
    res.status(500).json({ message: "Error interno del servidor" });
  }
});

/* ------------------------------------------------------------------
   TOGGLE ASISTENCIA (igual, con Firestore)
------------------------------------------------------------------- */
router.post("/:id/attend", anyAuth, ensureUserId, async (req, res) => {
  const eventId = req.params.id;

  try {
    if (!mongoose.isValidObjectId(eventId)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }
    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    event.attendees = Array.isArray(event.attendees) ? event.attendees : [];

    const userId = req.user.id;

    const idx = event.attendees.findIndex((a) => a?.toString?.() === userId);
    let attendedNow = false;

    if (idx !== -1) {
      event.attendees.splice(idx, 1);
      attendedNow = false;
    } else {
      event.attendees.push(userId);
      attendedNow = true;
    }

    await event.save();

    const firebaseToken = extractIdToken(req);
    if (firebaseToken) {
      try {
        const decoded = await admin.auth().verifyIdToken(firebaseToken);
        const uid = decoded.uid;
        const phone = decoded.phone_number || decoded.phoneNumber || null;

        const db = admin.firestore();
        const docId = `${uid}_${eventId}`;
        const docRef = db.collection("attendances").doc(docId);

        if (attendedNow) {
          await docRef.set(
            {
              userId: uid,
              userPhone: phone || null,
              eventId,
              eventTitle: event.title || "",
              eventDate: event.date ? new Date(event.date) : null,
              eventImageUrl: absUrlFromUpload(req, event.image),
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        } else {
          await docRef.delete().catch(() => {});
        }
      } catch (e) {
        console.warn("[attend] No se pudo reflejar en Firestore:", e?.message || e);
      }
    }

    return res.json({
      _id: event._id,
      attendees: event.attendees,
    });
  } catch (error) {
    console.error("Error al alternar asistencia:", error);
    res.status(500).json({ message: "Error interno del servidor", error: error.message });
  }
});

/* ------------------------------------------------------------------
   📸 GALERÍA
   - GET  /:id/photos         → devuelve lista de URLs absolutas
   - POST /:id/photos         → sube 1..N imágenes, las procesa, y guarda en event.photos
------------------------------------------------------------------- */

// GET /api/events/:id/photos
router.get("/:id/photos", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }
    const event = await Event.findById(req.params.id).lean();
    if (!event) return res.status(404).send("Evento no encontrado");

    const photos = Array.isArray(event.photos)
      ? event.photos.map((p) => absUrlFromUpload(req, p))
      : [];

    return res.json({ photos });
  } catch (e) {
    console.error("[GET /events/:id/photos] error:", e);
    return res.status(500).json({ message: "Error obteniendo fotos" });
  }
});

// POST /api/events/:id/photos  (auth requerido)
// Acepta cualquier nombre de campo (file, files, photo, photos, image, images...).
router.post("/:id/photos", anyAuth, ensureUserId, (req, res) => {
  uploadAny(req, res, async (err) => {
    if (err) {
      console.error("[photos upload] multer err:", err);
      return res.status(400).json({ message: "Error subiendo archivos" });
    }

    try {
      const eventId = req.params.id;
      if (!mongoose.isValidObjectId(eventId)) {
        return res.status(400).json({ message: "ID de evento inválido" });
      }

      const event = await Event.findById(eventId);
      if (!event) return res.status(404).json({ message: "Evento no encontrado" });

      // (Opcional) Si solo el owner puede subir:
      // if (event.createdBy.toString() !== req.user.id) {
      //   return res.status(403).json({ message: "No tienes permiso para subir fotos" });
      // }

      const files = req.files || [];
      if (!files.length) {
        return res.status(400).json({ message: "No se recibieron archivos" });
      }

      const destDir = ensureEventUploadsDir(eventId);
      const added = [];

      for (const file of files) {
        const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
        const baseName =
          `ev-${eventId}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
        const outPath = path.join(destDir, baseName);

        // Procesado: rotación según EXIF, redimensionado a “dentro de 1600px”
        await sharp(file.path)
          .rotate()
          .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
          .toFile(outPath);

        // elimina el temporal original de multer
        fs.unlink(file.path, () => {});

        // Guardamos path relativo con prefijo /uploads/... (para absUrlFromUpload)
        const rel = `/${outPath.replace(/\\/g, "/")}`;
        event.photos = Array.isArray(event.photos) ? event.photos : [];
        event.photos.push(rel);
        added.push(absUrlFromUpload(req, rel));
      }

      await event.save();

      // Devolvemos URLs absolutas recién añadidas + todas las actuales por comodidad
      return res.status(201).json({
        added,                              // nuevas subidas (absolutas)
        photos: event.photos.map((p) => absUrlFromUpload(req, p)), // estado completo
      });
    } catch (e) {
      console.error("[POST /events/:id/photos] error:", e);
      return res.status(500).json({ message: "Error guardando fotos" });
    }
  });
});

module.exports = router;

/*const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const session = require("express-session"); // si lo usas para passport
const passport = require("passport");       // si lo usas para facebook
const path = require("path");
require("dotenv").config();                 // carga .env

// ✅ Inicializa firebase-admin (lee el JSON que subiste)
require("./middlewares/firebaseAdmin");

const app = express();

// ======================= CORS ======================= 
const FRONTEND_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
const allowedOrigins = new Set([
  FRONTEND_URL,
  "https://nightvibe-six.vercel.app", // sin barra final
  "http://localhost:3000",
]);

app.use(
  cors({
    origin: (origin, cb) => {
      // Permite requests sin Origin (p. ej. curl, health checks) y los orígenes listados
      if (!origin || allowedOrigins.has(origin)) return cb(null, true);
      return cb(new Error(`CORS no permitido para: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    credentials: true,
  })
);

// ================= Parsers & estáticos ============== 
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// servir /uploads
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ==================== Sesiones ====================== 
app.use(
  session({
    secret: process.env.SESSION_SECRET || "mysecretkey",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production", // sólo HTTPS en prod
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 1 día
    },
  })
);

// ================ Passport (si lo usas) ============= 
app.use(passport.initialize());
app.use(passport.session());
require("./passportConfig");

// ============== MongoDB (como ya lo tienes) ========= 
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ Conectado a MongoDB"))
  .catch((err) => console.error("❌ Error al conectar a MongoDB:", err));

// =============== Rutas de prueba ===================== 
app.get("/", (req, res) => {
  res.send("¡Servidor funcionando correctamente!");
});

app.get("/test-image", (req, res) => {
  const base =
    (process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
  res.send(`<img src="${base}/uploads/test.jpg" alt="Test Image" />`);
});

// ================== Rutas reales ===================== 
const authRoutes = require("./routes/authRoutes");
const eventRoutes = require("./routes/eventRoutes");
const searchRoutes = require("./routes/searchRoutes");
// 👇 NUEVO: router de usuarios (incluye GET /api/users/me/attending)
const userRoutes = require("./routes/userRoutes");

app.use("/api/auth", authRoutes);
// Antes montabas authRoutes en /api/users; ahora agregamos userRoutes:
app.use("/api/users", userRoutes);
app.use("/api/events", eventRoutes);
app.use("/search", searchRoutes);

// ============= 404 catch-all ========================= 
app.use((req, res) => {
  res.status(404).send("Ruta no encontrada");
});

// ================== Server =========================== 
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✨ Servidor corriendo en el puerto ${PORT}`);
});

module.exports = app;*/
