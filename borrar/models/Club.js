const mongoose = require('mongoose');

const ClubSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, unique: true, index: true },
  ownerUserId: { type: String, required: true }, // uid Firebase o tu user _id
  managers: [{ type: String }],                  // otros emails/uids con permiso
  stripeAccountId: { type: String, index: true },// acct_...
  scannerApiKey: { type: String, index: true },   // si usas llave por club
  status: { type: String, enum: ['draft','active','suspended'], default: 'draft' },
}, { timestamps: true });

module.exports = mongoose.model('Club', ClubSchema);
