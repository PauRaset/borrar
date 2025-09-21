const { admin } = require('../firebase');

/**
 * Extrae el ID token de:
 *  - Authorization: Bearer <token>  (o "Firebase <token>")
 *  - x-firebase-id-token: <token>
 *  - body.firebaseIdToken
 */
function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth) {
    const [scheme, value] = auth.split(' ');
    if (/^Bearer$/i.test(scheme) || /^Firebase$/i.test(scheme)) return value;
  }
  if (req.headers['x-firebase-id-token']) return req.headers['x-firebase-id-token'];
  if (req.body && req.body.firebaseIdToken) return req.body.firebaseIdToken;
  return null;
}

module.exports = async function requireFirebase(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ message: 'Falta ID token' });

    const decoded = await admin.auth().verifyIdToken(token);

    // Disponibiliza datos útiles para el controlador
    req.auth = {
      uid: decoded.uid,
      phone: decoded.phone_number || null,
      email: decoded.email || null,
    };

    return next();
  } catch (err) {
    console.error('Firebase verifyIdToken error:', err && err.message);
    return res.status(401).json({ message: 'Token inválido' });
  }
};
