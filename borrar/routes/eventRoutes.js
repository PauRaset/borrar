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
const PromotionLevelTemplate = require("../models/PromotionLevelTemplate");
const UserClubPromotionProgress = require("../models/UserClubPromotionProgress");

// Tu middleware JWT actual (export default)
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

/* -------------------------------------------------------------
   Normalizadores de payload
------------------------------------------------------------- */
function parseDateMaybe(v) {
  if (!v) return undefined;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}

function parseNumberMaybe(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

function parseCategoriesMaybe(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    // Soporta JSON string o "a,b,c"
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch (_) {
      return value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(String);
    }
  }
  return [];
}

/* ------------------------------------------------------------------
   AUTH BRIDGE
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
   PROMOTIONS BRIDGE (auto-progress levels)
------------------------------------------------------------------- */

async function getGlobalPromotionTemplates() {
  const templates = await PromotionLevelTemplate.find({ scope: "global", active: true })
    .sort({ levelNumber: 1 })
    .lean();
  return templates || [];
}

function computeLevelProgress(level) {
  const missions = Array.isArray(level?.missions) ? level.missions : [];
  if (!missions.length) return 0;
  const ratios = missions.map((m) => {
    const target = Number(m.target || 1);
    const cur = Number(m.current || 0);
    if (!target || target <= 0) return 0;
    return Math.max(0, Math.min(1, cur / target));
  });
  return Math.max(0, Math.min(1, ratios.reduce((a, b) => a + b, 0) / ratios.length));
}

function allMissionsCompleted(level) {
  const missions = Array.isArray(level?.missions) ? level.missions : [];
  if (!missions.length) return false;
  return missions.every((m) => m.status === "completed");
}

function unlockNextLevel(progress, completedLevelNumber) {
  const nextLevelNumber = Number(completedLevelNumber) + 1;
  const next = (progress.levels || []).find((l) => Number(l.levelNumber) === nextLevelNumber);
  if (!next) return;

  if (next.status === "locked") {
    next.status = "in_progress";
    for (const m of next.missions || []) {
      if (m.status === "locked") m.status = "in_progress";
      if (!m.startedAt) m.startedAt = new Date();
      m.updatedAt = new Date();
    }
  }

  progress.currentLevel = nextLevelNumber;
  progress.currentRewardTitle = next.reward?.title || "";
}

function refreshCurrentSnapshot(progress) {
  const cur = (progress.levels || []).find((l) => Number(l.levelNumber) === Number(progress.currentLevel));
  if (!cur) {
    progress.currentProgress = 0;
    return;
  }
  cur.progress = computeLevelProgress(cur);
  progress.currentProgress = cur.progress;
  progress.currentRewardTitle = cur.reward?.title || "";
}

function clampNonNegative(n) {
  const x = Number(n || 0);
  return x < 0 ? 0 : x;
}

function updateAttendMissionsForLevel(level, counters) {
  for (const m of level.missions || []) {
    if (m.type !== "attend_event") continue;

    const platformWide = !!(m.params && m.params.platformWide) || !!(m.meta && m.meta.platformWide);
    const count = platformWide ? Number(counters.attendancesPlatform || 0) : Number(counters.attendancesInClub || 0);

    m.current = Math.min(count, Number(m.target || 1));

    if (level.status === "locked") continue;

    if (m.current >= Number(m.target || 1)) {
      m.status = "completed";
      m.completedAt = m.completedAt || new Date();
    } else {
      if (m.status !== "pending") m.status = "in_progress";
      m.completedAt = null;
    }

    m.updatedAt = new Date();
  }
}

function updatePhotoMissionsForLevel(level, eventId, counters) {
  for (const m of level.missions || []) {
    if (m.type !== "upload_event_photo") continue;

    const perEvent = !!(m.params && m.params.perEvent) || !!(m.meta && m.meta.perEvent);

    if (perEvent) {
      const list = Array.isArray(m.meta?.eventIds) ? m.meta.eventIds : [];
      const set = new Set(list.map(String));
      if (eventId) set.add(String(eventId));
      const updated = Array.from(set);
      m.meta = { ...(m.meta || {}), eventIds: updated, perEvent: true };
      m.current = Math.min(updated.length, Number(m.target || 1));
    } else {
      const count = Number(counters.photosUploadedInClub || 0);
      m.current = Math.min(count, Number(m.target || 1));
    }

    if (level.status === "locked") continue;

    if (m.current >= Number(m.target || 1)) {
      m.status = "completed";
      m.completedAt = m.completedAt || new Date();
    } else {
      if (m.status !== "pending") m.status = "in_progress";
      m.completedAt = null;
    }

    m.updatedAt = new Date();
  }
}

