// utils/stock.js
// Reserva y liberación atómica de stock de entradas.
const Event = require('../models/Event');
const Order = require('../models/Order');

/**
 * Reserva qty entradas de forma atómica.
 * Devuelve true si se pudo reservar, false si no hay stock.
 * capacity <= 0 significa aforo ilimitado: no se reserva nada.
 */
async function reserveStock(eventId, qty) {
  const evt = await Event.findById(eventId).select('capacity').lean();
  if (!evt) return false;
  if (!evt.capacity || evt.capacity <= 0) return true; // sin límite

  const updated = await Event.findOneAndUpdate(
    {
      _id: eventId,
      $expr: {
        $lte: [
          { $add: ['$ticketsSold', { $ifNull: ['$ticketsReserved', 0] }, qty] },
          '$capacity',
        ],
      },
    },
    { $inc: { ticketsReserved: qty } },
    { new: true }
  );
  return !!updated;
}

/** Libera una reserva (por caducidad o error). Nunca deja el contador negativo. */
async function releaseStock(eventId, qty) {
  if (!qty || qty <= 0) return;
  await Event.updateOne(
    { _id: eventId, ticketsReserved: { $gte: qty } },
    { $inc: { ticketsReserved: -qty } }
  );
}

/** Convierte una reserva en venta confirmada. */
async function commitStock(eventId, qty) {
  if (!qty || qty <= 0) return;
  await Event.updateOne({ _id: eventId }, { $inc: { ticketsSold: qty } });
  await releaseStock(eventId, qty);
}

/**
 * Limpieza perezosa: libera reservas de órdenes caducadas que nadie
 * liberó (por ejemplo si se perdió el webhook de expiración).
 */
async function sweepExpiredReservations() {
  const now = new Date();
  const stale = await Order.find({
    reservationActive: true,
    status: { $in: ['created', 'pending'] },
    expiresAt: { $lt: now },
  }).limit(50);

  for (const o of stale) {
    try {
      await releaseStock(o.eventId, o.reservedQty || 0);
      o.reservationActive = false;
      o.status = 'expired';
      await o.save();
    } catch (e) {
      console.error('[stock] sweep fallo en orden', String(o._id), e.message);
    }
  }
  if (stale.length) console.log(`[stock] liberadas ${stale.length} reservas caducadas`);
}

module.exports = { reserveStock, releaseStock, commitStock, sweepExpiredReservations };
