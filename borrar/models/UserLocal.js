const mongoose = require('mongoose');

const UserLocalSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, unique: true, index: true, required: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  // estado del ciclo de vida de la cuenta
  status: { type: String, enum: ['pending_email', 'pending_approval', 'approved', 'rejected'], default: 'pending_email' },
  // rol opcional (para futuro): admin del sistema / manager de club / staff
  role: { type: String, enum: ['admin', 'club', 'staff'], default: 'club' },

  // asociación opcional a un club (si aplicara)
  clubId: { type: mongoose.Schema.Types.ObjectId, ref: 'Club', default: null },

}, { timestamps: true });

module.exports = mongoose.model('UserLocal', UserLocalSchema);
