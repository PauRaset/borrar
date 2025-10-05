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

/* Utils de ficheros */
const ROOT_UPLOADS_DIR = path.join(__dirname, "..", "uploads");
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/* ------------------------------------------------------------------
   AUTH BRIDGE
   - anyAuth: acepta Firebase o tu JWT.
   - ensureUserId: si viene de Firebase, resuelve/crea un User y setea
     req.user.id con el ObjectId que usa tu base de datos.
------------------------------------------------------------------- */

// decide en tiempo real si verificar Firebase o JWT
async function anyAuth(req, res, next) {
  const token = extractIdToken(req);
  if (!token) {
    // no hubo token Firebase -> probamos tu JWT clásico
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
    // No era (o no válido) como Firebase -> usar tu JWT clásico
    return authenticateToken(req, res, next);
  }
}

// a partir de lo que haya puesto anyAuth, garantizamos req.user.id
async function ensureUserId(req, res, next) {
  if (req.user && req.user.id) return next(); // ya viene de tu JWT

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

  // No hubo ni JWT ni Firebase
  return res.status(401).json({ message: "Usuario no autenticado" });
}

/* ------------------------------------------------------------------
   Configuración de multer
------------------------------------------------------------------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureDir(ROOT_UPLOADS_DIR);
    cb(null, ROOT_UPLOADS_DIR);
  },
  filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname),
});
const upload = multer({ storage });
// Para aceptar múltiples campos/arrays con nombres distintos:
const uploadAny = multer({ storage });

/* Proceso de imagen (resize → .jpg) */
async function processImageToJpg(srcPath, outDir, baseName) {
  ensureDir(outDir);
  const outPath = path.join(outDir, `${baseName}.jpg`);
  try {
    await sharp(srcPath)
      .rotate()
      .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(outPath);
    return outPath;
  } catch (e) {
    // fallback: copia tal cual si sharp falla (p.ej., formato raro)
    const fallback = path.join(outDir, `${baseName}${path.extname(srcPath) || ""}`);
    fs.copyFileSync(srcPath, fallback);
    return fallback;
  } finally {
    try { fs.unlinkSync(srcPath); } catch {}
  }
}

/* -------------------------------------------------------------
   Helpers de normalización de fotos con metadatos
------------------------------------------------------------- */
function usernameFromUserDoc(u) {
  if (!u) return null;
  return (
    u.username ||
    (u.phoneNumber ? u.phoneNumber.replace("+", "") : null) ||
    null
  );
}

function toPhotoTileAbs(req, entry) {
  // Acepta string o objeto y devuelve objeto { url, byUsername?, uploadedAt? } con URL absoluta
  if (!entry) return null;

  if (typeof entry === "string") {
    return { url: absUrlFromUpload(req, entry) };
  }
  if (typeof entry === "object") {
    const url =
      absUrlFromUpload(req, entry.url || entry.path || entry.href || entry.secure_url || entry.photo || entry.image);
    const byUsername =
      entry.byUsername ||
      (entry.byUser && entry.byUser.username) ||
      (entry.user && entry.user.username) ||
      entry.username ||
      null;

    return {
      url,
      ...(byUsername ? { byUsername } : {}),
      ...(entry.uploadedAt ? { uploadedAt: entry.uploadedAt } : {}),
    };
  }
  return null;
}

