const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const session = require("express-session"); // si lo usas para passport
const passport = require("passport");       // si lo usas para facebook
const path = require("path");
require("dotenv").config();                 // carga .env

// ✅ Inicializa firebase-admin (lee el JSON que subiste) — no exporta nada, solo deja listo admin
require("./middlewares/firebaseAdmin");

const app = express();

// ======================= CORS =======================
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "https://nightvibe-six.vercel.app/",
    methods: ["GET", "POST", "PUT", "DELETE"],
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
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
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
  res.send(
    `<img src="${process.env.BACKEND_URL}/uploads/test.jpg" alt="Test Image" />`
  );
});

// ================== Rutas reales =====================
const authRoutes = require("./routes/authRoutes");
const eventRoutes = require("./routes/eventRoutes");
const searchRoutes = require("./routes/searchRoutes");

// 👇 NUEVO: router de usuarios (incluye GET /api/users/me/attending)
const userRoutes = require("./routes/userRoutes");

app.use("/api/auth", authRoutes);
// Antes montabas authRoutes en /api/users; ahora montamos userRoutes:
app.use("/api/users", userRoutes);
app.use("/api/events", eventRoutes);
app.use("/search", searchRoutes);

// ============= 404 catch-all =========================
app.use((req, res, next) => {
  res.status(404).send("Ruta no encontrada");
});

// ================== Server ===========================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✨ Servidor corriendo en el puerto ${PORT}`);
});

module.exports = app;
