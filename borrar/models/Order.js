// models/Order.js
const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema(
  {
    /* -------- Stripe refs -------- */
    stripeSessionId:   { type: String, index: true }, // cs_...
    paymentIntentId:   { type: String, index: true }, // pi_...
    chargeId:          { type: String, default: null }, // ch_... (opcional)
    balanceTxId:       { type: String, default: null }, // txn_... (opcional)

    /* -------- Comprador -------- */
    userId:    { type: String, default: null, index: true },
    phone:     { type: String, default: null },
    email:     { type: String, default: null, index: true },
    buyerName: { type: String, default: '' },

    /* -------- Negocio / evento -------- */
    clubId:   { type: String, default: null, index: true },
    eventId:  { type: String, required: true, index: true },

    /* -------- Ítems comprados -------- */
    qty:        { type: Number, default: 1 },        // 👈 nº de entradas
    amountEUR:  { type: Number, default: 0 },        // 👈 total en euros (para tu uso)
    items: [
      {
        ticketTypeId: { type: String, default: null },
        name:         { type: String, default: 'Entrada' },
        unitAmount:   { type: Number, default: 0 },   // céntimos
        qty:          { type: Number, default: 1 },
        currency:     { type: String, default: 'eur' },
      },
    ],

    /* -------- Totales / Fees -------- */
    currency:            { type: String, default: 'eur' },
    subtotalCents:       { type: Number, default: 0 },
    applicationFeeCents: { type: Number, default: 0 },
    destinationAccount:  { type: String, default: null },

    /* -------- Estados -------- */
    status: {
      type: String,
      enum: ['created', 'pending', 'paid', 'refunded', 'failed'], // 👈 añadimos pending
      default: 'pending',
      index: true,
    },

    /* -------- Metadatos auxiliares -------- */
    sessionMetadata:  { type: Object, default: {} },
    paymentMethod:    { type: String, default: null },
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

/* ------------------- Virtuales útiles ------------------- */
OrderSchema.virtual('totalTickets').get(function () {
  if (!Array.isArray(this.items)) return this.qty || 0;
  return this.items.reduce((acc, it) => acc + (it?.qty || 0), 0);
});

OrderSchema.virtual('grossCents').get(function () {
  return this.subtotalCents || 0;
});

/* ------------------- Índices compuestos ------------------ */
OrderSchema.index({ clubId: 1, createdAt: -1 });
OrderSchema.index({ eventId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Order', OrderSchema);