/* ------------------------------------------------------------------
   CREAR EVENTO  (requiere usuario)
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
      categories, // puede venir string o array
      age,
      dressCode,
      price,
    } = req.body;

    let image = null;
    const userId = req.user.id;

    if (req.file) {
      const processedDir = ROOT_UPLOADS_DIR;
      const processedImagePath = await processImageToJpg(
        req.file.path,
        processedDir,
        `resized-${Date.now()}-${path.parse(req.file.originalname).name}`
      );
      // Guardamos path relativo desde /uploads
      image = path.relative(path.join(__dirname, ".."), processedImagePath).replace(/\\/g, "/");
    }

    // Normalizar categorías
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
      createdBy: userId,
      // photos se inicializa por schema ([])
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

    const formattedEvents = events.map((event) => {
      // normaliza fotos a objetos con url absoluta (manteniendo compatibilidad)
      const photos = Array.isArray(event.photos)
        ? event.photos
            .map((p) => toPhotoTileAbs(req, p))
            .filter(Boolean)
        : [];

      return {
        ...event,
        imageUrl: absUrlFromUpload(req, event.image),
        photos,
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
      };
    });

    res.json(formattedEvents);
  } catch (error) {
    console.error("Error al obtener los eventos:", error);
    res.status(500).json({ message: "Error al obtener los eventos", error });
  }
});

/* ------------------------------------------------------------------
   Devuelve asistentes con username y avatar listos para pintar
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
   DETALLE DE EVENTO (público; calcula isOwner si hay usuario)
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
      photos: Array.isArray(obj.photos)
        ? obj.photos.map((p) => toPhotoTileAbs(req, p)).filter(Boolean)
        : [],
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

    const userId = req.user ? req.user.id : null; // si algún middleware previo lo puso
    const isOwner = userId && obj.createdBy?._id?.toString() === userId;

    res.json({ ...formattedEvent, isOwner });
  } catch (error) {
    console.error("Error al obtener el evento:", error);
    res.status(500).json({ message: "Error al obtener el evento", error });
  }
});

/* ------------------------------------------------------------------
   ELIMINAR EVENTO (requiere usuario y ser owner)
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
   GALERÍA: GET fotos (y alias)
------------------------------------------------------------------- */
async function getPhotosHandler(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }
    const event = await Event.findById(id).lean();
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    const photos = (event.photos || [])
      .map((p) => toPhotoTileAbs(req, p))
      .filter(Boolean);

    return res.json({ photos });
  } catch (e) {
    console.error("[GET photos] error:", e);
    return res.status(500).json({ message: "Error obteniendo fotos" });
  }
}

router.get("/:id/photos", getPhotosHandler);
router.get("/:id/gallery", getPhotosHandler);
router.get("/:id/images", getPhotosHandler);
router.get("/:id/media", getPhotosHandler);

