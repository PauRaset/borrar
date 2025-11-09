// models/Event.js
const mongoose = require("mongoose");

/**
 * Schema de eventos con compatibilidad hacia atrás:
 * - startAt / endAt (fechas normalizadas) y "date" legacy.
 * - photos como Mixed para aceptar strings u objetos.
 * - age y price como Number.
 * - NUEVO: Relación con Club
 *    - clubId: String (rápido para queries/metadata)
 *    - club:   ObjectId ref 'Club' (relación formal)
 *   Ambos se sincronizan en pre-save.
 */
const eventSchema = new mongoose.Schema(
  {
    title:       { type: String, default: "" },
    description: { type: String, default: "" },

    // Fechas nuevas normalizadas
    startAt: { type: Date },
    endAt:   { type: Date },

    // Compatibilidad con campo antiguo
    date: { type: Date },

    // Ubicación
    city:       { type: String, default: "" },
    street:     { type: String, default: "" },
    postalCode: { type: String, default: "" },

    // Imagen principal (ruta relativa tipo "uploads/...")
    image: { type: String, default: "" },

    // Galería: acepta strings antiguos o nuevos objetos { url, by, byUsername, uploadedAt }
    photos: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },

    // Multi-categoría
    categories: { type: [String], default: [] },

    // Extra
    age:   { type: Number, default: 18 },
    dressCode: { type: String, default: "" },
    price: { type: Number, default: 0 },

    // Ventas/entradas (compatibles hacia atrás)
    currency: { type: String, default: "eur" },
    capacity: { type: Number, default: 0 },       // 0 = sin límite
    ticketsSold: { type: Number, default: 0 },     // contador rápido
    salesStart: { type: Date, default: null },
    salesEnd:   { type: Date, default: null },
    isPublished: { type: Boolean, default: true },

    attendees: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // 🔥 NUEVO — relación con Club
    clubId: { type: String, index: true, default: "" }, // guardamos como string para flexibilidad
    club:   { type: mongoose.Schema.Types.ObjectId, ref: "Club", index: true, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        delete ret.__v;
        return ret;
      },
    },
  }
);

/** Utils */
function isHex24(s) {
  return typeof s === "string" && /^[a-fA-F0-9]{24}$/.test(s);
}

/** Normaliza rutas de uploads: si viene URL absoluta, recorta desde /uploads/... */
function onlyUploadPath(input) {
  if (!input || typeof input !== 'string') return input;
  const i = input.indexOf('/uploads/');
  if (i !== -1) return input.slice(i);
  return input;
}

/**
 * Normalizaciones antes de guardar:
 * - Fechas: convertir a Date y usar date → startAt si hace falta.
 * - age/price a Number.
 * - Sincronizar clubId ⇄ club:
 *    - si llega `club` (ObjectId) y no `clubId` → set clubId
 *    - si llega `clubId` con pinta de ObjectId y no `club` → set club
 */
