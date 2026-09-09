'use client';
// ── Piezas compartidas del panel del profesor ─────────────────────────────────
// Helpers y badges que usan TANTO el Calendario (/teacher, pestaña Avisos) como
// el panel "Mis clases" (/clases). Vivían dentro de app/teacher/page.tsx cuando
// "Mis clases" era una pestaña de esa misma página; al pasar a ruta propia se
// sacaron acá para no duplicarlos.

import { useState, useEffect, type CSSProperties } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { getPresentationEmailStatus } from '@/lib/presentationEmailUtils';
import type { Assignment } from '@/types';

export function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// `fmtDateDMY` vive en lib/teacherClasses, con el resto de los formateadores de
// fecha del profesor. Estaba acá y duplicada en JoinClass, y solo una de las dos
// copias trataba bien las fechas de calendario.

// El estado de suscripción se verifica con la fuente única de verdad
// (lib/useSubscriptionStatus.ts): mismo endpoint, misma interpretación y mismo
// cache compartido que el panel "Alumnos". Ver checkSubscription / subBadge.
//
// El flujo completo de "Ingresar a clase" (enlace de Meet → disclaimer de hito →
// verificación de suscripción → registro del acceso) vive en components/JoinClass:
// es lo que decide si la clase cuenta para el pago, así que no puede estar
// implementado dos veces. La vista semanal /clases usa el mismo hook.

// ─── Email de presentación (nuevo alumno) ─────────────────────────────────────
// El modal y el armado del cuerpo del email viven en components/PresentationModal
// (fuente única, reutilizada por el popup recordatorio del NavBar).

// Marca en localStorage qué presentaciones ya se enviaron (por alumno) para el
// badge "Presentación enviada" y el estado del botón (Enviar / Reenviar).
export function usePresentationSent(teacherId: string) {
  const [sent, setSent] = useState<Set<string>>(new Set());
  // localStorage no está disponible en SSR: se lee tras montar (sync desde un
  // sistema externo, patrón usado en el resto del archivo).
  useEffect(() => {
    try {
      const prefix = `presentation_sent_${teacherId}_`;
      const found = new Set<string>();
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix) && localStorage.getItem(k) === '1') found.add(k.slice(prefix.length));
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSent(found);
    } catch {}
  }, [teacherId]);
  const markSent = (studentName: string) => {
    try { localStorage.setItem(`presentation_sent_${teacherId}_${studentName}`, '1'); } catch {}
    setSent(prev => new Set(prev).add(studentName));
  };
  return { isSent: (name: string) => sent.has(name), markSent };
}

// Estilo del botón "Enviar/Reenviar presentación" (verde si nuevo, gris si ya se envió).
export function presentationBtnStyle(sent: boolean): CSSProperties {
  const base: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8,
    padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontFamily: 'inherit',
  };
  return sent
    ? { ...base, border: '1px solid var(--border)', background: 'var(--bg-surface-3)', color: 'var(--text-muted)', fontWeight: 600 }
    : { ...base, border: 'none', background: '#1E9E3A', color: 'white', fontWeight: 700 };
}