/* ------------------------------------------------------------------
   GALERÍA: POST subir fotos (y alias)
   - Acepta múltiples campos: file/files/files[]/photo/photos/photos[]/image/images/images[]
   - Requiere usuario
------------------------------------------------------------------- */
async function postPhotosHandler(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }
    const event = await Event.findById(id);
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    // Recoge archivos subidos, sin importar el nombre del campo
    const files = (req.files && Array.isArray(req.files) ? req.files : [])
      .concat(req.file ? [req.file] : []);

    if (!files.length) {
      return res.status(400).json({ message: "No se recibieron archivos" });
    }

    // Datos del usuario que sube
    let byUsername = "usuario";
    try {
      const userDoc = await User.findById(req.user.id).lean();
      const u = usernameFromUserDoc(userDoc);
      if (u) byUsername = u;
    } catch (_) {}

    // Carpeta para fotos de evento
    const eventPhotosDir = path.join(ROOT_UPLOADS_DIR, "event-photos");
    ensureDir(eventPhotosDir);

    const savedMeta = [];
    for (const f of files) {
      const base = `event-${id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const processed = await processImageToJpg(f.path, eventPhotosDir, base);
      const rel = path
        .relative(path.join(__dirname, ".."), processed)
        .replace(/\\/g, "/"); // ej: "uploads/event-photos/event-xxx.jpg"

      const meta = {
        url: rel,
        by: req.user.id,
        byUsername,
        uploadedAt: new Date(),
      };

      event.photos = Array.isArray(event.photos) ? event.photos : [];
      event.photos.push(meta);
      savedMeta.push(meta);
    }

    await event.save();

    // Respuesta: objetos con url absoluta + byUsername
    const uploaded = savedMeta.map((m) => ({
      url: absUrlFromUpload(req, m.url),
      byUsername: m.byUsername,
      uploadedAt: m.uploadedAt,
    }));

    const allPhotos = (event.photos || [])
      .map((p) => toPhotoTileAbs(req, p))
      .filter(Boolean);

    return res.status(201).json({
      uploaded,        // recién subidas (con autor)
      photos: allPhotos, // estado completo de galería (con autor cuando exista)
      count: uploaded.length,
    });
  } catch (e) {
    console.error("[POST photos] error:", e);
    return res.status(500).json({ message: "Error subiendo fotos", error: e.message });
  }
}

// Acepta cualquier campo / array (evita que Flutter tenga que adivinar)
router.post("/:id/photos", anyAuth, ensureUserId, uploadAny.any(), postPhotosHandler);
router.post("/:id/photos/upload", anyAuth, ensureUserId, uploadAny.any(), postPhotosHandler);
router.post("/:id/upload-photo", anyAuth, ensureUserId, uploadAny.any(), postPhotosHandler);

/* ------------------------------------------------------------------
   ALTERNAR ASISTENCIA (requiere usuario)
   - Alterna en Mongo (campo attendees)
   - Escribe/borra doc en Firestore: attendances/{uid}_{eventId}
------------------------------------------------------------------- */
router.post("/:id/attend", anyAuth, ensureUserId, async (req, res) => {
  const eventId = req.params.id;

  try {
    // 1) Recuperar evento
    if (!mongoose.isValidObjectId(eventId)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }
    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    event.attendees = Array.isArray(event.attendees) ? event.attendees : [];

    // 2) Usuario (Mongo id ya garantizado)
    const userId = req.user.id;

    // 3) Alternar asistencia en Mongo (comparando como string)
    const idx = event.attendees.findIndex((a) => a?.toString?.() === userId);
    let attendedNow = false;

    if (idx !== -1) {
      event.attendees.splice(idx, 1); // quitar
      attendedNow = false;
    } else {
      event.attendees.push(userId); // añadir
      attendedNow = true;
    }

    await event.save();

    // 4) Si viene además como Firebase (teléfono), refleja en Firestore
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

    // 5) Responder
    return res.json({
      _id: event._id,
      attendees: event.attendees,
    });
  } catch (error) {
    console.error("Error al alternar asistencia:", error);
    res.status(500).json({ message: "Error interno del servidor", error: error.message });
  }
});

/* ==================================================================
   🚀 NUEVO: UPDATE + IMAGEN PRINCIPAL
================================================================== */

// Helpers para update
function sanitizeUpdate(payload) {
  const clean = { ...payload };
  [
    '_id', 'id', 'createdAt', 'updatedAt', '__v',
    'createdBy', 'attendees', 'photos'
  ].forEach(k => delete clean[k]);
  return clean;
}

function parseCategoriesMaybe(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return value.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  return [];
}

async function updateEventHandler(req, res) {
  try {
    const id = req.params.id;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }

    // 1) Buscar evento y verificar ownership
    const event = await Event.findById(id);
    if (!event) return res.status(404).json({ message: 'Evento no encontrado' });

    if (event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'No tienes permiso para editar este evento' });
    }

    // 2) Construir update
    const update = sanitizeUpdate(req.body);

    if (typeof req.body.categories !== 'undefined') {
      update.categories = parseCategoriesMaybe(req.body.categories);
    }

    // 3) Imagen (si viene multipart)
    if (req.file) {
      const processedDir = ROOT_UPLOADS_DIR;
      const processedImagePath = await processImageToJpg(
        req.file.path,
        processedDir,
        `resized-${Date.now()}-${path.parse(req.file.originalname).name}`
      );
      update.image = path
        .relative(path.join(__dirname, '..'), processedImagePath)
        .replace(/\\/g, '/');
    }

    // 4) Actualizar y devolver formateado
    const updated = await Event.findByIdAndUpdate(id, update, { new: true })
      .populate('createdBy', 'username email profilePicture')
      .lean();

    const formatted = {
      ...updated,
      imageUrl: absUrlFromUpload(req, updated.image),
      photos: Array.isArray(updated.photos)
        ? updated.photos.map(p => toPhotoTileAbs(req, p)).filter(Boolean)
        : [],
      createdBy: updated.createdBy
        ? {
            ...updated.createdBy,
            profilePictureUrl: absUrlFromUpload(req, updated.createdBy.profilePicture),
          }
        : null,
      categories: Array.isArray(updated.categories)
        ? updated.categories
        : parseCategoriesMaybe(updated.categories),
    };

    return res.json(formatted);
  } catch (err) {
    console.error('[UPDATE /events/:id] error:', err);
    return res.status(500).json({ message: 'Error actualizando el evento', error: err.message });
  }
}

// PATCH y PUT -> mismo handler
router.patch('/:id', anyAuth, ensureUserId, upload.single('image'), updateEventHandler);
router.put('/:id',   anyAuth, ensureUserId, upload.single('image'), updateEventHandler);

// Subir/cambiar imagen principal
router.post('/:id/image', anyAuth, ensureUserId, upload.single('image'), async (req, res) => {
  try {
    const id = req.params.id;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }

    const event = await Event.findById(id);
    if (!event) return res.status(404).json({ message: 'Evento no encontrado' });

    if (event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'No tienes permiso para cambiar la imagen' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'Falta el archivo "image"' });
    }

    const processedDir = ROOT_UPLOADS_DIR;
    const processedImagePath = await processImageToJpg(
      req.file.path,
      processedDir,
      `resized-${Date.now()}-${path.parse(req.file.originalname).name}`
    );

    const rel = path
      .relative(path.join(__dirname, '..'), processedImagePath)
      .replace(/\\/g, '/');

    event.image = rel;
    await event.save();

    return res.json({
      _id: event._id,
      image: rel,
      imageUrl: absUrlFromUpload(req, rel),
    });
  } catch (err) {
    console.error('[POST /events/:id/image] error:', err);
    return res.status(500).json({ message: 'Error subiendo imagen', error: err.message });
  }
});

module.exports = router;

/*// routes/eventRoutes.js
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

// -------------------------------------------------------------
//   Helpers
//------------------------------------------------------------- 
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

// Utils de ficheros 
const ROOT_UPLOADS_DIR = path.join(__dirname, "..", "uploads");
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ------------------------------------------------------------------
//   AUTH BRIDGE
//   - anyAuth: acepta Firebase o tu JWT.
//   - ensureUserId: si viene de Firebase, resuelve/crea un User y setea
//     req.user.id con el ObjectId que usa tu base de datos.
//------------------------------------------------------------------- 

// decide en tiempo real si verificar Firebase o JWT
async function anyAuth(req, res, next) {
  const token = extractIdToken(req);
  if (!token) {
    // no hubo token Firebase -> probamos tu JWT clásico
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
    // No era (o no válido) como Firebase -> usar tu JWT clásico
    return authenticateToken(req, res, next);
  }
}

// a partir de lo que haya puesto anyAuth, garantizamos req.user.id
async function ensureUserId(req, res, next) {
  if (req.user && req.user.id) return next(); // ya viene de tu JWT

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

  // No hubo ni JWT ni Firebase
  return res.status(401).json({ message: "Usuario no autenticado" });
}

// ------------------------------------------------------------------
//   Configuración de multer
//------------------------------------------------------------------- 
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureDir(ROOT_UPLOADS_DIR);
    cb(null, ROOT_UPLOADS_DIR);
  },
  filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname),
});
const upload = multer({ storage });
// Para aceptar múltiples campos/arrays con nombres distintos:
const uploadAny = multer({ storage });

// Proceso de imagen (resize → .jpg) 
async function processImageToJpg(srcPath, outDir, baseName) {
  ensureDir(outDir);
  const outPath = path.join(outDir, `${baseName}.jpg`);
  try {
    await sharp(srcPath)
      .rotate()
      .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(outPath);
    return outPath;
  } catch (e) {
    // fallback: copia tal cual si sharp falla (p.ej., formato raro)
    const fallback = path.join(outDir, `${baseName}${path.extname(srcPath) || ""}`);
    fs.copyFileSync(srcPath, fallback);
    return fallback;
  } finally {
    try { fs.unlinkSync(srcPath); } catch {}
  }
}

// -------------------------------------------------------------
//   Helpers de normalización de fotos con metadatos
//-------------------------------------------------------------
function usernameFromUserDoc(u) {
  if (!u) return null;
  return (
    u.username ||
    (u.phoneNumber ? u.phoneNumber.replace("+", "") : null) ||
    null
  );
}

function toPhotoTileAbs(req, entry) {
  // Acepta string o objeto y devuelve objeto { url, byUsername?, uploadedAt? } con URL absoluta
  if (!entry) return null;

  if (typeof entry === "string") {
    return { url: absUrlFromUpload(req, entry) };
  }
  if (typeof entry === "object") {
    const url =
      absUrlFromUpload(req, entry.url || entry.path || entry.href || entry.secure_url || entry.photo || entry.image);
    const byUsername =
      entry.byUsername ||
      (entry.byUser && entry.byUser.username) ||
      (entry.user && entry.user.username) ||
      entry.username ||
      null;

    return {
      url,
      ...(byUsername ? { byUsername } : {}),
      ...(entry.uploadedAt ? { uploadedAt: entry.uploadedAt } : {}),
    };
  }
  return null;
}

// ------------------------------------------------------------------
//   CREAR EVENTO  (requiere usuario)
//------------------------------------------------------------------- 
router.post("/", anyAuth, ensureUserId, upload.single("image"), async (req, res) => {
  try {
    const {
      title,
      description,
      date,
      city,
      street,
      postalCode,
      categories, // puede venir string o array
      age,
      dressCode,
      price,
    } = req.body;

    let image = null;
    const userId = req.user.id;

    if (req.file) {
      const processedDir = ROOT_UPLOADS_DIR;
      const processedImagePath = await processImageToJpg(
        req.file.path,
        processedDir,
        `resized-${Date.now()}-${path.parse(req.file.originalname).name}`
      );
      // Guardamos path relativo desde /uploads
      image = path.relative(path.join(__dirname, ".."), processedImagePath).replace(/\\/g, "/");
    }

    // Normalizar categorías
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
      createdBy: userId,
      // photos se inicializa por schema ([])
    });

    const savedEvent = await newEvent.save();
    res.status(201).json(savedEvent);
  } catch (error) {
    console.error("Error al guardar el evento:", error);
    res.status(500).json({ message: "Error al guardar el evento", error: error.message });
  }
});

// ------------------------------------------------------------------
//   LISTAR EVENTOS (público)
//------------------------------------------------------------------- 
router.get("/", async (req, res) => {
  try {
    const events = await Event.find().populate("createdBy", "username email profilePicture").lean();

    const formattedEvents = events.map((event) => {
      // normaliza fotos a objetos con url absoluta (manteniendo compatibilidad)
      const photos = Array.isArray(event.photos)
        ? event.photos
            .map((p) => toPhotoTileAbs(req, p))
            .filter(Boolean)
        : [];

      return {
        ...event,
        imageUrl: absUrlFromUpload(req, event.image),
        photos,
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
      };
    });

    res.json(formattedEvents);
  } catch (error) {
    console.error("Error al obtener los eventos:", error);
    res.status(500).json({ message: "Error al obtener los eventos", error });
  }
});

// ------------------------------------------------------------------
//Devuelve asistentes con username y avatar listos para pintar
//------------------------------------------------------------------- 
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

// ------------------------------------------------------------------
//   DETALLE DE EVENTO (público; calcula isOwner si hay usuario)
//------------------------------------------------------------------- 
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
      photos: Array.isArray(obj.photos)
        ? obj.photos.map((p) => toPhotoTileAbs(req, p)).filter(Boolean)
        : [],
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

    const userId = req.user ? req.user.id : null; // si algún middleware previo lo puso
    const isOwner = userId && obj.createdBy?._id?.toString() === userId;

    res.json({ ...formattedEvent, isOwner });
  } catch (error) {
    console.error("Error al obtener el evento:", error);
    res.status(500).json({ message: "Error al obtener el evento", error });
  }
});

// ------------------------------------------------------------------
//   ELIMINAR EVENTO (requiere usuario y ser owner)
//------------------------------------------------------------------- 
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

// ------------------------------------------------------------------
//   GALERÍA: GET fotos (y alias)
//------------------------------------------------------------------- 
async function getPhotosHandler(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }
    const event = await Event.findById(id).lean();
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    const photos = (event.photos || [])
      .map((p) => toPhotoTileAbs(req, p))
      .filter(Boolean);

    return res.json({ photos });
  } catch (e) {
    console.error("[GET photos] error:", e);
    return res.status(500).json({ message: "Error obteniendo fotos" });
  }
}

router.get("/:id/photos", getPhotosHandler);
router.get("/:id/gallery", getPhotosHandler);
router.get("/:id/images", getPhotosHandler);
router.get("/:id/media", getPhotosHandler);

// ------------------------------------------------------------------
////   GALERÍA: POST subir fotos (y alias)
//   - Acepta múltiples campos: file/files/files[]/photo/photos/photos[]/image/images/images[]
//   - Requiere usuario
v------------------------------------------------------------------- 
async function postPhotosHandler(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }
    const event = await Event.findById(id);
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    // Recoge archivos subidos, sin importar el nombre del campo
    const files = (req.files && Array.isArray(req.files) ? req.files : [])
      .concat(req.file ? [req.file] : []);

    if (!files.length) {
      return res.status(400).json({ message: "No se recibieron archivos" });
    }

    // Datos del usuario que sube
    let byUsername = "usuario";
    try {
      const userDoc = await User.findById(req.user.id).lean();
      const u = usernameFromUserDoc(userDoc);
      if (u) byUsername = u;
    } catch (_) {}

    // Carpeta para fotos de evento
    const eventPhotosDir = path.join(ROOT_UPLOADS_DIR, "event-photos");
    ensureDir(eventPhotosDir);

    const savedMeta = [];
    for (const f of files) {
      const base = `event-${id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const processed = await processImageToJpg(f.path, eventPhotosDir, base);
      const rel = path
        .relative(path.join(__dirname, ".."), processed)
        .replace(/\\/g, "/"); // ej: "uploads/event-photos/event-xxx.jpg"

      const meta = {
        url: rel,
        by: req.user.id,
        byUsername,
        uploadedAt: new Date(),
      };

      event.photos = Array.isArray(event.photos) ? event.photos : [];
      event.photos.push(meta);
      savedMeta.push(meta);
    }

    await event.save();

    // Respuesta: objetos con url absoluta + byUsername
    const uploaded = savedMeta.map((m) => ({
      url: absUrlFromUpload(req, m.url),
      byUsername: m.byUsername,
      uploadedAt: m.uploadedAt,
    }));

    const allPhotos = (event.photos || [])
      .map((p) => toPhotoTileAbs(req, p))
      .filter(Boolean);

    return res.status(201).json({
      uploaded,        // recién subidas (con autor)
      photos: allPhotos, // estado completo de galería (con autor cuando exista)
      count: uploaded.length,
    });
  } catch (e) {
    console.error("[POST photos] error:", e);
    return res.status(500).json({ message: "Error subiendo fotos", error: e.message });
  }
}

