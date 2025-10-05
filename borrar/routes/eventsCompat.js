// routes/eventsCompat.js
const express = require('express');
const router = express.Router();

// AJUSTA esta ruta si tu controlador está en otro sitio/nombre:
const events = require('../controllers/eventsController');
// Debe exportar algo como: listEvents, getEvent, createEvent, updateEvent, deleteEvent, uploadImage

// ---- Lectura estándar
router.get('/events', events.listEvents);
router.get('/events/:id', events.getEvent);

// ---- Crear
router.post('/events', events.createEvent);
router.post('/event', events.createEvent); // alias

// ---- Actualizar: acepta PUT, PATCH y POST en varias variantes
const upd = events.updateEvent;
router.put('/events/:id', upd);
router.patch('/events/:id', upd);
router.post('/events/:id', upd);

router.put('/event/:id', upd);    // alias singular
router.patch('/event/:id', upd);
router.post('/event/:id', upd);

// Variantes “update/edit” por si tu backend original usa esos paths
router.post('/events/update/:id', upd);
router.post('/events/edit/:id', upd);
router.put('/events/edit/:id', upd);
router.put('/events/:id/update', upd);
router.patch('/events/:id/update', upd);

// ---- Eliminar
router.delete('/events/:id', events.deleteEvent);

// ---- Imagen (si existe el handler en tu controller)
if (typeof events.uploadImage === 'function') {
  router.post('/events/:id/image', events.uploadImage);
  router.post('/event/:id/image', events.uploadImage);
}

module.exports = router;
