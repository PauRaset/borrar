

'use client';

import { useEffect, useMemo, useState } from 'react';
import RequireClub from '@/components/RequireClub';

const API_BASE = 'https://api.nightvibe.life';

const CONTENT_MISSION_OPTIONS = [
  {
    type: 'approved_event_photo',
    label: 'Foto aprobada del evento',
    description: 'La foto es válida como contenido general aprobado del evento.',
  },
  {
    type: 'theme_photo',
    label: 'Foto temática',
    description: 'La foto cumple una temática concreta del evento o de la sala.',
  },
  {
    type: 'photocall_photo',
    label: 'Foto en photocall',
    description: 'La foto ha sido tomada en el photocall o punto visual definido.',
  },
  {
    type: 'group_photo_with_followed',
    label: 'Foto de grupo válida',
    description: 'La foto muestra el contenido grupal requerido por la misión.',
  },
  {
    type: 'show_prizes_photo',
    label: 'Foto mostrando premio',
    description: 'La foto demuestra correctamente la misión relacionada con premios.',
  },
];

function getMissionMeta(type) {
  return (
    CONTENT_MISSION_OPTIONS.find((item) => item.type === type) ||
    CONTENT_MISSION_OPTIONS[0]
  );
}

function missionDisplayLabel(photo) {
  if (photo?.missionTitle && String(photo.missionTitle).trim()) {
    return String(photo.missionTitle).trim();
  }
  return getMissionMeta(photo?.missionType || 'approved_event_photo')?.label || 'Foto aprobada del evento';
}

function validatedMissionDisplayLabel(photo) {
  if (photo?.validatedForMissionTitle && String(photo.validatedForMissionTitle).trim()) {
    return String(photo.validatedForMissionTitle).trim();
  }
  return getMissionMeta(photo?.validatedForMissionType || photo?.missionType || 'approved_event_photo')?.label || 'Foto aprobada del evento';
}

