const mongoose = require("mongoose");

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

  categories: [String], // Ahora admite múltiples categorías
  age: String,
  dressCode: String,     // Nuevo campo para Dress Code
  price: String,         // Nuevo campo para el precio de la entrada
  attendees: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
});

module.exports = mongoose.model("Event", eventSchema);
