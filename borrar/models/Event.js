// models/Event.js
const mongoose = require("mongoose");

/**
 * Schema de eventos con compatibilidad hacia atrás:
 * - Se añaden startAt / endAt (fechas normalizadas).
 * - Se mantiene "date" para compatibilidad: si viene solo "date", se usa como startAt.
 * - photos sigue siendo Mixed para aceptar strings antiguos u objetos enriquecidos.
 * - age y price se guardan como Number (si llegan en string, se convierten).
 */
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

/**
 * Normalizaciones antes de guardar:
 * - Convertir startAt/endAt/date a Date si llegan como string/number.
 * - Si no hay startAt pero sí date, usar date como startAt (compat).
 * - Convertir age/price a Number si llegan en string.
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
    // admite "12", "12.5", etc.
    const n = Number(this.price);
    if (!Number.isNaN(n)) this.price = n;
  }

  next();
});

module.exports = mongoose.model("Event", eventSchema);

/*const mongoose = require("mongoose");

// * Importante:
// * - Para no romper datos antiguos (que eran strings),
// *   declaramos photos como "Mixed" para permitir string u objeto.
 
const eventSchema = new mongoose.Schema({
  title: String,
  description: String,
  date: Date,
  city: String,
  street: String,
  postalCode: String,

  image: String,

  // Galería: acepta strings antiguos o nuevos objetos { url, by, byUsername, uploadedAt }
  photos: {
    type: [mongoose.Schema.Types.Mixed],
    default: [],
  },

  categories: [String],
  age: String,
  dressCode: String,
  price: String,

  attendees: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
}, { timestamps: true });

module.exports = mongoose.model("Event", eventSchema);*/
