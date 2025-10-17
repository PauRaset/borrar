const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

// Esquema compatible con login clásico + Firebase (teléfono)
const userSchema = new mongoose.Schema(
  {
    // ---- Identidad básica (mantengo lo que ya tenías) ----
    username: { type: String, required: true, trim: true },

    // email no requerido para permitir alta por teléfono/Firebase
    email:    { type: String, unique: true, sparse: true },

    // Guardamos SIEMPRE el hash aquí (nunca texto plano).
    // Nota: añadimos un virtual "passwordHash" para compatibilidad.
    password: { type: String }, 

    // Campos existentes en tu app (según capturas)
    entName:     { type: String, default: "" }, // legado / compat
    entityName:  { type: String, default: "" }, // nombre visible actual
    wUser:       { type: String, default: "" }, // si lo usas
    profilePicture: { type: String, default: "" },

    role: { type: String, enum: ["club", "spectator"], default: "club" },

    facebookId:  { type: String, unique: true, sparse: true },
    instagramId: { type: String, unique: true, sparse: true },

    // ---- Integración Firebase ----
    firebaseUid: {
      type: String,
      index: true,
      unique: true,
      sparse: true,
    },
    phoneNumber: {
      type: String,
      index: true,
      unique: true,
      sparse: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        // No exponer el hash
        delete ret.password;

        // Exponer siempre entityName para el frontend
        if (!ret.entityName && ret.entName) ret.entityName = ret.entName;

        return ret;
      },
    },
  }
);

/* -------------------------------- Virtuales ------------------------------- */
/**
 * Compatibilidad: algunos módulos pueden leer/escribir "passwordHash".
 * Este virtual mapea a "password" (que siempre almacena el hash).
 */
userSchema.virtual("passwordHash")
  .get(function () { return this.password; })
  .set(function (v) { this.password = v; });

/* ----------------------------- Hooks & helpers ---------------------------- */

// Normaliza email y sincroniza entityName <-> entName
userSchema.pre("save", function (next) {
  if (this.email) this.email = this.email.toLowerCase().trim();

  // Sincronía nombres
  if (!this.entityName && this.entName) this.entityName = this.entName;
  if (this.entityName && !this.entName) this.entName = this.entityName;

  next();
});

// Encripta la contraseña SOLO si existe y cambió.
// Si ya parece un hash bcrypt ($2a/$2b/$2y...), no re-hashear.
userSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) return next();

  const looksHashed = typeof this.password === "string" && /^\$2[aby]\$/.test(this.password);
  if (looksHashed) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Comparar contraseñas cuando exista password local (bcrypt)
userSchema.methods.matchPassword = async function (enteredPassword) {
  if (!this.password) return false;
  return bcrypt.compare(enteredPassword, this.password);
};

// Fijar contraseña programáticamente (hashea y asigna)
userSchema.methods.setPassword = async function (plain) {
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(plain, salt);
  return this.password;
};

// Helper: crear/actualizar desde datos verificados de Firebase
userSchema.statics.findOrCreateFromFirebase = async function ({
  uid,
  phoneNumber,
  displayName,
  photoURL,
}) {
  const User = this;

  // 1) Buscar por UID o por teléfono
  let user =
    (uid && (await User.findOne({ firebaseUid: uid }))) ||
    (phoneNumber && (await User.findOne({ phoneNumber })));

  // 2) Crear si no existe
  if (!user) {
    const usernameBase =
      (displayName && displayName.trim()) ||
      (phoneNumber ? `user_${phoneNumber.replace(/\D/g, "").slice(-6)}` : null) ||
      (uid ? `user_${uid.slice(0, 8)}` : "user");

    user = new User({
      firebaseUid: uid || undefined,
      phoneNumber: phoneNumber || undefined,
      username: usernameBase,
      profilePicture: photoURL || "",
      role: "spectator",
      // email opcional; si quieres forzar único sintético:
      email: uid ? `${uid}@firebase.local` : undefined,
    });
  } else {
    // 3) Actualizar campos útiles si faltan
    if (!user.firebaseUid && uid) user.firebaseUid = uid;
    if (!user.phoneNumber && phoneNumber) user.phoneNumber = phoneNumber;
    if (!user.profilePicture && photoURL) user.profilePicture = photoURL;
    if (
      user.username &&
      user.username.startsWith("user_") &&
      displayName &&
      displayName.trim()
    ) {
      user.username = displayName.trim();
    }
  }

  await user.save();
  return user;
};

