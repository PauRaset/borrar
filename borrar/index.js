// index.js (entrypoint)
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const session = require("express-session");
const passport = require("passport");
const path = require("path");
const bodyParser = require("body-parser"); // <- para el webhook RAW
const Stripe = require("stripe");          // <- Stripe SDK
require("dotenv").config();

// ✅ Inicializa firebase-admin (solo imprime 1 línea)
require("./middlewares/firebaseAdmin");

const app = express();

/* ===== Stripe ===== */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* ===== CORS ===== */
const FRONTEND_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
const allowedOrigins = new Set([
  FRONTEND_URL,
  "https://nightvibe-six.vercel.app",
  "http://localhost:3000",
]);
app.use(
  cors({
    origin: (origin, cb) =>
      !origin || allowedOrigins.has(origin)
        ? cb(null, true)
        : cb(new Error(`CORS no permitido para: ${origin}`)),
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    credentials: true,
  })
);

/* ===== Webhook Stripe (RAW body) — debe ir ANTES de express.json() ===== */
app.post(
  "/api/webhooks/stripe",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      console.log(
        "✅ Pago OK:",
        session.id,
        "email:",
        session.customer_details?.email
      );

      // 👉 Aquí, en el siguiente paso, emitimos tickets + QR + email
    }

    res.json({ received: true });
  }
);

/* ===== Parsers & estáticos ===== */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/* ===== Sesiones ===== */
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

/* ===== Passport (si lo usas) ===== */
app.use(passport.initialize());
app.use(passport.session());
require("./passportConfig");

/* ===== MongoDB ===== */
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ Conectado a MongoDB"))
  .catch((err) => console.error("❌ Error al conectar a MongoDB:", err));

/* ===== Rutas base ===== */
app.get("/", (_req, res) => res.send("¡Servidor funcionando correctamente!"));
app.get("/test-image", (req, res) => {
  const base = (
    process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`
  ).replace(/\/+$/, "");
  res.send(`<img src="${base}/uploads/test.jpg" alt="Test Image" />`);
});

/* ===== Stripe Checkout: crear orden ===== */
app.post("/api/orders", async (req, res) => {
  try {
    const { eventId, items, userId, phone } = req.body;

    // items: [{ ticketTypeId, name, unitAmount, qty, currency }]
    const line_items = (items || []).map((it) => ({
      quantity: it.qty,
      price_data: {
        currency: it.currency || "eur",
        unit_amount: it.unitAmount, // céntimos
        product_data: { name: `${it.name} · ${eventId}` },
      },
    }));

    const successBase =
      process.env.FRONTEND_URL || "https://event-app-prod.vercel.app";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      success_url: `${successBase.replace(
        /\/+$/,
        ""
      )}/purchase/success?sid={CHECKOUT_SESSION_ID}`,
      cancel_url: `${successBase.replace(/\/+$/, "")}/purchase/cancel`,
      customer_creation: "always",
      metadata: {
        eventId,
        userId: userId || "",
        phone: phone || "",
      },
      phone_number_collection: { enabled: true }, // opcional
      // allow_promotion_codes: true,
      // automatic_tax: { enabled: true },
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("❌ Error creando sesión de Stripe:", e);
    res.status(500).json({ error: "stripe_session_error" });
  }
});

/* ===== Rutas de tu app ===== */
const authRoutes = require("./routes/authRoutes");
const eventRoutes = require("./routes/eventRoutes");
const searchRoutes = require("./routes/searchRoutes");
const userRoutes = require("./routes/userRoutes");

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/events", eventRoutes);
app.use("/search", searchRoutes);

/* ===== 404 ===== */
app.use((_req, res) => res.status(404).send("Ruta no encontrada"));

/* ===== Server ===== */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✨ Servidor corriendo en el puerto ${PORT}`);
});

module.exports = app;

/*// index.js (entrypoint)
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const session = require("express-session");
const passport = require("passport");
const path = require("path");
require("dotenv").config();

// ✅ Inicializa firebase-admin (solo imprime 1 línea)
require("./middlewares/firebaseAdmin");

const app = express();

// ===== CORS ===== 
const FRONTEND_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
const allowedOrigins = new Set([
  FRONTEND_URL,
  "https://nightvibe-six.vercel.app",
  "http://localhost:3000",
]);
app.use(
  cors({
    origin: (origin, cb) => (!origin || allowedOrigins.has(origin)) ? cb(null, true) : cb(new Error(`CORS no permitido para: ${origin}`)),
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    credentials: true,
  })
);

// ===== Parsers & estáticos ===== 
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ===== Sesiones ===== 
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

// ===== Passport (si lo usas) ===== 
app.use(passport.initialize());
app.use(passport.session());
require("./passportConfig");

// ===== MongoDB ===== 
mongoose
  .connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ Conectado a MongoDB"))
  .catch((err) => console.error("❌ Error al conectar a MongoDB:", err));

// ===== Rutas ===== 
app.get("/", (_req, res) => res.send("¡Servidor funcionando correctamente!"));
app.get("/test-image", (req, res) => {
  const base = (process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
  res.send(`<img src="${base}/uploads/test.jpg" alt="Test Image" />`);
});

const authRoutes = require("./routes/authRoutes");
const eventRoutes = require("./routes/eventRoutes");
const searchRoutes = require("./routes/searchRoutes");
const userRoutes = require("./routes/userRoutes");

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/events", eventRoutes);
app.use("/search", searchRoutes);

// ===== 404 ===== 
app.use((_req, res) => res.status(404).send("Ruta no encontrada"));

// ===== Server ===== 
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✨ Servidor corriendo en el puerto ${PORT}`);
});

module.exports = app;*/
