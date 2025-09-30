const mongoose = require("mongoose");

/**
 * Importante:
 * - Para no romper datos antiguos (que eran strings),
 *   declaramos photos como "Mixed" para permitir string u objeto.
 */
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

module.exports = mongoose.model("Event", eventSchema);


/*const mongoose = require("mongoose");

const eventSchema = new mongoose.Schema({
  title: String,
  description: String,
  date: Date,
  city: String,
  street: String,
  postalCode: String,
  image: String,

  // Galería de fotos del evento (rutas relativas a /uploads o URLs absolutas)
  photos: {
    type: [String],
    default: [],
  },

  categories: [String], // múltiples categorías
  age: String,
  dressCode: String,     // dress code
  price: String,         // precio de la entrada
  attendees: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
});

module.exports = mongoose.model("Event", eventSchema);*/