const User = mongoose.model("User", userSchema);
module.exports = User;

/*const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

// Esquema compatible con login clásico + Firebase (teléfono)
const userSchema = new mongoose.Schema(
  {
    // ---- Identidad básica (mantengo lo que ya tenías) ----
    username: { type: String, required: true, trim: true },
    email:    { type: String, unique: true, sparse: true }, // no required para permitir alta por teléfono
    password: { type: String }, // opcional si el usuario entra por Firebase

    // Campos existentes en tu app (según capturas)
    // Back-compat: antes usabas "entName"; el frontend muestra "entityName".
    entName:     { type: String, default: "" }, // legado / compat
    entityName:  { type: String, default: "" }, // nombre visible actual
    wUser:       { type: String, default: "" }, // si lo usas
    profilePicture: { type: String, default: "" },

    role: { type: String, enum: ["club", "spectator"], default: "club" },

    facebookId:  { type: String, unique: true, sparse: true },
    instagramId: { type: String, unique: true, sparse: true },

    // ---- Integración Firebase ----
    firebaseUid: {
      type: String,
      index: true,
      unique: true,
      sparse: true, // permite muchos docs sin este campo
    },
    phoneNumber: {
      type: String,
      index: true,
      unique: true,
      sparse: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        // Exponer siempre entityName para el frontend
        if (!ret.entityName && ret.entName) ret.entityName = ret.entName;
        return ret;
      },
    },
  }
);

// ----------------------------- Hooks & helpers ---------------------------- 

// Sincroniza entityName <-> entName para mantener compatibilidad
userSchema.pre("save", function (next) {
  // Si sólo está rellenado entName, propagar a entityName
  if (!this.entityName && this.entName) this.entityName = this.entName;
  // Si sólo está entityName y entName está vacío, lo mantenemos sincronizado
  if (this.entityName && !this.entName) this.entName = this.entityName;
  next();
});

// Encripta la contraseña SOLO si existe y cambió
userSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Comparar contraseñas cuando exista password local
userSchema.methods.matchPassword = async function (enteredPassword) {
  if (!this.password) return false;
  return bcrypt.compare(enteredPassword, this.password);
};

// Helper: crear/actualizar desde datos verificados de Firebase
userSchema.statics.findOrCreateFromFirebase = async function ({
  uid,
  phoneNumber,
  displayName,
  photoURL,
}) {
  const User = this;

  // 1) Buscar por UID o por teléfono
  let user =
    (uid && (await User.findOne({ firebaseUid: uid }))) ||
    (phoneNumber && (await User.findOne({ phoneNumber })));

  // 2) Crear si no existe
  if (!user) {
    const usernameBase =
      (displayName && displayName.trim()) ||
      (phoneNumber ? `user_${phoneNumber.replace(/\D/g, "").slice(-6)}` : null) ||
      (uid ? `user_${uid.slice(0, 8)}` : "user");

    user = new User({
      firebaseUid: uid || undefined,
      phoneNumber: phoneNumber || undefined,
      username: usernameBase,
      profilePicture: photoURL || "",
      // role usa el default "club" (ajústalo si prefieres "spectator")
      role: "spectator",
      // email opcional; si quieres forzar único sintético:
      email: uid ? `${uid}@firebase.local` : undefined,
    });
  } else {
    // 3) Actualizar campos útiles si faltan
    if (!user.firebaseUid && uid) user.firebaseUid = uid;
    if (!user.phoneNumber && phoneNumber) user.phoneNumber = phoneNumber;
    if (!user.profilePicture && photoURL) user.profilePicture = photoURL;
    if (
      user.username &&
      user.username.startsWith("user_") &&
      displayName &&
      displayName.trim()
    ) {
      user.username = displayName.trim();
    }
  }

  await user.save();
  return user;
};

const User = mongoose.model("User", userSchema);
module.exports = User;*/
