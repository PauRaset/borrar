// index.js (entrypoint)
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const session = require("express-session");
const passport = require("passport");
const path = require("path");
const bodyParser = require("body-parser"); // <- para el webhook RAW
const Stripe = require("stripe");          // <- Stripe SDK
const clubRoutes = require("./routes/clubRoutes");

// ✅ Inicializa firebase-admin (solo imprime 1 línea)
require("./middlewares/firebaseAdmin");

const app = express();

// ===== Stripe =====
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ===== CARGAS NUEVAS (models/utils) =====
const QRCode = require("qrcode");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Order = require("./models/Order");
const Ticket = require("./models/Ticket");
const CheckInLog = require("./models/CheckInLog");
const sendTicketEmail = require("./utils/sendTicketEmail");

// (opcional) Modelo Club para pagos al organizador vía Stripe Connect
let Club = null;
try {
  Club = require("./models/Club"); // Debe exponer { stripeAccountId }
} catch {
  console.warn("ℹ️ models/Club no encontrado. Payouts a clubs deshabilitados.");
}

// (opcional) Modelo Event para resolver clubId a partir del eventId
let Event = null;
try {
  Event = require("./models/Event"); // Debe exponer { clubId } en el evento
} catch {
  console.warn("ℹ️ models/Event no encontrado. Resolución de clubId por eventId limitada al body.");
}

// ============================================================================
//   CORS — permitir clubs.nightvibe.life, previews de Vercel y FRONTEND_URL
// ============================================================================
const FRONTEND_URL = (process.env.FRONTEND_URL || "https://clubs.nightvibe.life").replace(/\/+$/, "");

const staticAllowed = new Set([
  FRONTEND_URL,
  "https://nightvibe-six.vercel.app",
  "http://localhost:3000",
  "https://clubs.nightvibe.life",
  "https://nvclubs.vercel.app",
]);

function isAllowedOrigin(origin) {
  try {
    if (!origin) return true; // curl / apps nativas
    if (staticAllowed.has(origin)) return true;

    const { hostname } = new URL(origin);
    if (hostname.endsWith(".vercel.app")) return true;      // previews
    if (hostname.endsWith(".nightvibe.life")) return true;  // subdominios

    return false;
  } catch {
    return false;
  }
}

app.use(
  cors({
    origin: (origin, cb) =>
      isAllowedOrigin(origin)
        ? cb(null, true)
        : cb(new Error(`CORS no permitido para: ${origin}`)),
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    credentials: true,
  })
);
// Responder preflight explícitamente
app.options("*", cors());

// ===== Helper: resolver clubId y cuenta destino =====
async function resolveClubContext({ eventId, clubIdFromBody }) {
  let clubId = clubIdFromBody || null;

  // 1) Si no viene clubId y tenemos Event, lo intentamos derivar del evento
  if (!clubId && Event && eventId) {
    try {
      const ev = await Event.findById(eventId).select("clubId").lean();
      clubId = ev?.clubId ? String(ev.clubId) : null;
    } catch (e) {
      console.warn("⚠️ No se pudo obtener clubId desde Event:", e?.message || e);
    }
  }

  // 2) Si tenemos Club y clubId, cargamos stripeAccountId
  let destinationAccount = null;
  if (Club && clubId) {
    try {
      const club = await Club.findById(clubId).select("stripeAccountId name").lean();
      destinationAccount = club?.stripeAccountId || null; // acct_xxx
      if (!destinationAccount) {
        console.warn(`⚠️ Club ${clubId} no tiene stripeAccountId asignado.`);
      }
    } catch (e) {
      console.warn("⚠️ No se pudo cargar Club:", e?.message || e);
    }
  }

  return { clubId, destinationAccount };
}