async function ensurePromotionProgressDoc({ userId, clubId }) {
  let progress = await UserClubPromotionProgress.findOne({ user: userId, club: clubId });
  if (progress) return progress;

  const templates = await getGlobalPromotionTemplates();
  if (!templates.length) return null;

  const built = UserClubPromotionProgress.buildFromTemplates({ templates, startLevel: 1 });
  progress = await UserClubPromotionProgress.create({
    user: userId,
    club: clubId,
    ...built,
  });

  return progress;
}

async function syncPromotionAfterAttend({ userId, clubId, eventId, attendedNow }) {
  try {
    const progress = await ensurePromotionProgressDoc({ userId, clubId });
    if (!progress) return;

    progress.counters = progress.counters || {};
    const delta = attendedNow ? 1 : -1;

    progress.counters.attendancesInClub = clampNonNegative((progress.counters.attendancesInClub || 0) + delta);
    progress.counters.attendancesPlatform = clampNonNegative((progress.counters.attendancesPlatform || 0) + delta);

    for (const lvl of progress.levels || []) {
      updateAttendMissionsForLevel(lvl, progress.counters);
      lvl.progress = computeLevelProgress(lvl);
    }

    let guard = 0;
    while (guard++ < 15) {
      const cur = (progress.levels || []).find((l) => Number(l.levelNumber) === Number(progress.currentLevel));
      if (!cur) break;

      cur.progress = computeLevelProgress(cur);
      if (cur.status !== "completed" && allMissionsCompleted(cur)) {
        cur.status = "completed";
        cur.completedAt = new Date();
        unlockNextLevel(progress, cur.levelNumber);
        continue;
      }
      break;
    }

    refreshCurrentSnapshot(progress);
    progress.lastEventId = eventId || progress.lastEventId;
    progress.lastActivityAt = new Date();
    await progress.save();
  } catch (e) {
    console.warn("[promotions] syncPromotionAfterAttend failed:", e?.message || e);
  }
}