// Convierte un color hex (#RRGGBB) en rgba con la opacidad dada.
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g2 = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g2}, ${b}, ${alpha})`;
}

// Badge dinámico del seguimiento del email de presentación. Se actualiza solo
// cada minuto (reloj propio) y toma TODO el estado visual de la fuente única
// lib/presentationEmailUtils.getPresentationEmailStatus.
export function PresentationEmailBadge({ assignment }: { assignment: Assignment }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  // Antes del montaje usamos createdAt como referencia estable (evita el desajuste
  // de hidratación de usar Date.now() en el render del servidor).
  const st = getPresentationEmailStatus(assignment, now ?? new Date(assignment.createdAt).getTime());
  const animClass = st.pulse ? 'pres-email-badge-pulse' : st.blink ? 'pres-email-badge-blink' : '';
  const textColor = st.badgeColor === '#FFC400' ? '#8a6d00' : st.badgeColor;

  return (
    <div style={{ marginTop: 8 }}>
      <span
        className={animClass}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '5px 11px', borderRadius: 999, fontSize: 12, fontWeight: 700,
          color: textColor,
          background: hexToRgba(st.badgeColor, 0.12),
          border: `1.5px solid ${hexToRgba(st.badgeColor, 0.42)}`,
        }}
      >
        {st.badgeText}
      </span>
      {st.subtextMessage && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.45, maxWidth: 340 }}>
          {st.subtextMessage}
        </div>
      )}
    </div>
  );
}

// ── Tarjeta de pendientes ─────────────────────────────────────────────────────
//
// Lo que el profesor tiene sin hacer, arriba del todo y solo cuando lo hay.
// Sigue el patrón visual de los banners de hito que ya vivían ahí (amarillo DRC
// #FFC400), pero en versión suave: el hito es una celebración y esto es una
// tarea, así que no compite con él en saturación.
//
// SIN BOTÓN DE CERRAR, a propósito. Un aviso que se puede descartar deja de ser
// un aviso: la tarjeta desaparece sola en cuanto los dos contadores llegan a
// cero, que es lo que se quiere conseguir.
//
// LOS MISMOS NÚMEROS QUE EL EMAIL. "Transcripts sin subir" sale de
// `transcriptsPendientes`, la misma función que alimenta el dashboard del admin,
// y esa a su vez sigue el criterio de finanzas. Si el panel y el correo del cron
// dijeran cosas distintas, el profesor no creería a ninguno de los dos.

/** Un alumno con nivel de test y sin validar. */
export interface NivelSinValidar {
  studentId: string | null;
  studentName: string;
  level: string;
}

/**
 * Alumnos del profesor con nivel de test esperando su visto bueno.
 *
 * EGRESS: filtra por `teacher_id` EN LA BASE y pide cuatro columnas cortas. Nada
 * de fichas completas ni de alumnos de otros profesores.
 */
export function useNivelesSinValidar(teacherId: string | undefined): NivelSinValidar[] {
  const [niveles, setNiveles] = useState<NivelSinValidar[]>([]);

  useEffect(() => {
    // Sin profesor no se pide nada y NO se toca el estado: un setState síncrono
    // dentro del efecto encadena renders (el linter lo señala). El valor inicial
    // ya es la lista vacía.
    if (!teacherId) return;
    let cancelado = false;
    (async () => {
      const { data, error } = await supabase
        .from('student_profiles')
        .select('student_id, student_name, level_test_cefr, teacher_confirmed_level')
        .eq('teacher_id', teacherId)
        .not('level_test_cefr', 'is', null)
        .is('teacher_confirmed_level', null);
      if (cancelado) return;
      if (error) {
        // 42703 = falta supabase-teacher-level.sql. Sin esa columna no hay nada
        // que validar todavía: la línea simplemente no aparece.
        if (error.code !== '42703' && error.code !== 'PGRST204') {
          console.warn('[panel] No se pudieron leer los niveles sin validar:', error.message);
        }
        setNiveles([]);
        return;
      }
      setNiveles((data ?? []).map(r => ({
        studentId: r.student_id as string | null,
        studentName: (r.student_name as string | null) ?? '—',
        level: (r.level_test_cefr as string | null) ?? '',
      })));
    })();
    return () => { cancelado = true; };
  }, [teacherId]);

  return niveles;
}

/** Cuántos nombres se listan antes de mandar a la sección Alumnos. */
const MAX_NOMBRES = 3;

export function PendingTasksCard({ transcripts, niveles }: {
  /** Clases con ingreso y sin transcript. Mismo criterio que finanzas. */
  transcripts: number;
  niveles: NivelSinValidar[];
}) {
  // Sin pendientes no hay tarjeta. Es la condición de salida de todo esto.
  if (transcripts === 0 && niveles.length === 0) return null;

  const linea: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    fontSize: 14, lineHeight: 1.5,
  };
  const enlace: React.CSSProperties = {
    color: '#7a5c00', fontWeight: 700, textDecoration: 'underline', textUnderlineOffset: 2,
  };

  return (
    <div style={{
      background: 'rgba(255,196,0,0.14)',
      border: '1px solid rgba(255,196,0,0.55)',
      borderRadius: 12, padding: '14px 18px', marginBottom: 14,
      display: 'flex', flexDirection: 'column', gap: 7,
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#7a5c00' }}>
        Tienes cosas pendientes
      </div>

      {transcripts > 0 && (
        <div style={linea}>
          <span style={{ color: '#1a1a1a' }}>
            <strong>Transcripts sin subir: {transcripts}</strong>
          </span>
          <Link href="/mis-clases" style={enlace}>Ir a Mis clases</Link>
        </div>
      )}

      {niveles.length > 0 && (
        <div style={linea}>
          <span style={{ color: '#1a1a1a' }}>
            <strong>Niveles sin validar: {niveles.length}</strong>
          </span>
          {/* Pocos alumnos → se nombran y se va directo a su ficha, que es donde
              está el desplegable. Muchos → un solo enlace, o la tarjeta se
              convierte en una lista. */}
          {niveles.length <= MAX_NOMBRES ? (
            niveles.map(n => (
              <Link key={n.studentId ?? n.studentName}
                href={n.studentId ? `/mis-alumnos/${encodeURIComponent(n.studentId)}` : '/mis-alumnos'}
                style={enlace}>
                {n.studentName} ({n.level})
              </Link>
            ))
          ) : (
            <Link href="/mis-alumnos" style={enlace}>Ir a Alumnos</Link>
          )}
        </div>
      )}
    </div>
  );
}
