'use client';

// Formulario inicial y prueba de nivel del alumno, en la ficha: el estado
// vigente a la vista y, si hubo "Regenerar todo" antes, un historial
// desplegable con los resultados anteriores (lib/onboardingStatus).

import { useEffect, useState } from 'react';
import type { OnboardingStatus, FormSnapshot, TestSnapshot } from '@/lib/onboardingStatus';

const fecha = (iso: string | null | undefined) => iso
  ? new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Madrid' })
  : '';

function formText(f: FormSnapshot): string {
  if (f.state === 'completed') return `Completado · ${fecha(f.completedAt)}`;
  if (f.state === 'expired') return 'Enlace caducado';
  if (f.state === 'pending') return 'Sin empezar';
  return 'Sin enviar';
}

function testText(t: TestSnapshot): string {
  if (t.state === 'completed') return `Terminada · ${fecha(t.completedAt)}${t.cefr ? ` · ${t.cefr}` : ''}`;
  if (t.state === 'in_progress') return `A medias · ${t.answered} respuesta${t.answered === 1 ? '' : 's'}`;
  if (t.state === 'pending') return 'Sin empezar';
  return 'Sin prueba';
}

const tone = (done: boolean, started: boolean) =>
  done ? { bg: 'rgba(30,158,58,0.12)', color: '#166534' }
    : started ? { bg: 'rgba(255,196,0,0.18)', color: '#92400e' }
      : { bg: 'rgba(120,120,120,0.12)', color: '#4b5563' };

function Row({ label, text, t }: { label: string; text: string; t: { bg: string; color: string } }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 13, color: 'var(--sp-t2)' }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 10, background: t.bg, color: t.color }}>{text}</span>
    </div>
  );
}

export default function OnboardingStatusCard({ studentId, studentName, refreshKey }: {
  studentId?: string | null;
  studentName: string;
  /** Cambia tras un "Regenerar todo" para volver a leer. */
  refreshKey?: number;
}) {
  const [st, setSt] = useState<OnboardingStatus | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({ studentName });
    if (studentId) qs.set('studentId', studentId);
    fetch(`/api/students/onboarding-status?${qs}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then(d => { if (!cancelled) { setSt(d as OnboardingStatus); setError(false); } })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [studentId, studentName, refreshKey]);

  if (error || !st) return null;   // tarjeta informativa: sin datos, no estorba

  return (
    <div style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', background: 'var(--bg-surface)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>
        Formulario y prueba de nivel
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Row label="Formulario inicial" text={formText(st.form)} t={tone(st.form.state === 'completed', false)} />
        <Row label="Prueba de nivel" text={testText(st.test)} t={tone(st.test.state === 'completed', st.test.state === 'in_progress')} />
      </div>

      {st.history.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--sp-t2)' }}>
            Historial ({st.history.length} regenerado{st.history.length === 1 ? '' : 's'})
          </summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            {st.history.map(h => (
              <div key={h.supersededAt} style={{ padding: '10px 12px', borderRadius: 9, background: '#fbfbf9', border: '1px solid var(--border)', fontSize: 12.5, lineHeight: 1.6, color: 'var(--sp-t2)' }}>
                <div style={{ fontWeight: 700, color: 'var(--sp-t1)', marginBottom: 4 }}>Hasta el {fecha(h.supersededAt)}</div>
                {h.forms.length === 0 && h.tests.length === 0 && <div>Sin formulario ni prueba hechos.</div>}
                {h.forms.map((f, i) => <div key={`f${i}`}>Formulario completado el {fecha(f.completedAt)}</div>)}
                {h.tests.map((t, i) => (
                  <div key={`t${i}`}>
                    {t.state === 'completed'
                      ? <>Prueba terminada el {fecha(t.completedAt)}{t.cefr ? <> · <strong>{t.cefr}</strong></> : null}{t.score != null ? ` (${Math.round(t.score)}/100)` : ''}</>
                      : <>Prueba a medias ({t.answered} respuesta{t.answered === 1 ? '' : 's'})</>}
                    {t.teacherLevel && <> · el profe confirmó <strong>{t.teacherLevel}</strong></>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
