// models/Order.js
const mongoose = require('mongoose');

/**
 * Una “Order” representa una compra (checkout) completada o en curso.
 * Importante para Connect:
 *  - clubId:     qué club recibe el dinero
 *  - destinationAccount: acct_*** de Stripe del club (si se usó Connect)
 *  - applicationFeeCents: tu fee de plataforma (si se aplicó)
 *  - amounts:    totales en céntimos para dashboards rápidos
 */
const OrderSchema = new mongoose.Schema(
  {
    /* -------- Stripe refs -------- */
    stripeSessionId:   { type: String, index: true }, // cs_...
    paymentIntentId:   { type: String, index: true }, // pi_...
    chargeId:          { type: String, default: null }, // ch_... (opcional)
    balanceTxId:       { type: String, default: null }, // txn_... (opcional)

    /* -------- Comprador -------- */
    userId:    { type: String, default: null, index: true }, // id usuario en tu sistema (si lo hay)
    phone:     { type: String, default: null },
    email:     { type: String, default: null, index: true }, // contacto principal
    buyerName: { type: String, default: '' },

    /* -------- Negocio / evento -------- */
    clubId:   { type: String, default: null, index: true },   // 💡 clave para reporting por club
    eventId:  { type: String, required: true, index: true },  // id del evento

    /* -------- Ítems comprados -------- */
    items: [
      {
        ticketTypeId: { type: String, default: null },
        name:         { type: String, default: 'Entrada' },
        unitAmount:   { type: Number, default: 0 },    // céntimos
        qty:          { type: Number, default: 1 },
        currency:     { type: String, default: 'eur' },
      },
    ],

    /* -------- Totales / Fees -------- */
    currency:            { type: String, default: 'eur' }, // moneda principal del pedido
    subtotalCents:       { type: Number, default: 0 },     // suma de line_items (sin fees Stripe)
    applicationFeeCents: { type: Number, default: 0 },     // tu fee (si Connect)
    destinationAccount:  { type: String, default: null },  // acct_xxx del club (si Connect)

    /* -------- Estados -------- */
    status: {
      type: String,
      enum: ['created', 'paid', 'refunded', 'failed'],
      default: 'created',
      index: true,
    },

    /* -------- Metadatos auxiliares -------- */
    sessionMetadata:  { type: Object, default: {} }, // copia de session.metadata
    paymentMethod:    { type: String, default: null }, // card, etc. (opcional)
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        // No exponemos internos innecesarios
        delete ret.__v;
        return ret;
      },
    },
  }
);

/* ------------------- Virtuales útiles ------------------- */
// Nº total de entradas (suma de qty)
OrderSchema.virtual('totalTickets').get(function () {
  if (!Array.isArray(this.items)) return 0;
  return this.items.reduce((acc, it) => acc + (it?.qty || 0), 0);
});

// Total “bruto” aproximado = subtotalCents (no incluye comisiones Stripe)
// (tu revenue de plataforma está en applicationFeeCents)
OrderSchema.virtual('grossCents').get(function () {
  return this.subtotalCents || 0;
});

/* ------------------- Índices compuestos ------------------ */
// Para listados por club y fecha
OrderSchema.index({ clubId: 1, createdAt: -1 });
// Para búsquedas por evento y estado
OrderSchema.index({ eventId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Order', OrderSchema);

/*// models/Order.js
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

module.exports = mongoose.model('Order', OrderSchema);*/
