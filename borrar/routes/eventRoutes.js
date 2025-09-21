const express = require("express");
const multer = require("multer");
const path = require("path");
const sharp = require("sharp");
const fs = require("fs");

const router = express.Router();

const Event = require("../models/Event");
const User = require("../models/User");

// Tu middleware JWT actual
const authenticateToken = require("../middlewares/authMiddleware");

// Inicializa firebase-admin (y permite usar admin directamente)
require("../middlewares/firebaseAdmin");
const admin = require("firebase-admin");

/* ------------------------------------------------------------------
   AUTH BRIDGE
   - anyAuth: acepta Firebase o tu JWT.
   - ensureUserId: si viene de Firebase, resuelve/crea un User y setea
     req.user.id con el ObjectId que usa tu base de datos.
------------------------------------------------------------------- */

// decide en tiempo real si verificar Firebase o JWT
function anyAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token =
    auth.startsWith("Bearer ") || auth.startsWith("Firebase ")
      ? auth.split(" ")[1]
      : null;

  if (!token) return authenticateToken(req, res, next);

  // 1) Intentar como Firebase ID token
  admin
    .auth()
    .verifyIdToken(token)
    .then((decoded) => {
      req.firebaseUser = {
        uid: decoded.uid,
        phone: decoded.phone_number || decoded.phoneNumber || null,
      };
      next();
    })
    .catch(() => {
      // 2) No era Firebase -> probar tu JWT clásico
      authenticateToken(req, res, next);
    });
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
    const events = await Event.find().populate("createdBy", "username email profilePicture");

    const formattedEvents = events.map((event) => ({
      ...event.toObject(),
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
   DETALLE DE EVENTO (público; calcula isOwner si hay usuario)
------------------------------------------------------------------- */
router.get("/:id", async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).populate(
      "createdBy",
      "username email profilePicture"
    );
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    const formattedEvent = {
      ...event.toObject(),
      categories: Array.isArray(event.categories)
        ? event.categories
        : (event.categories || []).map((cat) =>
            typeof cat === "string" ? cat : String(cat)
          ),
    };

    const userId = req.user ? req.user.id : null; // si algún middleware previo lo puso
    const isOwner = userId && event.createdBy?._id?.toString() === userId;

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
------------------------------------------------------------------- */
router.post("/:id/attend", anyAuth, ensureUserId, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    const userId = req.user.id;

    // Igualdad por string para evitar problemas de ObjectId
    const userIndex = event.attendees.findIndex((a) => a.toString() === userId);

    if (userIndex !== -1) {
      event.attendees.splice(userIndex, 1); // quitar
    } else {
      event.attendees.push(userId); // añadir
    }

    await event.save();
    res.json(event);
  } catch (error) {
    console.error("Error al alternar asistencia:", error);
    res.status(500).json({ message: "Error interno del servidor", error });
  }
});

module.exports = router;