// ===== Webhook Stripe (RAW body) — debe ir ANTES de express.json() =====
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

    // ===== EMISIÓN DE TICKETS + EMAIL =====
    if (event.type === "checkout.session.completed") {
      const sessionObj = event.data.object;
      console.log(
        "✅ Pago OK:",
        sessionObj.id,
        "email:",
        sessionObj.customer_details?.email
      );

      try {
        // 1) Datos base del pago (desde la Session)
        const email  = sessionObj.customer_details?.email || null;
        const name   = sessionObj.customer_details?.name  || "";
        const eventId = sessionObj.metadata?.eventId || "EVT";
        const clubIdMeta  = sessionObj.metadata?.clubId || null;
        const userId  = sessionObj.metadata?.userId || null;
        const phone   = sessionObj.metadata?.phone  || null;
        const paymentIntentId = sessionObj.payment_intent || null;

        // 2) Recuperar line items reales
        const lineItems = await stripe.checkout.sessions.listLineItems(
          sessionObj.id,
          { limit: 100 }
        );

        // Calcular subtotal y moneda (a partir del primer item)
        let subtotalCents = 0;
        let currency = "eur";
        for (const li of lineItems.data) {
          const qty = li.quantity || 1;
          const unit = li.amount_total
            ? Math.floor(li.amount_total / qty)
            : li.price?.unit_amount || 0;
          subtotalCents += unit * qty;
          currency = (li.price?.currency || currency || "eur").toLowerCase();
        }

        // 3) Recuperar PaymentIntent para capturar application_fee y destino Connect
        let applicationFeeCents = 0;
        let destinationAccount = sessionObj.metadata?.destinationAccount || null;
        let chargeId = null;
        let balanceTxId = null;

        if (paymentIntentId) {
          try {
            const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
              expand: ["latest_charge", "transfer_data"],
            });
            if (pi?.application_fee_amount) {
              applicationFeeCents = pi.application_fee_amount;
            }
            if (pi?.transfer_data?.destination) {
              destinationAccount = pi.transfer_data.destination; // acct_***
            }
            const charge = pi?.latest_charge;
            if (typeof charge === "object") {
              chargeId = charge.id || null;
              balanceTxId = charge.balance_transaction || null;
            }
          } catch (e) {
            console.warn("⚠️ No se pudo expandir PaymentIntent:", e?.message || e);
          }
        }

        // 3.bis) Si aún no tuviéramos clubId, intentarlo resolver (por si el frontend no lo pasó)
        let clubId = clubIdMeta;
        if (!clubId && Event && eventId) {
          try {
            const ev = await Event.findById(eventId).select("clubId").lean();
            clubId = ev?.clubId ? String(ev.clubId) : null;
          } catch {}
        }

        // 4) Crear/actualizar Order
        const order = await Order.findOneAndUpdate(
          { stripeSessionId: sessionObj.id },
          {
            stripeSessionId: sessionObj.id,
            paymentIntentId,
            chargeId,
            balanceTxId,

            // Comprador
            userId,
            phone,
            email,
            buyerName: name,

            // Negocio / evento
            clubId,
            eventId,

            // Items
            items: lineItems.data.map((li) => ({
              ticketTypeId: li.price?.product || null,
              name:
                li.description ||
                li.price?.nickname ||
                li.price?.product ||
                "Entrada",
              unitAmount: li.amount_total
                ? Math.floor(li.amount_total / (li.quantity || 1))
                : li.price?.unit_amount || 0,
              qty: li.quantity || 1,
              currency: (li.price?.currency || currency || "eur").toLowerCase(),
            })),

            // Totales / fees
            currency,
            subtotalCents,
            applicationFeeCents,
            destinationAccount,

            // Metadatos
            sessionMetadata: sessionObj.metadata || {},

            status: "paid",
          },
          { upsert: true, new: true }
        );

        // (Opcional) título/fecha del evento para el email
        const eventTitle = `Evento ${eventId}`;
        const eventDate = "";

        // 5) Emitir tickets: 1 por unidad
        for (const li of lineItems.data) {
          const qty = li.quantity || 1;
          for (let i = 0; i < qty; i++) {
            // token + firma HMAC
            const token = crypto.randomBytes(16).toString("base64url"); // 128 bits
            const hmac = crypto
              .createHmac("sha256", process.env.QR_HMAC_KEY)
              .update(`${token}|${eventId}`)
              .digest("base64url");
            const payload = `NV1:t=${token}&e=${eventId}&s=${hmac}`;

            // solo guardamos hash del token
            const tokenHash = await bcrypt.hash(token, 10);

            // serial corto legible (p.ej. NV-AB12-3F)
            const serial = `NV-${crypto
              .randomBytes(2)
              .toString("hex")
              .toUpperCase()}-${crypto
              .randomBytes(1)
              .toString("hex")
              .toUpperCase()}`;

            // persistir ticket
            const ticket = await Ticket.create({
              eventId,
              orderId: order._id,
              ownerUserId: userId,
              email,
              ticketTypeId: li.price?.product || null,
              serial,
              tokenHash,
              status: "issued",
            });

            // QR PNG (con el payload firmado)
            const qrPng = await QRCode.toBuffer(payload, {
              errorCorrectionLevel: "M",
              width: 480,
            });

            // email con la entrada (si hay email)
            if (email) {
              await sendTicketEmail({
                to: email,
                eventTitle,
                eventDate,
                serial: ticket.serial,
                qrPngBuffer: qrPng,
              });
            } else {
              console.log(
                "⚠️ Ticket emitido SIN email (no disponible): serial",
                ticket.serial
              );
            }
          }
        }

        console.log("🎟️  Tickets emitidos para order", order._id.toString());
      } catch (err) {
        console.error("❌ Error procesando checkout.session.completed:", err);
      }
    }

    res.json({ received: true });
  }
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
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ Conectado a MongoDB"))
  .catch((err) => console.error("❌ Error al conectar a MongoDB:", err));

