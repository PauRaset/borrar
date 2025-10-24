// middlewares/firebaseAdmin.js
// Inicializa Firebase Admin como singleton con projectId explícito.

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

function normalizePrivateKey(key) {
  if (!key) return key;
  return key.replace(/\\n/g, '\n');
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('[firebaseAdmin] No se pudo leer JSON en', p, e.message);
    return null;
  }
}

function loadCredentialAndProject() {
  const env = process.env;

  // 1) JSON stringificado en env
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const json = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
      if (json.private_key) json.private_key = normalizePrivateKey(json.private_key);
      return { credential: admin.credential.cert(json), projectId: json.project_id };
    } catch (e) {
      console.error('[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT_JSON inválido:', e.message);
    }
  }

  // 2) Ruta a JSON en env
  const jsonPath = env.FIREBASE_SERVICE_ACCOUNT_PATH || env.GOOGLE_APPLICATION_CREDENTIALS;
  if (jsonPath && fs.existsSync(jsonPath)) {
    const json = readJson(path.resolve(jsonPath));
    if (json) {
      return { credential: admin.credential.cert(json), projectId: json.project_id };
    }
  }

  // 3) Trío de variables sueltas
  if (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
    return {
      credential: admin.credential.cert({
        project_id: env.FIREBASE_PROJECT_ID,
        client_email: env.FIREBASE_CLIENT_EMAIL,
        private_key: normalizePrivateKey(env.FIREBASE_PRIVATE_KEY),
      }),
      projectId: env.FIREBASE_PROJECT_ID,
    };
  }

  // 4) Fallback ADC (GCE/Cloud Run)
  try {
    const cred = admin.credential.applicationDefault();
    const projectId = env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || env.FIREBASE_PROJECT_ID || null;
    return { credential: cred, projectId };
  } catch (e) {
    console.error('[firebaseAdmin] Sin credenciales:', e.message);
    return { credential: null, projectId: null };
  }
}

if (!admin.apps.length) {
  const { credential, projectId } = loadCredentialAndProject();
  if (!credential) throw new Error('[firebaseAdmin] Falta configurar credenciales');

  // Forzamos projectId explícito para evitar "Unable to detect a Project Id..."
  admin.initializeApp({ credential, projectId });
  console.log('✅ firebase-admin inicializado – projectId =', projectId || '(desconocido)');
}

module.exports = admin;
