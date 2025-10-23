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
// middlewares/firebaseAdmin.js
// Inicializa Firebase Admin como singleton y soporta varias formas de credenciales (.env o rutas)

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

function normalizePrivateKey(key) {
  if (!key) return key;
  // Permite poner la clave con \n en .env sin romper
  return key.replace(/\\n/g, '\n');
}

function fileExists(p) {
  try { return !!p && fs.existsSync(p); } catch { return false; }
}

function loadCredential() {
  const {
    FIREBASE_SERVICE_ACCOUNT_JSON,     // JSON stringificado completo
    FIREBASE_SERVICE_ACCOUNT_PATH,     // ruta a JSON
    GOOGLE_APPLICATION_CREDENTIALS,    // ruta a JSON (estándar de Google)
    FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY,
  } = process.env;

  // 1) JSON stringificado en .env
  if (FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const json = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON);
      if (json.private_key) json.private_key = normalizePrivateKey(json.private_key);
      return admin.credential.cert(json);
    } catch (e) {
      console.error('[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT_JSON inválido:', e.message);
    }
  }

  // 2) Ruta en .env (cualquiera de las dos variables)
  const jsonPath = FIREBASE_SERVICE_ACCOUNT_PATH || GOOGLE_APPLICATION_CREDENTIALS;
  if (fileExists(jsonPath)) {
    try {
      const json = require(path.resolve(jsonPath));
      return admin.credential.cert(json);
    } catch (e) {
      console.error(`[firebaseAdmin] No se pudo leer el JSON en ${jsonPath}:`, e.message);
    }
  }

  // 3) Trio de variables sueltas en .env
  if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
    return admin.credential.cert({
      project_id: FIREBASE_PROJECT_ID,
      client_email: FIREBASE_CLIENT_EMAIL,
      private_key: normalizePrivateKey(FIREBASE_PRIVATE_KEY),
    });
  }

  // 4) Fallback: application default credentials (GCE/Cloud Run/etc.)
  try {
    return admin.credential.applicationDefault();
  } catch (e) {
    console.error('[firebaseAdmin] No hay credenciales configuradas:', e.message);
    return null;
  }
}

if (!admin.apps.length) {
  const credential = loadCredential();
  if (!credential) {
    throw new Error('[firebaseAdmin] Falta configurar credenciales. Define FIREBASE_SERVICE_ACCOUNT_JSON o FIREBASE_SERVICE_ACCOUNT_PATH/GOOGLE_APPLICATION_CREDENTIALS o el trío FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY');
  }
  admin.initializeApp({ credential });
  console.log('✅ firebase-admin inicializado');
}

module.exports = admin;
