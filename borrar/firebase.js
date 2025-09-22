// middlewares/firebaseAdmin.js
const admin = require("firebase-admin");

if (!admin.apps.length) {
  try {
    let serviceAccount;

    // Opción A: variable FIREBASE_SERVICE_ACCOUNT con el JSON completo
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    }

    // Opción B: ruta a JSON en disco (GOOGLE_APPLICATION_CREDENTIALS)
    if (!serviceAccount && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      serviceAccount = require(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    }

    if (!serviceAccount) {
      throw new Error(
        "No hay credenciales de Firebase. Define FIREBASE_SERVICE_ACCOUNT o GOOGLE_APPLICATION_CREDENTIALS."
      );
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    console.log("✅ firebase-admin inicializado");
  } catch (err) {
    console.error("❌ Error inicializando firebase-admin:", err);
    throw err;
  }
}

module.exports = admin;