async function syncPromotionAfterPhotoUpload({ userId, clubId, eventId }) {
  try {
    const progress = await ensurePromotionProgressDoc({ userId, clubId });
    if (!progress) return;

    progress.counters = progress.counters || {};
    progress.counters.photosUploadedInClub = clampNonNegative((progress.counters.photosUploadedInClub || 0) + 1);

    for (const lvl of progress.levels || []) {
      updatePhotoMissionsForLevel(lvl, eventId, progress.counters);
      lvl.progress = computeLevelProgress(lvl);
    }

    let guard = 0;
    while (guard++ < 15) {
      const cur = (progress.levels || []).find((l) => Number(l.levelNumber) === Number(progress.currentLevel));
      if (!cur) break;

      cur.progress = computeLevelProgress(cur);
      if (cur.status !== "completed" && allMissionsCompleted(cur)) {
        cur.status = "completed";
        cur.completedAt = new Date();
        unlockNextLevel(progress, cur.levelNumber);
        continue;
      }
      break;
    }

    refreshCurrentSnapshot(progress);
    progress.lastEventId = eventId || progress.lastEventId;
    progress.lastActivityAt = new Date();
    await progress.save();
  } catch (e) {
    console.warn("[promotions] syncPromotionAfterPhotoUpload failed:", e?.message || e);
  }
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

/* -------------------------------------------------------------
   Normalizador público de usuario (para asistentes)
------------------------------------------------------------- */
function shapePublicUser(req, u) {
  if (!u) return null;
  const username =
    u.username ||
    (u.phoneNumber ? String(u.phoneNumber).replace("+", "") : "") ||
    "";
  const displayName = u.displayName || u.name || "";
  const profilePicture = u.profilePicture || null; // relativo (frontend lo sabe resolver)
  return {
    _id: u._id,
    id: String(u._id || ""),
    username,
    displayName,
    profilePicture,                             // 👈 clave que busca el front
    avatarUrl: absUrlFromUpload(req, profilePicture), // comodidad
  };
}

/* ------------------------------------------------------------------
   CREAR EVENTO  (requiere usuario)
------------------------------------------------------------------- */
router.post("/", anyAuth, ensureUserId, upload.single("image"), async (req, res) => {
  try {
    const {
      title,
      description,
      // fechas (compat: si solo viene "date", la usamos como startAt)
      startAt: startAtRaw,
      endAt: endAtRaw,
      date: legacyDate,

      // ubicación
      city,
      street,
      postalCode,

      // extras
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

    // Normalizar fechas
    const startAt = parseDateMaybe(startAtRaw || legacyDate);
    const endAt   = parseDateMaybe(endAtRaw);

    // Normalizar categorías
    const parsedCategories = parseCategoriesMaybe(categories);

    // age/price a número (si vienen string)
    const ageNum   = parseNumberMaybe(age);
    const priceNum = parseNumberMaybe(price);

    const newEvent = new Event({
      title,
      description,

      // fechas
      startAt,
      endAt,
      date: startAt || undefined, // compat con código legacy que mire "date"

      // ubicación
      city,
      street,
      postalCode,

      // imagen principal
      image,

      // extras
      categories: parsedCategories,
      age: typeof ageNum === "number" ? ageNum : age,
      dressCode,
      price: typeof priceNum === "number" ? priceNum : price,
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
    const events = await Event.find().populate("createdBy", "username email profilePicture displayName").lean();

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
          : parseCategoriesMaybe(event.categories),
      };
    });

    res.json(formattedEvents);
  } catch (error) {
    console.error("Error al obtener los eventos:", error);
    res.status(500).json({ message: "Error al obtener los eventos", error });
  }
});

/* ------------------------------------------------------------------
   BUSCAR EVENTOS (público)
   GET /api/events/search?q=...
   ⚠️ IMPORTANTE: esta ruta debe ir ANTES que cualquier /:id
------------------------------------------------------------------- */
router.get("/search", async (req, res) => {
  try {
    const qRaw = (req.query.q || req.query.query || req.query.search || "").toString();
    const q = qRaw.trim();

    if (!q) {
      return res.json([]);
    }

    // Escapar regex para evitar caracteres especiales.
    const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(escapeRegExp(q), "i");

    // Busca por campos comunes.
    // (Si quieres afinar luego: categorías, clubName/entityName, etc.)
    const filter = {
      $or: [
        { title: rx },
        { description: rx },
        { city: rx },
        { street: rx },
        { postalCode: rx },
        { categories: rx }, // categories suele ser array; Mongoose soporta regex sobre arrays de strings
      ],
    };

    const events = await Event.find(filter)
      .sort({ startAt: 1, date: 1, createdAt: -1 })
      .limit(40)
      .populate("createdBy", "username email profilePicture displayName")
      .lean();

    const formattedEvents = events.map((event) => {
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
          : parseCategoriesMaybe(event.categories),
      };
    });

    return res.json(formattedEvents);
  } catch (error) {
    console.error("[GET /events/search] Error al buscar eventos:", error);
    return res.status(500).json({
      message: "Error al buscar eventos",
      error: error.message || String(error),
    });
  }
});

/* ------------------------------------------------------------------
   Devuelve asistentes
   - ?full=1 -> lista plana de usuarios (frontend la admite)
   - sin ?full -> { attendees: [...] } (compat)
   - alias: /:id/attendees/populated -> fuerza full
------------------------------------------------------------------- */
async function attendeesHandler(req, res, forceFull = false) {
  try {
    const id = req.params.id;
    const full = forceFull || req.query.full === "1" || req.query.full === "true";

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }

    const event = await Event.findById(id)
      .populate("attendees", "username displayName profilePicture phoneNumber")
      .lean();

    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    const list = (event.attendees || []).map((u) => shapePublicUser(req, u)).filter(Boolean);
    
    // Promotions: actualizar progreso (Nivel 1 etc.)
    // Club = creador del evento
    const clubId = event.createdBy ? event.createdBy.toString() : null;
    if (clubId) {
      await syncPromotionAfterAttend({
        userId,
        clubId,
        eventId,
        attendedNow,
      });
    }


    if (full) {
      // lista directa (frontend lo soporta)
      return res.json(list);
    }
    // compat: objeto con clave attendees
    return res.json({ attendees: list });
  } catch (err) {
    console.error("[GET /events/:id/attendees] error:", err);
    res.status(500).json({ message: "Error obteniendo asistentes" });
  }
}

