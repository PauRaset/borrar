// middlewares/firebaseAdmin.js
const admin = require("firebase-admin");
const path = require("path");

// Cambia el nombre si tu archivo se llama distinto
const SA_FILE =
  process.env.FIREBASE_SA_FILE ||
  "nightvibe-62942-firebase-adminsdk-fbsvc-2727b3d3c0.json";

if (!admin.apps.length) {
  const serviceAccountPath = path.isAbsolute(SA_FILE)
    ? SA_FILE
    : path.join(process.cwd(), SA_FILE);

  const serviceAccount = require(serviceAccountPath);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  console.log("[firebase-admin] Inicializado con archivo:", serviceAccountPath);
}

// (Exportar admin por si se quiere usar directo)
module.exports = admin;