// ===== Rutas base =====
app.get("/", (_req, res) => res.send("¡Servidor funcionando correctamente!"));
app.get("/test-image", (req, res) => {
  const base = (
    process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`
  ).replace(/\/+$/, "");
  res.send(`<img src="${base}/uploads/test.jpg" alt="Test Image" />`);
});

// ===== Stripe Checkout: crear orden (con validación + payouts Connect) =====
app.post("/api/orders", async (req, res) => {
  try {
    const { eventId, items, userId, phone, clubId: clubIdFromBody } = req.body;

    // Validaciones básicas
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ error: "missing_items", message: "No hay items en la orden." });
    }

    // Construcción segura de line_items
    const line_items = items.map((it, idx) => {
      const name = (it?.name || "Entrada").toString();
      const currency = ((it?.currency || "eur") + "").toLowerCase();
      const qty = Number.isFinite(it?.qty) && it.qty > 0 ? Math.floor(it.qty) : 1;

      // unit_amount debe ser entero en céntimos y >= 50
      let unitAmount = Number(it?.unitAmount);
      if (!Number.isFinite(unitAmount)) {
        throw new Error(`items[${idx}].unitAmount inválido`);
      }
      unitAmount = Math.round(unitAmount);
      if (unitAmount < 50) {
        throw new Error(
          `El importe mínimo por entrada es 50 céntimos. Recibido: ${unitAmount}`
        );
      }

      return {
        quantity: qty,
        price_data: {
          currency,
          unit_amount: unitAmount,
          product_data: { name: `${name} · ${eventId || ""}` },
        },
      };
    });

    // Calcula application fee (opcional)
    const subtotal = line_items.reduce(
      (acc, li) => acc + li.price_data.unit_amount * li.quantity,
      0
    );
    const bps = parseInt(process.env.PLATFORM_FEE_BPS || "0", 10);     // basis points
    const fixed = parseInt(process.env.PLATFORM_FEE_FIXED || "0", 10); // céntimos
    const applicationFee = Math.max(0, Math.round((subtotal * bps) / 10000) + fixed);

    // 🔎 Resolver clubId + destinationAccount
    const { clubId, destinationAccount } = await resolveClubContext({
      eventId,
      clubIdFromBody,
    });

    console.log("🧭 Checkout context => clubId:", clubId, "destinationAccount:", destinationAccount || "(none)");

    const successBase = FRONTEND_URL;

    // Parámetros base del Checkout
    const sessionParams = {
      mode: "payment",
      line_items,
      success_url: `${successBase}/purchase/success?sid={CHECKOUT_SESSION_ID}`,
      cancel_url: `${successBase}/purchase/cancel`,
      customer_creation: "always",
      metadata: {
        eventId: eventId || "",
        userId: userId || "",
        phone: phone || "",
        clubId: clubId || "",

        // Copias útiles para el webhook / debug:
        destinationAccount: destinationAccount || "",
        applicationFeeCents: String(applicationFee || 0),
      },
      phone_number_collection: { enabled: true },
    };

    // Si tenemos cuenta Connect del club, activamos payouts + fee
    if (destinationAccount) {
      sessionParams.payment_intent_data = {
        transfer_data: { destination: destinationAccount }, // 💸 neto al club
        application_fee_amount: applicationFee,             // 💰 tu fee
      };
    } else {
      console.warn("⚠️ No hay destinationAccount (acct_...). El cobro irá a tu plataforma.");
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    console.log("🧾 Stripe session creada:", session.id, "dest:", destinationAccount || "(platform)");
    return res.json({ url: session.url });
  } catch (e) {
    console.error(
      "❌ /api/orders error:",
      e?.type || "",
      e?.code || "",
      e?.message || e,
      e?.raw?.message || ""
    );
    return res.status(500).json({
      error: "stripe_session_error",
      message: e?.raw?.message || e?.message || "No se pudo crear la sesión de pago.",
    });
  }
});

// ===== Check-in de tickets (escáner) =====
app.post("/api/checkin", async (req, res) => {
  try {
    // Seguridad básica por API key (MVP)
    const key = req.headers["x-scanner-key"];
    if (!key || key !== process.env.SCANNER_API_KEY) {
      return res.status(401).json({ ok: false, reason: "unauthorized" });
    }

    const { token, eventId, hmac } = req.body || {};
    if (!token || !eventId || !hmac) {
      return res.status(400).json({ ok: false, reason: "bad_request" });
    }

    // Verificar firma HMAC
    const expected = crypto
      .createHmac("sha256", process.env.QR_HMAC_KEY)
      .update(`${token}|${eventId}`)
      .digest("base64url");
    if (expected !== hmac) {
      await CheckInLog.create({
        ticketId: null,
        eventId,
        result: "bad_signature",
      });
      return res.status(400).json({ ok: false, reason: "bad_signature" });
    }

    // Buscar ticket por comparación de hash (MVP)
    const candidates = await Ticket.find({
      eventId,
      status: { $in: ["issued", "checked_in"] },
    }).limit(10000);

    let found = null;
    for (const t of candidates) {
      const ok = await bcrypt.compare(token, t.tokenHash);
      if (ok) {
        found = t;
        break;
      }
    }

    if (!found) {
      await CheckInLog.create({ ticketId: null, eventId, result: "invalid" });
      return res.status(404).json({ ok: false, reason: "invalid" });
    }

    // Cargar orden para devolver buyerName/email
    let buyerName = "";
    let buyerEmail = "";
    try {
      if (found.orderId) {
        const ord = await Order.findById(found.orderId)
          .select("buyerName email")
          .lean();
        if (ord) {
          buyerName = ord.buyerName || "";
          buyerEmail = ord.email || "";
        }
      }
    } catch { /* noop */ }

    if (found.status === "checked_in") {
      await CheckInLog.create({
        ticketId: found._id,
        eventId,
        result: "duplicate",
      });
      return res.json({
        ok: false,
        reason: "duplicate",
        serial: found.serial,
        checkedInAt: found.checkedInAt,
        buyerName,
        buyerEmail,
      });
    }

    // Update atómico
    const updated = await Ticket.findOneAndUpdate(
      { _id: found._id, status: "issued" },
      {
        $set: {
          status: "checked_in",
          checkedInAt: new Date(),
          checkedInBy: "scanner",
        },
      },
      { new: true }
    );

    const result = updated ? "ok" : "duplicate";
    await CheckInLog.create({
      ticketId: found._id,
      eventId,
      result,
    });

    return res.json({
      ok: result === "ok",
      serial: found.serial,
      status: updated?.status || found.status,
      checkedInAt: updated?.checkedInAt || found.checkedInAt,
      buyerName,
      buyerEmail,
    });
  } catch (e) {
    console.error("❌ Error en /api/checkin:", e);
    return res.status(500).json({ ok: false, reason: "server_error" });
  }
});

// ===== Rutas de tu app =====
const authRoutes = require("./routes/authRoutes");
const eventRoutes = require("./routes/eventRoutes");
const searchRoutes = require("./routes/searchRoutes");
const userRoutes = require("./routes/userRoutes");
const registrationRoutes = require("./routes/registrationRoutes"); // <-- MOVIDO AQUÍ

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/events", eventRoutes);
app.use("/search", searchRoutes);
app.use("/api/registration", registrationRoutes); // <-- Y montado AQUÍ
app.use("/api/clubs", clubRoutes);

// ===== 404 =====
app.use((_req, res) => res.status(404).send("Ruta no encontrada"));

// ===== Server =====
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✨ Servidor corriendo en el puerto ${PORT}`);
});