router.get("/:id/attendees", (req, res) => attendeesHandler(req, res, false));
router.get("/:id/attendees/populated", (req, res) => attendeesHandler(req, res, true));

/* ------------------------------------------------------------------
   DETALLE DE EVENTO (público; calcula isOwner si hay usuario)
------------------------------------------------------------------- */
router.get("/:id", async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).populate(
      "createdBy",
      "username email profilePicture displayName"
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
        : parseCategoriesMaybe(obj.categories),
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
    
    // Promotions: cada foto subida cuenta para misiones (Nivel 1/2 etc.)
    const clubId = event.createdBy ? event.createdBy.toString() : null;
    if (clubId) {
      for (let i = 0; i < savedMeta.length; i++) {
        await syncPromotionAfterPhotoUpload({ userId: req.user.id, clubId, eventId: id });
      }
    }

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
   GALERÍA: DELETE foto(s) (solo propietario)
------------------------------------------------------------------- */
router.delete("/:id/photos/:pid?", anyAuth, ensureUserId, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }

    const event = await Event.findById(id);
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    // Solo el propietario puede borrar fotos
    if (event.createdBy?.toString() !== req.user.id) {
      return res.status(403).json({ message: "No tienes permiso para borrar fotos de este evento" });
    }

    // Normalizar parámetros
    const q = { ...req.query, ...req.body };
    const pid = req.params.pid; // opcional
    let idx = q.idx ?? undefined;
    let url = q.url ?? undefined;
    if (typeof idx === "string" && idx.trim() !== "") idx = Number(idx);

    const photos = Array.isArray(event.photos) ? event.photos : [];

    // Resolver índice a borrar
    let targetIndex = -1;

    if (Number.isInteger(idx) && idx >= 0 && idx < photos.length) {
      targetIndex = idx;
    } else {
      // Por URL (soportar absoluta o relativa)
      const search = (pid && pid !== "undefined") ? pid : url;
      if (!search) {
        return res.status(400).json({ message: "Debes proporcionar idx o url" });
      }
      const toRel = (v) => {
        if (!v) return "";
        if (typeof v !== "string") v = String(v);
        if (v.startsWith("http")) {
          const i = v.indexOf("/uploads/");
          return i !== -1 ? v.substring(i + 1) : v; // quitar leading slash luego
        }
        return v.replace(/^\/+/, "");
      };
      const needle = toRel(search);
      targetIndex = photos.findIndex((p) => {
        const cand = typeof p === "string"
          ? toRel(p)
          : toRel(p?.url || p?.path || p?.image || p?.photo);
        return cand === needle;
      });
      if (targetIndex === -1) {
        return res.status(404).json({ message: "Foto no encontrada" });
      }
    }

    // Extraer info de la foto a borrar
    const removedEntry = photos[targetIndex];
    const relPath = (typeof removedEntry === "string")
      ? removedEntry
      : (removedEntry?.url || removedEntry?.path || removedEntry?.image || removedEntry?.photo || "");

    // Borrar archivo físico si está dentro de /uploads
    try {
      const ROOT = path.join(__dirname, "..");
      const abs = path.join(ROOT, relPath.replace(/^\/+/, ""));
      const uploadsRoot = path.join(ROOT, "uploads");
      if (abs.startsWith(uploadsRoot) && fs.existsSync(abs)) {
        fs.unlinkSync(abs);
      }
    } catch (e) {
      console.warn("[DELETE photo] no se pudo eliminar archivo físico:", e?.message || e);
    }

    // Quitar del array y guardar
    event.photos.splice(targetIndex, 1);
    await event.save();

    // Devolver listado normalizado
    const outPhotos = (event.photos || [])
      .map((p) => toPhotoTileAbs(req, p))
      .filter(Boolean);

    return res.json({
      removed: (typeof removedEntry === "string")
        ? { url: absUrlFromUpload(req, removedEntry) }
        : {
            url: absUrlFromUpload(req, removedEntry?.url || removedEntry?.path || removedEntry?.image || removedEntry?.photo),
            byUsername: removedEntry?.byUsername || null,
            uploadedAt: removedEntry?.uploadedAt || null,
          },
      photos: outPhotos,
    });
  } catch (e) {
    console.error("[DELETE /events/:id/photos] error:", e);
    return res.status(500).json({ message: "Error borrando foto", error: e.message });
  }
});

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
   🚀 UPDATE + IMAGEN PRINCIPAL
