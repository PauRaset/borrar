// models/ClubApplication.js
const mongoose = require('mongoose');

const ClubApplicationSchema = new mongoose.Schema({
  email: { type: String, required: true, index: true },
  passwordToken: String,
  passwordTokenExpiresAt: Date,
  clubName: { type: String, required: true },
  contactName: { type: String, default: '' },
  phone: { type: String, default: '' },
  website: { type: String, default: '' },
  instagram: { type: String, default: '' },

  // verificación de email por token
  verifyToken: { type: String, index: true },
  verifyTokenExpiresAt: { type: Date },

  // estados del ciclo
  status: { type: String, enum: ['pending','email_verified','approved','rejected'], default: 'pending', index: true },

  // trazas
  approvedBy: { type: String, default: null },   // uid o email del admin
  approvedAt: { type: Date },
  notes: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('ClubApplication', ClubApplicationSchema);