// Acepta cualquier campo / array (evita que Flutter tenga que adivinar)
router.post("/:id/photos", anyAuth, ensureUserId, uploadAny.any(), postPhotosHandler);
router.post("/:id/photos/upload", anyAuth, ensureUserId, uploadAny.any(), postPhotosHandler);
router.post("/:id/upload-photo", anyAuth, ensureUserId, uploadAny.any(), postPhotosHandler);

// ------------------------------------------------------------------
//   ALTERNAR ASISTENCIA (requiere usuario)
//   - Alterna en Mongo (campo attendees)
 //  - Escribe/borra doc en Firestore: attendances/{uid}_{eventId}
//------------------------------------------------------------------- 
router.post("/:id/attend", anyAuth, ensureUserId, async (req, res) => {
  const eventId = req.params.id;

  try {
    // 1) Recuperar evento
    if (!mongoose.isValidObjectId(eventId)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }
    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    event.attendees = Array.isArray(event.attendees) ? event.attendees : [];

    // 2) Usuario (Mongo id ya garantizado)
    const userId = req.user.id;

    // 3) Alternar asistencia en Mongo (comparando como string)
    const idx = event.attendees.findIndex((a) => a?.toString?.() === userId);
    let attendedNow = false;

    if (idx !== -1) {
      event.attendees.splice(idx, 1); // quitar
      attendedNow = false;
    } else {
      event.attendees.push(userId); // añadir
      attendedNow = true;
    }

    await event.save();

    // 4) Si viene además como Firebase (teléfono), refleja en Firestore
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

    // 5) Responder
    return res.json({
      _id: event._id,
      attendees: event.attendees,
    });
  } catch (error) {
    console.error("Error al alternar asistencia:", error);
    res.status(500).json({ message: "Error interno del servidor", error: error.message });
  }
});

module.exports = router;*/