module.exports = app;

/*// index.js (entrypoint)
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const session = require("express-session");
const passport = require("passport");
const path = require("path");
const bodyParser = require("body-parser"); // <- para el webhook RAW
const Stripe = require("stripe");          // <- Stripe SDK
const clubRoutes = require('./routes/clubRoutes');


// ✅ Inicializa firebase-admin (solo imprime 1 línea)
require("./middlewares/firebaseAdmin");

const app = express();

// ===== Stripe =====
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ===== CARGAS NUEVAS (models/utils) =====
const QRCode = require("qrcode");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Order = require("./models/Order");
const Ticket = require("./models/Ticket");
const CheckInLog = require("./models/CheckInLog");
const sendTicketEmail = require("./utils/sendTicketEmail");

// (opcional) Modelo Club para pagos al organizador vía Stripe Connect
let Club = null;
try {
  Club = require("./models/Club"); // Debe exponer { stripeAccountId }
} catch {
  console.warn("ℹ️ models/Club no encontrado. Payouts a clubs deshabilitados.");
}

// ============================================================================
//   CORS — permitir clubs.nightvibe.life, previews de Vercel y FRONTEND_URL
// ============================================================================
const FRONTEND_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");

const staticAllowed = new Set([
  FRONTEND_URL,
  "https://nightvibe-six.vercel.app",
  "http://localhost:3000",
  "https://clubs.nightvibe.life",
  "https://nvclubs.vercel.app",
]);

function isAllowedOrigin(origin) {
  try {
    if (!origin) return true; // curl / apps nativas
    if (staticAllowed.has(origin)) return true;

    const { hostname } = new URL(origin);
    if (hostname.endsWith(".vercel.app")) return true;      // previews
    if (hostname.endsWith(".nightvibe.life")) return true;  // subdominios

    return false;
  } catch {
    return false;
  }
}

app.use(
  cors({
    origin: (origin, cb) =>
      isAllowedOrigin(origin)
        ? cb(null, true)
        : cb(new Error(`CORS no permitido para: ${origin}`)),
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    credentials: true,
  })
);
// Responder preflight explícitamente
app.options("*", cors());

// ===== Webhook Stripe (RAW body) — debe ir ANTES de express.json() =====
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

    // ===== EMISIÓN DE TICKETS + EMAIL =====
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      console.log(
        "✅ Pago OK:",
        session.id,
        "email:",
        session.customer_details?.email
      );

      try {
        // 1) Datos base del pago
        const email = session.customer_details?.email || null;
        const eventId = session.metadata?.eventId || "EVT";
        const userId = session.metadata?.userId || null;
        const phone = session.metadata?.phone || null;
        const paymentIntentId = session.payment_intent || null;

        // 2) Line items reales
        const lineItems = await stripe.checkout.sessions.listLineItems(
          session.id,
          { limit: 100 }
        );

        // 3) Crear/actualizar Order
        const order = await Order.findOneAndUpdate(
          { stripeSessionId: session.id },
          {
            stripeSessionId: session.id,
            paymentIntentId,
            userId,
            phone,
            email,
            eventId,
            items: lineItems.data.map((li) => ({
              ticketTypeId: li.price?.product || null,
              name:
                li.description ||
                li.price?.nickname ||
                li.price?.product ||
                "Entrada",
              unitAmount: li.amount_total
                ? Math.floor(li.amount_total / (li.quantity || 1))
                : li.price?.unit_amount || 0,
              qty: li.quantity || 1,
              currency: li.price?.currency || "eur",
            })),
            status: "paid",
          },
          { upsert: true, new: true }
        );

        // (Opcional) título/fecha del evento para el email
        const eventTitle = `Evento ${eventId}`;
        const eventDate = "";

        // 4) Emitir tickets: 1 por unidad
        for (const li of lineItems.data) {
          const qty = li.quantity || 1;
          for (let i = 0; i < qty; i++) {
            // token + firma HMAC
            const token = crypto.randomBytes(16).toString("base64url"); // 128 bits
            const hmac = crypto
              .createHmac("sha256", process.env.QR_HMAC_KEY)
              .update(`${token}|${eventId}`)
              .digest("base64url");
            const payload = `NV1:t=${token}&e=${eventId}&s=${hmac}`;

            // solo guardamos hash del token
            const tokenHash = await bcrypt.hash(token, 10);

            // serial corto legible (p.ej. NV-AB12-3F)
            const serial = `NV-${crypto
              .randomBytes(2)
              .toString("hex")
              .toUpperCase()}-${crypto
              .randomBytes(1)
              .toString("hex")
              .toUpperCase()}`;

            // persistir ticket
            const ticket = await Ticket.create({
              eventId,
              orderId: order._id,
              ownerUserId: userId,
              email,
              ticketTypeId: li.price?.product || null,
              serial,
              tokenHash,
              status: "issued",
            });

            // QR PNG (con el payload firmado)
            const qrPng = await QRCode.toBuffer(payload, {
              errorCorrectionLevel: "M",
              width: 480,
            });

            // email con la entrada (si hay email)
            if (email) {
              await sendTicketEmail({
                to: email,
                eventTitle,
                eventDate,
                serial: ticket.serial,
                qrPngBuffer: qrPng,
              });
            } else {
              console.log(
                "⚠️ Ticket emitido SIN email (no disponible): serial",
                ticket.serial
              );
            }
          }
        }

        console.log("🎟️  Tickets emitidos para order", order._id.toString());
      } catch (err) {
        console.error("❌ Error procesando checkout.session.completed:", err);
      }
    }

    res.json({ received: true });
  }
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
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ Conectado a MongoDB"))
  .catch((err) => console.error("❌ Error al conectar a MongoDB:", err));

// ===== Rutas base =====
app.get("/", (_req, res) => res.send("¡Servidor funcionando correctamente!"));
app.get("/test-image", (req, res) => {
  const base = (
    process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`
  ).replace(/\/+$/, "");
  res.send(`<img src="${base}/uploads/test.jpg" alt="Test Image" />`);
});

// ===== Stripe Checkout: crear orden (con validación + payouts Connect) =====
app.post("/api/orders", async (req, res) => {
  try {
    const { eventId, items, userId, phone, clubId } = req.body;

    // Validaciones básicas
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ error: "missing_items", message: "No hay items en la orden." });
    }

    // Construcción segura de line_items
    const line_items = items.map((it, idx) => {
      const name = (it?.name || "Entrada").toString();
      const currency = ((it?.currency || "eur") + "").toLowerCase();
      const qty = Number.isFinite(it?.qty) && it.qty > 0 ? Math.floor(it.qty) : 1;

      // unit_amount debe ser entero en céntimos y >= 50
      let unitAmount = Number(it?.unitAmount);
      if (!Number.isFinite(unitAmount)) {
        throw new Error(`items[${idx}].unitAmount inválido`);
      }
      unitAmount = Math.round(unitAmount);
      if (unitAmount < 50) {
        throw new Error(
          `El importe mínimo por entrada es 50 céntimos. Recibido: ${unitAmount}`
        );
      }

      return {
        quantity: qty,
        price_data: {
          currency,
          unit_amount: unitAmount,
          product_data: { name: `${name} · ${eventId || ""}` },
        },
      };
    });

    // Calcula application fee (opcional)
    const subtotal = line_items.reduce(
      (acc, li) => acc + li.price_data.unit_amount * li.quantity,
      0
    );
    const bps = parseInt(process.env.PLATFORM_FEE_BPS || "0", 10);     // basis points
    const fixed = parseInt(process.env.PLATFORM_FEE_FIXED || "0", 10); // céntimos
    const applicationFee = Math.max(0, Math.round((subtotal * bps) / 10000) + fixed);

    // Intenta cargar el club para enviar el dinero a su cuenta Connect
    let destinationAccount = null;
    if (Club && clubId) {
      try {
        const club = await Club.findById(clubId).select("stripeAccountId").lean();
        destinationAccount = club?.stripeAccountId || null; // acct_xxx
      } catch {
      }
    }

    const successBase = (process.env.FRONTEND_URL || "https://event-app-prod.vercel.app").replace(/\/+$/, "");

    // Parámetros base del Checkout
    const sessionParams = {
      mode: "payment",
      line_items,
      success_url: `${successBase}/purchase/success?sid={CHECKOUT_SESSION_ID}`,
      cancel_url: `${successBase}/purchase/cancel`,
      customer_creation: "always",
      metadata: {
        eventId: eventId || "",
        userId: userId || "",
        phone: phone || "",
        clubId: clubId || "",
      },
      phone_number_collection: { enabled: true },
    };

    // Si tenemos cuenta Connect del club, activamos payouts + fee
    if (destinationAccount) {
      sessionParams.payment_intent_data = {
        transfer_data: { destination: destinationAccount }, // 💸 neto al club
        application_fee_amount: applicationFee,             // 💰 tu fee
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.json({ url: session.url });
  } catch (e) {
    console.error(
      "❌ /api/orders error:",
      e?.type || "",
      e?.code || "",
      e?.message || e,
      e?.raw?.message || ""
    );
    return res.status(500).json({
      error: "stripe_session_error",
      message: e?.raw?.message || e?.message || "No se pudo crear la sesión de pago.",
    });
  }
});

// ===== Check-in de tickets (escáner) =====
app.post("/api/checkin", async (req, res) => {
  try {
    // Seguridad básica por API key (MVP)
    const key = req.headers["x-scanner-key"];
    if (!key || key !== process.env.SCANNER_API_KEY) {
      return res.status(401).json({ ok: false, reason: "unauthorized" });
    }

    const { token, eventId, hmac } = req.body || {};
    if (!token || !eventId || !hmac) {
      return res.status(400).json({ ok: false, reason: "bad_request" });
    }

    // Verificar firma HMAC
    const expected = crypto
      .createHmac("sha256", process.env.QR_HMAC_KEY)
      .update(`${token}|${eventId}`)
      .digest("base64url");
    if (expected !== hmac) {
      await CheckInLog.create({
        ticketId: null,
        eventId,
        result: "bad_signature",
      });
      return res.status(400).json({ ok: false, reason: "bad_signature" });
    }

    // Buscar ticket por comparación de hash (MVP)
    const candidates = await Ticket.find({
      eventId,
      status: { $in: ["issued", "checked_in"] },
    }).limit(10000);

    let found = null;
    for (const t of candidates) {
      const ok = await bcrypt.compare(token, t.tokenHash);
      if (ok) {
        found = t;
        break;
      }
    }

    if (!found) {
      await CheckInLog.create({ ticketId: null, eventId, result: "invalid" });
      return res.status(404).json({ ok: false, reason: "invalid" });
    }

    // Cargar orden para devolver buyerName/email
    let buyerName = "";
    let buyerEmail = "";
    try {
      if (found.orderId) {
        const ord = await Order.findById(found.orderId)
          .select("buyerName email")
          .lean();
        if (ord) {
          buyerName = ord.buyerName || "";
          buyerEmail = ord.email || "";
        }
      }
    } catch {  }

    if (found.status === "checked_in") {
      await CheckInLog.create({
        ticketId: found._id,
        eventId,
        result: "duplicate",
      });
      return res.json({
        ok: false,
        reason: "duplicate",
        serial: found.serial,
        checkedInAt: found.checkedInAt,
        buyerName,
        buyerEmail,
      });
    }

    // Update atómico
    const updated = await Ticket.findOneAndUpdate(
      { _id: found._id, status: "issued" },
      {
        $set: {
          status: "checked_in",
          checkedInAt: new Date(),
          checkedInBy: "scanner",
        },
      },
      { new: true }
    );

    const result = updated ? "ok" : "duplicate";
    await CheckInLog.create({
      ticketId: found._id,
      eventId,
      result,
    });

    return res.json({
      ok: result === "ok",
      serial: found.serial,
      status: updated?.status || found.status,
      checkedInAt: updated?.checkedInAt || found.checkedInAt,
      buyerName,
      buyerEmail,
    });
  } catch (e) {
    console.error("❌ Error en /api/checkin:", e);
    return res.status(500).json({ ok: false, reason: "server_error" });
  }
});

// ===== Rutas de tu app =====
const authRoutes = require("./routes/authRoutes");
const eventRoutes = require("./routes/eventRoutes");
const searchRoutes = require("./routes/searchRoutes");
const userRoutes = require("./routes/userRoutes");
const registrationRoutes = require("./routes/registrationRoutes"); // <-- MOVIDO AQUÍ

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/events", eventRoutes);
app.use("/search", searchRoutes);
app.use("/api/registration", registrationRoutes); // <-- Y montado AQUÍ
app.use("/api/clubs", clubRoutes);

// ===== 404 =====
app.use((_req, res) => res.status(404).send("Ruta no encontrada"));

// ===== Server =====
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✨ Servidor corriendo en el puerto ${PORT}`);
});

module.exports = app;*/
