const mongoose = require('mongoose');

const ClubApplicationSchema = new mongoose.Schema(
  {
    // Solicitud base
    email:        { type: String, index: true, required: true },
    clubName:     { type: String, required: true },
    contactName:  { type: String, default: '' },
    phone:        { type: String, default: '' },
    website:      { type: String, default: '' },
    instagram:    { type: String, default: '' },

    // Verificación de email
    verifyToken:            { type: String, index: true },
    verifyTokenExpiresAt:   { type: Date },

    // Flujo de estado
    // pending -> email_verified -> approved | rejected
    status:      { type: String, enum: ['pending','email_verified','approved','rejected'], default: 'pending', index: true },
    approvedAt:  { type: Date },
    notes:       { type: String, default: '' },

    // ⬇⬇⬇ IMPORTANTE: token para crear la contraseña del panel
    passwordToken:          { type: String, index: true },
    passwordTokenExpiresAt: { type: Date },

  },
  { timestamps: true }
);

module.exports = mongoose.model('ClubApplication', ClubApplicationSchema);
