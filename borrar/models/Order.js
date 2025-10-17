// models/Order.js
const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
  stripeSessionId: { type: String, index: true },
  paymentIntentId: { type: String, index: true },

  userId: { type: String, default: null },
  phone:  { type: String, default: null },

  // contacto principal del comprador
  email:      { type: String, default: null },   // ya lo tenías
  buyerName:  { type: String, default: '' },     // <— NUEVO
  // opcional si quieres separar
  // buyerEmail: { type: String, default: '' },

  eventId: { type: String, required: true, index: true },

  items: [{
    ticketTypeId: String,
    name: String,
    unitAmount: Number,   // céntimos
    qty: Number,
    currency: { type: String, default: 'eur' }
  }],

  status: { type: String, enum: ['created','paid','refunded','failed'], default: 'created' }
}, { timestamps: true });

module.exports = mongoose.model('Order', OrderSchema);
