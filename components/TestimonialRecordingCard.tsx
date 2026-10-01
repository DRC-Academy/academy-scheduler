'use client';

// Tarjeta del PROFESOR en su sección de Avisos: le pedimos la grabación de una o
// dos clases de un alumno que mejoró mucho su fluidez, para usarla como
// testimonio. La sube a la pestaña "Testimoniales" del sheet de grabaciones y
// pulsa "Grabación subida"; el admin lo ve en su pestaña Testimoniales.
//
// Mismo texto que la campanita y el email (lib/testimonialRequests).

import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { dbMarkRecordingUploaded, type TeacherRecordingRequest } from '@/lib/testimonialsDb';
import {
  recordingItems, describeItem, requestCopy, RECORDINGS_SHEET_URL, RECORDINGS_SHEET_TAB, shortDate,
} from '@/lib/testimonialRequests';

export default function TestimonialRecordingCard({ req, teacherId, teacherName, onUploaded }: {
  req: TeacherRecordingRequest;
  teacherId: string;
  /** Para abrir con su nombre: "Ignacio, sube la clase del…". */
  teacherName: string;
  onUploaded: (requestId: string, uploadedAt: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = recordingItems({ studentName: req.studentName, before: req.before, after: req.after }, req.sides);
  const subida = !!req.uploadedAt;
  const { body } = requestCopy(req.studentName, items, teacherName);

  async function marcar() {
    setSaving(true); setError(null);
    const r = await dbMarkRecordingUploaded(req.id, teacherId);
    setSaving(false);
    if (r.error) { setError('No se pudo guardar. Inténtalo de nuevo.'); return; }
    onUploaded(req.id, new Date().toISOString());
  }

  return (
    <div style={{
      borderRadius: 12, padding: '14px 16px', marginBottom: 8,
      background: subida ? 'var(--bg-surface)' : 'rgba(30,158,58,0.07)',
      border: subida ? '1px solid var(--border)' : '1.5px solid rgba(30,158,58,0.45)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ fontSize: 22, lineHeight: 1.2 }} aria-hidden>🎬</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#15803d' }}>
            Grabación para testimonio: {req.studentName}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.5 }}>
            {subida
              ? `Marcaste la grabación como subida el ${shortDate(req.uploadedAt)}. ¡Gracias!`
              : body}
          </div>

          {!subida && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, lineHeight: 1.7, color: '#1a1c1a' }}>
              {items.map(it => (
                <li key={it.side}>
                  {describeItem(it)}
                  {it.fathomUrl && (
                    <> · <a href={it.fathomUrl} target="_blank" rel="noopener noreferrer"
                      style={{ color: '#2563eb', fontWeight: 600, textDecoration: 'none' }}>
                      abrir grabación <ExternalLink size={12} style={{ verticalAlign: '-1px' }} aria-hidden />
                    </a></>
                  )}
                </li>
              ))}
            </ul>
          )}

          {!subida && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 12 }}>
              <a href={RECORDINGS_SHEET_URL} target="_blank" rel="noopener noreferrer"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 40, padding: '0 14px',
                  borderRadius: 10, border: '1.5px solid #2563eb', color: '#2563eb', background: '#fff',
                  fontSize: 13, fontWeight: 700, textDecoration: 'none',
                }}>
                Abrir sheet (pestaña {RECORDINGS_SHEET_TAB}) <ExternalLink size={13} aria-hidden />
              </a>
              <button type="button" onClick={marcar} disabled={saving}
                style={{
                  minHeight: 40, padding: '0 16px', borderRadius: 10, border: 0,
                  background: '#1E9E3A', color: '#fff', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 700,
                  cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1,
                }}>
                {saving ? 'Guardando…' : 'Grabación subida'}
              </button>
              {error && <span style={{ fontSize: 12.5, color: '#C81E1E', fontWeight: 600 }}>{error}</span>}
            </div>
          )}
          {subida && <div style={{ fontSize: 12.5, fontWeight: 700, color: '#1E9E3A', marginTop: 6 }}>Subida ✓</div>}
        </div>
      </div>
    </div>
  );
}
