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
   Configuración de multer (igual que ya tenías)
------------------------------------------------------------------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads"),
  filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname),
});
const upload = multer({ storage });

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
      const processedImagePath = `uploads/resized-${Date.now()}-${req.file.originalname}`;
      await sharp(req.file.path).resize(800, 450, { fit: "cover" }).toFile(processedImagePath);
      image = processedImagePath;
      fs.unlinkSync(req.file.path);
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
    //    (la pantalla Perfil lee de Firestore con el uid de Firebase)
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
              eventImageUrl: absUrlFromUpload(req, event.image), // 👈 normalizada
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        } else {
          await docRef.delete().catch(() => {});
        }
      } catch (e) {
        // No rompemos si el token no era Firebase: el toggle en Mongo ya funcionó.
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

module.exports = router;
