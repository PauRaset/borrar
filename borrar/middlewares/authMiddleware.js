// middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const admin = require('./firebaseAdmin');

/* ───────────────────────────── Helpers ───────────────────────────── */

function getHeader(req, name) {
  if (!req || !req.headers) return undefined;
  const key = Object.keys(req.headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? req.headers[key] : undefined;
}

// Normaliza para que SIEMPRE tengamos req.user.id (string) y req.userId
function attachUserId(req, idLike, extra = {}) {
  const id =
    idLike ??
    req?.user?.id ??
    req?.user?._id ??
    req?.user?.userId ??
    req?.firebaseUser?.uid;

  if (!id) return null;

  const strId = String(id);
  req.user = { ...(req.user || {}), id: strId, ...extra };
  req.userId = strId; // <- accesible directo
  return strId;
}

/**
 * Intenta extraer el JWT del request:
 * - x-auth-token / auth-token
 * - Authorization: "Bearer <token>"  ✅ (pero esto lo usamos para Firebase; aquí aceptamos si no empieza por "Bearer ")
 * - Authorization: "<token>"         ✅
 * - cookies: token / jwt / access_token ✅
 * - query: ?token=... (solo si llega así) ✅
 */
function extractJwtFromRequest(req) {
  // 0) Explicit legacy headers first
  const xAuth = getHeader(req, 'x-auth-token') || getHeader(req, 'auth-token');
  if (typeof xAuth === 'string' && xAuth.trim().length > 0) return xAuth.trim();

  // 1) Authorization
  const h = getHeader(req, 'authorization') || '';
  if (typeof h === 'string' && h.length) {
    // Si empieza por Bearer lo tratará verifyFirebaseIdToken / anyAuth
    if (!h.startsWith('Bearer ')) return h.trim();
  }

  // 2) Cookies
  const c = req.cookies || {};
  if (c.token) return c.token;
  if (c.jwt) return c.jwt;
  if (c.access_token) return c.access_token;

  // 3) Query param
  if (req.query?.token) return String(req.query.token);

  return null;
}

// Extrae Bearer para Firebase ID token
function extractBearerFromHeader(req) {
  const h = getHeader(req, 'authorization') || '';
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

// Intenta verificar el JWT "propio" (legacy) sin responder aún
function tryDecodeLegacyJwt(req) {
  const token = extractJwtFromRequest(req);
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const id =
      decoded.id ??
      decoded._id ??
      decoded.userId ??
      decoded.sub ??
      decoded.uid;
    if (!id) return null;
    return { ...decoded, id: String(id) };
  } catch (_) {
    return null;
  }
}

/* ───────────────────────── Middlewares ───────────────────────── */

/**
 * Verifica exclusivamente un Firebase ID token (Authorization: Bearer <idToken>)
 * y deja req.firebaseUser + req.user.id
 */
async function verifyFirebaseIdToken(req, res, next) {
  try {
    const idToken = extractBearerFromHeader(req);
    if (!idToken) return res.status(401).json({ message: 'No autorizado' });

    const decoded = await admin.auth().verifyIdToken(idToken);
    req.firebaseUser = decoded; // uid, phone_number, etc.
    attachUserId(req, decoded.uid);
    return next();
  } catch (error) {
    console.error('[authMiddleware] Firebase token inválido:', error?.message || error);
    return res.status(403).json({ message: 'Token no válido' });
  }
}

/**
 * Acepta JWT propio o Firebase ID token (híbrido). Requiere que haya token válido.
 * - Primero intenta JWT interno (x-auth-token o Authorization sin Bearer).
 * - Si no, intenta Firebase (Authorization: Bearer <idToken>).
 */
async function anyAuth(req, res, next) {
  // 1) JWT interno (propio)
  const legacy = tryDecodeLegacyJwt(req);
  if (legacy && legacy.id) {
    attachUserId(req, legacy.id, legacy);
    return next();
  }

  // 2) Firebase
  const idToken = extractBearerFromHeader(req);
  if (idToken) {
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      req.firebaseUser = decoded;
      attachUserId(req, decoded.uid);
      return next();
    } catch (error) {
      console.warn('[authMiddleware:anyAuth] Firebase token inválido:', error?.message || error);
    }
  }

  console.error('[authMiddleware:anyAuth] No autorizado: sin token válido (ni JWT interno ni Firebase)');
  return res.status(401).json({ message: 'No autorizado' });
}

/**
 * Igual que anyAuth pero si no hay token válido, NO corta la petición.
 * Útil para endpoints públicos que, si viene token, pueden personalizar (p.e. isFollowing).
 */
async function optionalAnyAuth(req, _res, next) {
  const legacy = tryDecodeLegacyJwt(req);
  if (legacy && legacy.id) {
    attachUserId(req, legacy.id, legacy);
    return next();
  }
  const idToken = extractBearerFromHeader(req);
  if (idToken) {
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      req.firebaseUser = decoded;
      attachUserId(req, decoded.uid);
    } catch (error) {
      // Silencioso: es opcional
      console.warn('[authMiddleware:optionalAnyAuth] Firebase token inválido:', error?.message || error);
    }
  }
  return next();
}

// Garantiza que exista req.user.id (string)
function ensureUserId(req, res, next) {
  const id = attachUserId(req);
  if (!id) return res.status(401).json({ message: 'No autorizado' });
  return next();
}

// Verifica exclusivamente tu JWT "propio"
function authenticateToken(req, res, next) {
  const token = extractJwtFromRequest(req);

  if (!token) {
    console.error('[authMiddleware.authenticateToken] Missing token (x-auth-token or Authorization)');
    return res.status(401).json({ message: 'No autorizado' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const id =
      decoded.id ??
      decoded._id ??
      decoded.userId ??
      decoded.sub ??
      decoded.uid;

    if (!id) {
      return res.status(403).json({ message: 'Token no válido' });
    }

    attachUserId(req, id, decoded);
    return next();
  } catch (error) {
    console.error('[authMiddleware] Token no válido:', error?.message || error);
    return res.status(403).json({ message: 'Token no válido' });
  }
}

/* ─────────────────────────── Exports ─────────────────────────── */

module.exports = authenticateToken; // default (back-compat)
module.exports.authenticateToken = authenticateToken;
module.exports.extractJwtFromRequest = extractJwtFromRequest;
module.exports.verifyFirebaseIdToken = verifyFirebaseIdToken;
module.exports.anyAuth = anyAuth;
module.exports.optionalAnyAuth = optionalAnyAuth;
module.exports.ensureUserId = ensureUserId;

// Conveniences
module.exports.anyAuthWithId = [anyAuth, ensureUserId];
module.exports.optionalAnyAuthWithId = [optionalAnyAuth, ensureUserId];
