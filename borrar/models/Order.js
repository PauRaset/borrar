const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
  stripeSessionId: { type: String, index: true },
  paymentIntentId: { type: String, index: true },
  userId: { type: String, default: null },
  phone: { type: String, default: null },
  email: { type: String, default: null },
  eventId: { type: String, required: true },
  items: [{
    ticketTypeId: String,
    name: String,
    unitAmount: Number, // céntimos
    qty: Number,
    currency: { type: String, default: 'eur' }
  }],
  status: { type: String, enum: ['created','paid','refunded','failed'], default: 'created' }
}, { timestamps: true });

module.exports = mongoose.model('Order', OrderSchema);
