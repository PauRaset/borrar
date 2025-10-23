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
