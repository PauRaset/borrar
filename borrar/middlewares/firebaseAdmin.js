// middlewares/firebaseAdmin.js
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

if (!admin.apps.length) {
  let serviceAccountObject = null;
  let serviceAccountPath = null;

  const fileExists = (p) => {
    try { return !!p && fs.existsSync(p); } catch { return false; }
  };

  // 1) Preferir rutas/JSON de entorno si existen
  const envJson = process.env.FIREBASE_SERVICE_ACCOUNT; // JSON en texto o ruta
  const envPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (envJson) {
    try {
      if (envJson.trim().startsWith("{")) {
        serviceAccountObject = JSON.parse(envJson);
      } else if (fileExists(envJson)) {
        serviceAccountPath = envJson;
      }
    } catch (e) {
      console.error("⚠️  FIREBASE_SERVICE_ACCOUNT inválido:", e.message);
    }
  } else if (fileExists(envPath)) {
    serviceAccountPath = envPath;
  }

  // 2) Si no hay env, buscar automáticamente un *firebase-adminsdk*.json
  if (!serviceAccountObject && !serviceAccountPath) {
    const candidates = [
      process.cwd(),                    // raíz del proyecto cuando arrancas node
      path.join(__dirname, ".."),       // raíz del backend
      __dirname                         // esta carpeta
    ];

    for (const dir of candidates) {
      try {
        const files = fs.readdirSync(dir);
        const match = files.find(
          (f) => f.endsWith(".json") && /firebase-adminsdk/i.test(f)
        );
        if (match) {
          serviceAccountPath = path.join(dir, match);
          break;
        }
      } catch (_) {}
    }
  }

  try {
    if (serviceAccountObject) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountObject),
      });
      console.log("✅ firebase-admin inicializado con JSON de entorno");
    } else if (serviceAccountPath) {
      const json = require(serviceAccountPath);
      admin.initializeApp({
        credential: admin.credential.cert(json),
      });
      console.log(`✅ firebase-admin inicializado con: ${serviceAccountPath}`);
    } else {
      throw new Error(
        "No se encontraron credenciales de Firebase. Define FIREBASE_SERVICE_ACCOUNT(_PATH) o GOOGLE_APPLICATION_CREDENTIALS o deja el JSON *firebase-adminsdk*.json en la raíz del proyecto."
      );
    }
  } catch (e) {
    console.error("✖ Error inicializando firebase-admin:", e);
    throw e; // deja que la app falle rápido para verlo en logs
  }
}

module.exports = admin;