================================================================== */

// Helpers para update
function sanitizeUpdate(payload) {
  const clean = { ...payload };
  [
    "_id",
    "id",
    "createdAt",
    "updatedAt",
    "__v",
    "createdBy",
    "attendees",
    "photos",
  ].forEach((k) => delete clean[k]);
  return clean;
}

async function updateEventHandler(req, res) {
  try {
    const id = req.params.id;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }

    // 1) Buscar evento y verificar ownership
    const event = await Event.findById(id);
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    if (event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: "No tienes permiso para editar este evento" });
    }

    // 2) Construir update
    const update = sanitizeUpdate(req.body);

    // Normalizar fechas
    const startAt = parseDateMaybe(req.body.startAt || req.body.date);
    const endAt   = parseDateMaybe(req.body.endAt);
    if (startAt) {
      update.startAt = startAt;
      // por compat, si alguien en front aún mira "date"
      update.date = startAt;
    }
    if (endAt) update.endAt = endAt;

    // Normalizar categorías
    if (typeof req.body.categories !== "undefined") {
      update.categories = parseCategoriesMaybe(req.body.categories);
    }

    // age/price a número si aplica
    if (typeof req.body.age !== "undefined") {
      const ageNum = parseNumberMaybe(req.body.age);
      update.age = typeof ageNum === "number" ? ageNum : req.body.age;
    }
    if (typeof req.body.price !== "undefined") {
      const priceNum = parseNumberMaybe(req.body.price);
      update.price = typeof priceNum === "number" ? priceNum : req.body.price;
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
        .relative(path.join(__dirname, ".."), processedImagePath)
        .replace(/\\/g, "/");
    }

    // 4) Actualizar y devolver formateado
    const updated = await Event.findByIdAndUpdate(id, update, { new: true })
      .populate("createdBy", "username email profilePicture displayName")
      .lean();

    const formatted = {
      ...updated,
      imageUrl: absUrlFromUpload(req, updated.image),
      photos: Array.isArray(updated.photos)
        ? updated.photos.map((p) => toPhotoTileAbs(req, p)).filter(Boolean)
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
    console.error("[UPDATE /events/:id] error:", err);
    return res
      .status(500)
      .json({ message: "Error actualizando el evento", error: err.message });
  }
}

// PATCH y PUT -> mismo handler
router.patch("/:id", anyAuth, ensureUserId, upload.single("image"), updateEventHandler);
router.put("/:id",   anyAuth, ensureUserId, upload.single("image"), updateEventHandler);

// Subir/cambiar imagen principal
router.post("/:id/image", anyAuth, ensureUserId, upload.single("image"), async (req, res) => {
  try {
    const id = req.params.id;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }

    const event = await Event.findById(id);
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    if (event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: "No tienes permiso para cambiar la imagen" });
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
      .relative(path.join(__dirname, ".."), processedImagePath)
      .replace(/\\/g, "/");

    event.image = rel;
    await event.save();

    return res.json({
      _id: event._id,
      image: rel,
      imageUrl: absUrlFromUpload(req, rel),
    });
  } catch (err) {
    console.error("[POST /events/:id/image] error:", err);
    return res
      .status(500)
      .json({ message: "Error subiendo imagen", error: err.message });
  }
});

module.exports = router;