eventSchema.pre("save", function (next) {
  // Fechas
  if (this.startAt && !(this.startAt instanceof Date)) this.startAt = new Date(this.startAt);
  if (this.endAt && !(this.endAt instanceof Date))     this.endAt   = new Date(this.endAt);
  if (this.date && !(this.date instanceof Date))       this.date    = new Date(this.date);
  if (!this.startAt && this.date) this.startAt = this.date;

  // age / price a número
  if (typeof this.age === "string") {
    const n = parseInt(this.age, 10);
    if (!Number.isNaN(n)) this.age = n;
  }
  if (typeof this.price === "string") {
    const n = Number(this.price);
    if (!Number.isNaN(n)) this.price = n;
  }

  // capacity / ticketsSold a número y no negativos
  if (typeof this.capacity === "string") {
    const n = Number(this.capacity);
    if (!Number.isNaN(n)) this.capacity = n;
  }
  if (typeof this.ticketsSold === "string") {
    const n = Number(this.ticketsSold);
    if (!Number.isNaN(n)) this.ticketsSold = n;
  }
  if (this.capacity < 0) this.capacity = 0;
  if (this.ticketsSold < 0) this.ticketsSold = 0;

  // Normalizar salesStart / salesEnd
  if (this.salesStart && !(this.salesStart instanceof Date)) this.salesStart = new Date(this.salesStart);
  if (this.salesEnd && !(this.salesEnd instanceof Date))     this.salesEnd   = new Date(this.salesEnd);

  // Sincronizar clubId ⇄ club
  if (this.club && !this.clubId) {
    this.clubId = String(this.club);
  } else if (!this.club && isHex24(this.clubId)) {
    // Sólo autoconvertimos si parece ObjectId
    this.club = new mongoose.Types.ObjectId(this.clubId);
  }

  // Normalizar imagen principal a ruta relativa
  if (this.image) {
    this.image = onlyUploadPath(String(this.image).trim());
  }

  // Normalizar galería (acepta strings o objetos)
  if (Array.isArray(this.photos)) {
    this.photos = this.photos.map((p) => {
      if (typeof p === 'string') {
        return { url: onlyUploadPath(p) };
      }
      if (p && typeof p === 'object') {
        const copy = { ...p };
        if (copy.url) copy.url = onlyUploadPath(String(copy.url));
        return copy;
      }
      return p;
    });
  }

  // Normalizar categorías: si viene string JSON o "a,b,c"
  if (typeof this.categories === 'string') {
    const raw = this.categories.trim();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.categories = parsed.map(String);
    } catch (_) {
      this.categories = raw
        ? raw.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    }
  }

  next();
});

/** Índices compuestos útiles */
eventSchema.index({ clubId: 1, startAt: -1 });
eventSchema.index({ "createdBy": 1, startAt: -1 });
eventSchema.index({ attendees: 1, startAt: -1 });
// Publicación + ventana temporal de venta
eventSchema.index({ isPublished: 1, startAt: -1 });
// Búsquedas por rango de venta
eventSchema.index({ salesStart: 1, salesEnd: 1 });

// Virtual: evento a la venta ahora
eventSchema.virtual('isOnSale').get(function () {
  const now = new Date();
  if (this.isPublished === false) return false;
  if (this.salesStart && now < this.salesStart) return false;
  if (this.salesEnd && now > this.salesEnd) return false;
  return true;
});

module.exports = mongoose.model("Event", eventSchema);

/*// models/Event.js
const mongoose = require("mongoose");


const eventSchema = new mongoose.Schema(
  {
    title: { type: String, default: "" },
    description: { type: String, default: "" },

    // Fechas nuevas normalizadas
    startAt: { type: Date },
    endAt:   { type: Date },

    // Compatibilidad con campo antiguo
    date: { type: Date },

    // Ubicación
    city: { type: String, default: "" },
    street: { type: String, default: "" },
    postalCode: { type: String, default: "" },

    // Imagen principal (ruta relativa tipo "uploads/...")
    image: { type: String, default: "" },

    // Galería: acepta strings antiguos o nuevos objetos { url, by, byUsername, uploadedAt }
    photos: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },

    // Multi-categoría
    categories: { type: [String], default: [] },

    // Extra
    age: { type: Number, default: 18 },        // se convierte desde string si hace falta
    dressCode: { type: String, default: "" },
    price: { type: Number, default: 0 },       // se convierte desde string si hace falta

    attendees: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);


eventSchema.pre("save", function (next) {
  // Fechas
  if (this.startAt && !(this.startAt instanceof Date)) this.startAt = new Date(this.startAt);
  if (this.endAt && !(this.endAt instanceof Date))     this.endAt   = new Date(this.endAt);
  if (this.date && !(this.date instanceof Date))       this.date    = new Date(this.date);

  if (!this.startAt && this.date) this.startAt = this.date;

  // age / price a número
  if (typeof this.age === "string") {
    const n = parseInt(this.age, 10);
    if (!Number.isNaN(n)) this.age = n;
  }
  if (typeof this.price === "string") {
    // admite "12", "12.5", etc.
    const n = Number(this.price);
    if (!Number.isNaN(n)) this.price = n;
  }

  next();
});

module.exports = mongoose.model("Event", eventSchema);*/