function getAuthHeaders() {
  if (typeof window === 'undefined') return {};
  const token =
    localStorage.getItem('token') ||
    localStorage.getItem('nv_token') ||
    localStorage.getItem('authToken') ||
    '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      ...getAuthHeaders(),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    credentials: 'include',
    cache: 'no-store',
  });

  const text = await res.text().catch(() => '');
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const message =
      (data && data.message) ||
      (typeof data === 'string' && data) ||
      `Error (HTTP ${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

function toAbsoluteMediaUrl(input) {
  if (!input) return '';
  const value = String(input).trim();
  if (!value) return '';

  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const path = `${url.pathname || ''}${url.search || ''}${url.hash || ''}`;
      if (path.startsWith('/uploads/')) {
        return `${API_BASE}${path}`;
      }
      return value;
    } catch {
      return value;
    }
  }

  return `${API_BASE}${value.startsWith('/') ? value : `/${value}`}`;
}

function buildPhotoCandidates(photo) {
  const rawValues = [
    photo?.url,
    photo?.image,
    photo?.path,
    photo?.photoUrl,
    photo?.src,
    photo?.filename,
    photo?.fileName,
    photo?.rawUrl,
  ].filter(Boolean);

  const expanded = [];

  for (const raw of rawValues) {
    const value = String(raw).trim();
    if (!value) continue;

    expanded.push(value);
    expanded.push(toAbsoluteMediaUrl(value));

    const filename = value.split('/').filter(Boolean).pop() || value;
    const clean = value.replace(/^\/+/, '');

    if (!/^https?:\/\//i.test(value)) {
      expanded.push(`${API_BASE}/${clean}`);
      expanded.push(`${API_BASE}/uploads/${clean}`);
      expanded.push(`${API_BASE}/uploads/event-photos/${clean}`);
      expanded.push(`${API_BASE}/uploads/eventPhotos/${clean}`);
      expanded.push(`${API_BASE}/uploads/events/${clean}`);
      expanded.push(`${API_BASE}/uploads/${value}`);
      expanded.push(`${API_BASE}/uploads/event-photos/${filename}`);
      expanded.push(`${API_BASE}/uploads/eventPhotos/${filename}`);
      expanded.push(`${API_BASE}/uploads/events/${filename}`);
    } else {
      try {
        const url = new URL(value);
        const path = url.pathname || '';
        const remoteFilename = path.split('/').filter(Boolean).pop() || filename;
        if (path.startsWith('/uploads/')) {
          expanded.push(`${API_BASE}${path}`);
        }
        expanded.push(`${API_BASE}/uploads/event-photos/${remoteFilename}`);
        expanded.push(`${API_BASE}/uploads/eventPhotos/${remoteFilename}`);
        expanded.push(`${API_BASE}/uploads/events/${remoteFilename}`);
      } catch {}
    }
  }

  return Array.from(new Set(expanded.filter(Boolean)));
}

function statusStyles(status) {
  if (status === 'approved') {
    return {
      background: 'rgba(34,197,94,0.12)',
      border: '1px solid rgba(34,197,94,0.24)',
      color: '#86efac',
    };
  }
  if (status === 'rejected') {
    return {
      background: 'rgba(244,63,94,0.10)',
      border: '1px solid rgba(244,63,94,0.22)',
      color: '#fda4af',
    };
  }
  return {
    background: 'rgba(250,204,21,0.10)',
    border: '1px solid rgba(250,204,21,0.20)',
    color: '#fde68a',
  };
}

function SmartPhoto({ photo, alt, style }) {
  const candidates = useMemo(() => buildPhotoCandidates(photo), [photo]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
  }, [candidates]);

  const currentSrc = candidates[index] || '';

  if (!candidates.length) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'grid',
          placeItems: 'center',
          color: '#94a3b8',
          fontSize: 13,
          textAlign: 'center',
          padding: 12,
        }}
      >
        Imagen no disponible
      </div>
    );
  }

  return (
    <img
      src={currentSrc}
      alt={alt}
      style={style}
      loading="lazy"
      onError={() => {
        if (index < candidates.length - 1) {
          setIndex((prev) => prev + 1);
        }
      }}
    />
  );
}

export default function ContentPage() {
  const [events, setEvents] = useState([]);
  const [selectedEventId, setSelectedEventId] = useState('all');
  const [statusFilter, setStatusFilter] = useState('pending');
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [selectedPhoto, setSelectedPhoto] = useState(null);
  const [reviewNote, setReviewNote] = useState('');
  const [selectedMissionType, setSelectedMissionType] = useState('approved_event_photo');
  const [selectedLevelNumber, setSelectedLevelNumber] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadEvents() {
      setLoading(true);
      setNotice('');
      try {
        const data = await apiJson(`${API_BASE}/api/events/mine`);
        if (!cancelled) {
          setEvents(Array.isArray(data) ? data : []);
        }
      } catch (e) {
        if (!cancelled) {
          setEvents([]);
          setNotice(e?.message || 'No se pudieron cargar los eventos del club.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadEvents();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadPhotos() {
      if (loading) return;
      if (!events.length) {
        setPhotos([]);
        return;
      }

      setPhotosLoading(true);
      setNotice('');

      try {
        const targetEvents =
          selectedEventId === 'all'
            ? events
            : events.filter((event) => (event._id || event.id) === selectedEventId);

        const results = await Promise.all(
          targetEvents.map(async (event) => {
            const eventId = event._id || event.id;
            if (!eventId) return [];
            try {
              const data = await apiJson(
                `${API_BASE}/api/events/${eventId}/photos/moderation?status=${statusFilter}`
              );
              const list = Array.isArray(data?.photos) ? data.photos : [];
              return list.map((photo) => ({
                ...photo,
                rawUrl: photo.url || photo.image || photo.path || photo.photoUrl || photo.src || photo.filename || photo.fileName || '',
                eventId,
                eventTitle: event.title || 'Evento sin título',
                eventImage: toAbsoluteMediaUrl(event.imageUrl || event.image || event.heroImage || ''),
              }));
            } catch {
              return [];
            }
          })
        );

        const merged = results.flat().sort((a, b) => {
          const aTime = a?.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
          const bTime = b?.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
          return bTime - aTime;
        });

        if (!cancelled) {
          setPhotos(merged);
          if (selectedPhoto) {
            const stillExists = merged.find((p) => p.photoId === selectedPhoto.photoId);
            if (!stillExists) {
              setSelectedPhoto(null);
              setReviewNote('');
              setSelectedMissionType('approved_event_photo');
              setSelectedLevelNumber('');
            }
          }
        }
      } catch (e) {
        if (!cancelled) {
          setPhotos([]);
          setNotice(e?.message || 'No se pudieron cargar las fotos.');
        }
      } finally {
        if (!cancelled) setPhotosLoading(false);
      }
    }

    loadPhotos();
    return () => {
      cancelled = true;
    };
  }, [loading, events, selectedEventId, statusFilter]);

  const counts = useMemo(() => {
    const pending = photos.filter((p) => p.status === 'pending').length;
    const approved = photos.filter((p) => p.status === 'approved').length;
    const rejected = photos.filter((p) => p.status === 'rejected').length;
    return {
      total: photos.length,
      pending,
      approved,
      rejected,
    };
  }, [photos]);

  const selectedEvent = useMemo(() => {
    if (selectedEventId === 'all') return null;
    return events.find((event) => (event._id || event.id) === selectedEventId) || null;
  }, [events, selectedEventId]);

  const selectedMissionMeta = useMemo(() => {
    return getMissionMeta(selectedMissionType);
  }, [selectedMissionType]);

  const selectedTargetMissionMeta = useMemo(() => {
    return getMissionMeta(selectedPhoto?.missionType || 'approved_event_photo');
  }, [selectedPhoto]);

  async function refreshCurrentPhotos() {
    if (!events.length) return;
    setPhotosLoading(true);
    try {
      const targetEvents =
        selectedEventId === 'all'
          ? events
          : events.filter((event) => (event._id || event.id) === selectedEventId);

      const results = await Promise.all(
        targetEvents.map(async (event) => {
          const eventId = event._id || event.id;
          if (!eventId) return [];
          try {
            const data = await apiJson(
              `${API_BASE}/api/events/${eventId}/photos/moderation?status=${statusFilter}`
            );
            const list = Array.isArray(data?.photos) ? data.photos : [];
            return list.map((photo) => ({
              ...photo,
              rawUrl: photo.url || photo.image || photo.path || photo.photoUrl || photo.src || photo.filename || photo.fileName || '',
              eventId,
              eventTitle: event.title || 'Evento sin título',
              eventImage: toAbsoluteMediaUrl(event.imageUrl || event.image || event.heroImage || ''),
            }));
          } catch {
            return [];
          }
        })
      );

      const merged = results.flat().sort((a, b) => {
        const aTime = a?.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
        const bTime = b?.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
        return bTime - aTime;
      });

      setPhotos(merged);
    } finally {
      setPhotosLoading(false);
    }
  }

  async function approvePhoto() {
    if (!selectedPhoto?.eventId || !selectedPhoto?.photoId || actionBusy) return;
    setActionBusy(true);
    setNotice('Aprobando foto...');
    try {
      await apiJson(`${API_BASE}/api/events/${selectedPhoto.eventId}/photos/${selectedPhoto.photoId}/approve`, {
        method: 'POST',
        body: JSON.stringify({
          reviewNote: reviewNote || '',
          missionType: selectedPhoto?.missionType || selectedMissionType || 'approved_event_photo',
          missionId: selectedPhoto?.missionId || null,
          missionTitle: selectedPhoto?.missionTitle || missionDisplayLabel(selectedPhoto),
          validatedForMissionType: selectedMissionType || selectedPhoto?.missionType || 'approved_event_photo',
          validatedForMissionId: selectedPhoto?.missionId || null,
          validatedForMissionTitle: selectedMissionMeta?.label || 'Foto aprobada del evento',
          validatedForLevelNumber:
            selectedLevelNumber.trim() !== '' && !Number.isNaN(Number(selectedLevelNumber))
              ? Number(selectedLevelNumber)
              : selectedPhoto?.levelNumber != null
                ? Number(selectedPhoto.levelNumber)
                : null,
          validationResult: 'matched',
        }),
      });
      setSelectedPhoto(null);
      setReviewNote('');
      setSelectedMissionType('approved_event_photo');
      setSelectedLevelNumber('');
      setNotice('Foto aprobada correctamente para la misión seleccionada.');
      await refreshCurrentPhotos();
    } catch (e) {
      setNotice(e?.message || 'No se pudo aprobar la foto.');
    } finally {
      setActionBusy(false);
    }
  }

  async function rejectPhoto() {
    if (!selectedPhoto?.eventId || !selectedPhoto?.photoId || actionBusy) return;
    setActionBusy(true);
    setNotice('Rechazando foto...');
    try {
      await apiJson(`${API_BASE}/api/events/${selectedPhoto.eventId}/photos/${selectedPhoto.photoId}/reject`, {
        method: 'POST',
        body: JSON.stringify({
          reviewNote: reviewNote || '',
          missionType: selectedPhoto?.missionType || selectedMissionType || 'approved_event_photo',
          missionId: selectedPhoto?.missionId || null,
          missionTitle: selectedPhoto?.missionTitle || missionDisplayLabel(selectedPhoto),
          validatedForMissionType: selectedMissionType || selectedPhoto?.missionType || 'approved_event_photo',
          validatedForMissionId: selectedPhoto?.missionId || null,
          validatedForMissionTitle: selectedMissionMeta?.label || 'Foto aprobada del evento',
          validatedForLevelNumber:
            selectedLevelNumber.trim() !== '' && !Number.isNaN(Number(selectedLevelNumber))
              ? Number(selectedLevelNumber)
              : selectedPhoto?.levelNumber != null
                ? Number(selectedPhoto.levelNumber)
                : null,
          validationResult: 'not_matched',
        }),
      });
      setSelectedPhoto(null);
      setReviewNote('');
      setSelectedMissionType('approved_event_photo');
      setSelectedLevelNumber('');
      setNotice('Foto rechazada correctamente para la misión revisada.');
      await refreshCurrentPhotos();
    } catch (e) {
      setNotice(e?.message || 'No se pudo rechazar la foto.');
    } finally {
      setActionBusy(false);
    }
  }

  async function deletePhoto() {
    if (!selectedPhoto?.eventId || !selectedPhoto?.photoId || actionBusy) return;
    if (!confirm('¿Eliminar esta foto definitivamente?')) return;
    setActionBusy(true);
    setNotice('Eliminando foto...');
    try {
      await apiJson(`${API_BASE}/api/events/${selectedPhoto.eventId}/photos/${selectedPhoto.photoId}`, {
        method: 'DELETE',
      });
      setSelectedPhoto(null);
      setReviewNote('');
      setSelectedMissionType('approved_event_photo');
      setSelectedLevelNumber('');
      setNotice('Foto eliminada correctamente.');
      await refreshCurrentPhotos();
    } catch (e) {
      setNotice(e?.message || 'No se pudo eliminar la foto.');
    } finally {
      setActionBusy(false);
    }
  }

  const pageStyle = {
    padding: '28px 24px 44px',
    color: '#e5e7eb',
    background: 'radial-gradient(circle at top, rgba(0,229,255,0.08), transparent 0 24%), #0b0f19',
    minHeight: '100vh',
  };

  const shellStyle = {
    width: '100%',
    maxWidth: 1280,
    margin: '0 auto',
    display: 'grid',
    gap: 22,
  };

  const heroStyle = {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.2fr) auto',
    gap: 18,
    alignItems: 'center',
    padding: 26,
    borderRadius: 24,
    background: 'linear-gradient(135deg, rgba(0,229,255,0.12), rgba(15,22,41,0.96))',
    border: '1px solid rgba(0,229,255,0.18)',
    boxShadow: '0 18px 50px rgba(0,0,0,0.24)',
  };

  const panelStyle = {
    background: '#0f1629',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: 22,
    padding: 20,
    boxShadow: '0 14px 40px rgba(0,0,0,0.20)',
  };

  const ghostBtn = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    padding: '0 14px',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(255,255,255,0.03)',
    color: '#e5e7eb',
    textDecoration: 'none',
    cursor: 'pointer',
    fontWeight: 700,
  };

  const primaryBtn = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
    padding: '0 16px',
    borderRadius: 14,
    background: '#00e5ff',
    color: '#001018',
    fontWeight: 800,
    textDecoration: 'none',
    border: '1px solid #00d4eb',
    cursor: 'pointer',
    boxShadow: '0 12px 32px rgba(0,229,255,0.22)',
    whiteSpace: 'nowrap',
  };

  return (
    <RequireClub>
      <main style={pageStyle}>
        <div style={shellStyle}>
          <section style={heroStyle}>
            <div>
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '8px 12px',
                  borderRadius: 999,
                  border: '1px solid rgba(0,229,255,0.2)',
                  background: 'rgba(0,229,255,0.08)',
                  color: '#7dd3fc',
                  fontWeight: 800,
                  fontSize: 13,
                  marginBottom: 14,
                }}
              >
                Contenido del club
              </div>
              <h1 style={{ margin: 0, fontSize: 'clamp(28px, 4vw, 42px)', lineHeight: 1.02, letterSpacing: '-0.03em', fontWeight: 900 }}>
                Validación de fotos
              </h1>
              <p style={{ color: '#cbd5e1', lineHeight: 1.65, fontSize: 15, margin: '12px 0 0', maxWidth: 760 }}>
                Revisa el contenido subido por asistentes, filtra por evento o estado y aprueba o rechaza cada foto según la misión o contexto del evento.
              </p>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" onClick={refreshCurrentPhotos} style={ghostBtn}>
                ↻ Recargar contenido
              </button>
            </div>
          </section>

          {notice && (
            <section
              style={{
                ...panelStyle,
                border: '1px solid rgba(0,229,255,0.14)',
                background: 'rgba(0,229,255,0.05)',
                color: '#dff9ff',
              }}
            >
              {notice}
            </section>
          )}

          <section
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 14,
            }}
          >
            <article style={panelStyle}>
              <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 10 }}>Fotos visibles</div>
              <div style={{ fontSize: 32, fontWeight: 900, letterSpacing: '-0.03em' }}>{counts.total}</div>
            </article>
            <article style={panelStyle}>
              <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 10 }}>Pendientes</div>
              <div style={{ fontSize: 32, fontWeight: 900, letterSpacing: '-0.03em' }}>{counts.pending}</div>
            </article>
            <article style={panelStyle}>
              <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 10 }}>Aprobadas</div>
              <div style={{ fontSize: 32, fontWeight: 900, letterSpacing: '-0.03em' }}>{counts.approved}</div>
            </article>
            <article style={panelStyle}>
              <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 10 }}>Rechazadas</div>
              <div style={{ fontSize: 32, fontWeight: 900, letterSpacing: '-0.03em' }}>{counts.rejected}</div>
            </article>
          </section>

          <section
            style={{
              ...panelStyle,
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto auto',
              gap: 14,
              alignItems: 'end',
            }}
          >
            <label style={{ display: 'grid', gap: 8 }}>
              <span style={{ fontSize: 13, color: '#94a3b8', fontWeight: 700 }}>Evento</span>
              <select
                value={selectedEventId}
                onChange={(e) => setSelectedEventId(e.target.value)}
                style={{
                  width: '100%',
                  minHeight: 48,
                  borderRadius: 12,
                  border: '1px solid rgba(255,255,255,0.08)',
                  background: 'rgba(255,255,255,0.03)',
                  color: '#e5e7eb',
                  padding: '0 14px',
                  outline: 'none',
                }}
              >
                <option value="all">Todos mis eventos</option>
                {events.map((event) => (
                  <option key={event._id || event.id} value={event._id || event.id}>
                    {event.title || 'Evento sin título'}
                  </option>
                ))}
              </select>
            </label>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[
                { key: 'pending', label: 'Pendientes' },
                { key: 'approved', label: 'Aprobadas' },
                { key: 'rejected', label: 'Rechazadas' },
              ].map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setStatusFilter(item.key)}
                  style={{
                    ...ghostBtn,
                    background: statusFilter === item.key ? '#111827' : 'rgba(255,255,255,0.03)',
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div style={{ color: '#94a3b8', fontSize: 13, whiteSpace: 'nowrap' }}>
              {selectedEvent ? `Evento: ${selectedEvent.title}` : 'Vista global del club'}
            </div>
          </section>

          <section style={panelStyle}>
            {loading || photosLoading ? (
              <div style={{ color: '#cbd5e1' }}>Cargando fotos...</div>
            ) : photos.length === 0 ? (
              <div>
                <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 10 }}>No hay fotos en esta vista</div>
                <div style={{ color: '#94a3b8', fontSize: 14, lineHeight: 1.6 }}>
                  Prueba con otro evento o cambia el filtro de estado para revisar más contenido.
                </div>
              </div>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                  gap: 14,
                }}
              >
                {photos.map((photo) => (
                  <button
                    key={`${photo.eventId}-${photo.photoId}`}
                    type="button"
                    /*onClick={() => {
                      setSelectedPhoto(photo);
                      setReviewNote(photo.reviewNote || '');
                    }}*/
                    onClick={() => {
                      setSelectedPhoto(photo);
                      setReviewNote(photo.reviewNote || '');
                      setSelectedMissionType(
                        photo.validatedForMissionType ||
                          photo.missionType ||
                          'approved_event_photo'
                      );
                      setSelectedLevelNumber(
                        photo.validatedForLevelNumber != null
                          ? String(photo.validatedForLevelNumber)
                          : photo.levelNumber != null
                            ? String(photo.levelNumber)
                            : ''
                      );
                    }}
                    style={{
                      textAlign: 'left',
                      border: '1px solid rgba(255,255,255,0.10)',
                      borderRadius: 18,
                      overflow: 'hidden',
                      background: 'rgba(255,255,255,0.02)',
                      color: '#e5e7eb',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ width: '100%', height: 210, background: 'rgba(255,255,255,0.03)' }}>
                      <SmartPhoto
                        photo={photo}
                        alt="Foto subida por asistente"
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    </div>
                    <div style={{ padding: 12, display: 'grid', gap: 8 }}>
                      <div style={{ fontWeight: 800, fontSize: 15, lineHeight: 1.45 }}>
                        {photo.eventTitle || 'Evento sin título'}
                      </div>
                      <div style={{ color: '#94a3b8', fontSize: 12.5, lineHeight: 1.5 }}>
                        @{photo.byUsername || 'usuario'}
                      </div>
                      <div
                        style={{
                          display: 'grid',
                          gap: 6,
                          padding: '10px 12px',
                          borderRadius: 14,
                          background: 'rgba(255,255,255,0.03)',
                          border: '1px solid rgba(255,255,255,0.06)',
                        }}
                      >
                        <div style={{ color: '#94a3b8', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                          Misión objetivo
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 800, color: '#e5e7eb', lineHeight: 1.4 }}>
                          {missionDisplayLabel(photo)}
                        </div>
                        {photo.levelNumber != null && photo.levelNumber !== '' && (
                          <div style={{ color: '#7dd3fc', fontSize: 12, fontWeight: 700 }}>
                            Nivel {photo.levelNumber}
                          </div>
                        )}
                      </div>
                      <div style={{ color: '#64748b', fontSize: 11, lineHeight: 1.45, wordBreak: 'break-all' }}>
                        {photo.rawUrl || photo.url || photo.path || photo.photoUrl || 'sin ruta'}
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <div
                          style={{
                            ...statusStyles(photo.status),
                            display: 'inline-flex',
                            alignItems: 'center',
                            width: 'fit-content',
                            minHeight: 28,
                            padding: '0 10px',
                            borderRadius: 999,
                            fontSize: 11.5,
                            fontWeight: 800,
                          }}
                        >
                          {photo.status === 'approved'
                            ? 'Aprobada'
                            : photo.status === 'rejected'
                              ? 'Rechazada'
                              : 'Pendiente'}
                        </div>

                        {photo.validatedForMissionType && (
                          <div
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              width: 'fit-content',
                              minHeight: 28,
                              padding: '0 10px',
                              borderRadius: 999,
                              fontSize: 11.5,
                              fontWeight: 800,
                              background: 'rgba(0,229,255,0.10)',
                              border: '1px solid rgba(0,229,255,0.20)',
                              color: '#7dd3fc',
                            }}
                          >
                            Validada como {validatedMissionDisplayLabel(photo)}
                          </div>
                        )}
                      </div>
                      <div style={{ color: '#94a3b8', fontSize: 12.5 }}>
                        {photo.uploadedAt ? new Date(photo.uploadedAt).toLocaleString('es-ES') : ''}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>

          {selectedPhoto && (
            <div
              onClick={() => {
                if (actionBusy) return;
                setSelectedPhoto(null);
                setReviewNote('');
                setSelectedMissionType('approved_event_photo');
                setSelectedLevelNumber('');
              }}
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.68)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 16,
                zIndex: 80,
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: 'min(860px, 100%)',
                  maxHeight: '84vh',
                  background: '#0b0f19',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 20,
                  overflow: 'hidden',
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 0.95fr) 340px',
                }}
              >
                <div style={{
                  background: '#020617',
                  minHeight: 320,
                  maxHeight: '84vh',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 12,
                }}>
                  <SmartPhoto
                    photo={selectedPhoto}
                    alt="Foto seleccionada"
                    style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 14 }}
                  />
                </div>

                <div style={{
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  maxHeight: '84vh',
                  overflowY: 'auto',
                }}>
                  <div>
                    <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: '-0.02em' }}>
                      {selectedPhoto.eventTitle || 'Evento sin título'}
                    </div>
                    <div style={{ color: '#94a3b8', fontSize: 14, marginTop: 6 }}>
                      Subida por @{selectedPhoto.byUsername || 'usuario'}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <div
                      style={{
                        ...statusStyles(selectedPhoto.status),
                        display: 'inline-flex',
                        alignItems: 'center',
                        width: 'fit-content',
                        minHeight: 30,
                        padding: '0 10px',
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 800,
                      }}
                    >
                      {selectedPhoto.status === 'approved'
                        ? 'Aprobada'
                        : selectedPhoto.status === 'rejected'
                          ? 'Rechazada'
                          : 'Pendiente'}
                    </div>
                  </div>

                  <div style={{ color: '#cbd5e1', fontSize: 14, lineHeight: 1.6 }}>
                    Aquí ves la misión objetivo de la foto y puedes decidir si realmente la cumple. Solo debería aprobarse si encaja con la misión requerida por ese usuario en ese momento.
                  </div>

                  <div
                    style={{
                      padding: 14,
                      borderRadius: 16,
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      display: 'grid',
                      gap: 10,
                    }}
                  >
                    <div style={{ color: '#94a3b8', fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                      Misión objetivo detectada en esta foto
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 900, color: '#f8fafc', lineHeight: 1.3 }}>
                      {selectedPhoto?.missionTitle || selectedTargetMissionMeta?.label || 'Foto aprobada del evento'}
                    </div>
                    <div style={{ color: '#cbd5e1', fontSize: 13.5, lineHeight: 1.6 }}>
                      {selectedTargetMissionMeta?.description || 'La foto se validará como contenido general aprobado del evento.'}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {selectedPhoto?.levelNumber != null && selectedPhoto?.levelNumber !== '' && (
                        <div
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            minHeight: 30,
                            padding: '0 10px',
                            borderRadius: 999,
                            background: 'rgba(0,229,255,0.10)',
                            border: '1px solid rgba(0,229,255,0.20)',
                            color: '#7dd3fc',
                            fontSize: 12,
                            fontWeight: 800,
                          }}
                        >
                          Nivel objetivo {selectedPhoto.levelNumber}
                        </div>
                      )}

                      {selectedPhoto?.validationResult && (
                        <div
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            minHeight: 30,
                            padding: '0 10px',
                            borderRadius: 999,
                            background: 'rgba(255,255,255,0.04)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            color: '#cbd5e1',
                            fontSize: 12,
                            fontWeight: 800,
                          }}
                        >
                          {selectedPhoto.validationResult === 'matched' ? 'Coincide con la misión' : 'No coincide con la misión'}
                        </div>
                      )}
                    </div>
                  </div>

                  <div
                    style={{
                      padding: 14,
                      borderRadius: 16,
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      display: 'grid',
                      gap: 12,
                    }}
                  >
                    <div>
                      <div style={{ color: '#94a3b8', fontSize: 12, fontWeight: 800, marginBottom: 6 }}>
                        Validar esta foto como
                      </div>
                      <select
                        value={selectedMissionType}
                        onChange={(e) => setSelectedMissionType(e.target.value)}
                        style={{
                          width: '100%',
                          minHeight: 46,
                          borderRadius: 12,
                          border: '1px solid rgba(255,255,255,0.12)',
                          background: 'rgba(255,255,255,0.03)',
                          color: '#e5e7eb',
                          padding: '0 12px',
                          outline: 'none',
                        }}
                      >
                        {CONTENT_MISSION_OPTIONS.map((item) => (
                          <option key={item.type} value={item.type}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <div style={{ color: '#94a3b8', fontSize: 12, fontWeight: 800, marginBottom: 6 }}>
                        Nivel relacionado (opcional)
                      </div>
                      <input
                        type="number"
                        min="1"
                        value={selectedLevelNumber}
                        onChange={(e) => setSelectedLevelNumber(e.target.value)}
                        placeholder="Ej. 2"
                        style={{
                          width: '100%',
                          minHeight: 46,
                          borderRadius: 12,
                          border: '1px solid rgba(255,255,255,0.12)',
                          background: 'rgba(255,255,255,0.03)',
                          color: '#e5e7eb',
                          padding: '0 12px',
                          outline: 'none',
                        }}
                      />
                    </div>

                    <div
                      style={{
                        padding: '12px 14px',
                        borderRadius: 14,
                        background: 'rgba(0,229,255,0.05)',
                        border: '1px solid rgba(0,229,255,0.14)',
                        color: '#dff9ff',
                        fontSize: 13,
                        lineHeight: 1.55,
                      }}
                    >
                      <strong style={{ display: 'block', marginBottom: 6 }}>
                        {selectedMissionMeta?.label || 'Foto aprobada del evento'}
                      </strong>
                      {selectedMissionMeta?.description || 'La foto se validará como contenido general aprobado.'}
                      {selectedPhoto?.missionType && selectedMissionType !== selectedPhoto.missionType && (
                        <div style={{ marginTop: 8, color: '#fcd34d', fontWeight: 700 }}>
                          Atención: estás validando la foto con una misión distinta a la misión objetivo.
                        </div>
                      )}
                    </div>
                  </div>

                  {selectedPhoto?.validatedForMissionType && (
                    <div
                      style={{
                        padding: 14,
                        borderRadius: 16,
                        background: 'rgba(255,255,255,0.03)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        display: 'grid',
                        gap: 8,
                      }}
                    >
                      <div style={{ color: '#94a3b8', fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                        Última validación guardada
                      </div>
                      <div style={{ fontSize: 15, fontWeight: 800, color: '#e5e7eb' }}>
                        {validatedMissionDisplayLabel(selectedPhoto)}
                      </div>
                      {selectedPhoto?.validatedForLevelNumber != null && selectedPhoto?.validatedForLevelNumber !== '' && (
                        <div style={{ color: '#7dd3fc', fontSize: 13, fontWeight: 700 }}>
                          Nivel validado {selectedPhoto.validatedForLevelNumber}
                        </div>
                      )}
                    </div>
                  )}

                  <label style={{ display: 'grid', gap: 8 }}>
                    <span style={{ fontSize: 13, color: '#94a3b8', fontWeight: 700 }}>Nota de revisión</span>
                    <textarea
                      value={reviewNote}
                      onChange={(e) => setReviewNote(e.target.value)}
                      rows={5}
                      style={{
                        width: '100%',
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: 12,
                        padding: 12,
                        background: 'rgba(255,255,255,0.03)',
                        color: '#e5e7eb',
                        resize: 'vertical',
                        outline: 'none',
                      }}
                    />
                  </label>

                  <div style={{ display: 'grid', gap: 10, marginTop: 'auto' }}>
                    {selectedPhoto.status !== 'approved' && (
                      <button
                        type="button"
                        onClick={approvePhoto}
                        disabled={actionBusy}
                        style={{
                          ...primaryBtn,
                          width: '100%',
                        }}
                      >
                        {actionBusy ? 'Procesando...' : '✅ Aprobar porque sí cumple la misión'}
                      </button>
                    )}

                    {selectedPhoto.status !== 'rejected' && (
                      <button
                        type="button"
                        onClick={rejectPhoto}
                        disabled={actionBusy}
                        style={{
                          ...ghostBtn,
                          width: '100%',
                        }}
                      >
                        {actionBusy ? 'Procesando...' : '❌ Rechazar porque no cumple la misión'}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={deletePhoto}
                      disabled={actionBusy}
                      style={{
                        width: '100%',
                        minHeight: 44,
                        borderRadius: 12,
                        border: '1px solid rgba(239,68,68,0.55)',
                        background: 'transparent',
                        color: '#fca5a5',
                        cursor: actionBusy ? 'not-allowed' : 'pointer',
                        fontWeight: 700,
                      }}
                    >
                      🗑 Eliminar foto
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </RequireClub>
  );
}
