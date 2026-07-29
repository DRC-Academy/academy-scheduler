'use client';
// ── Recordatorio de emails de presentación (montado en el NavBar) ──────────────
// Aparece en TODA la app del profesor sin duplicar código: el NavBar se renderiza
// en cada página, así que basta montarlo aquí una vez. Solo actúa para el rol
// teacher; para el resto de roles no renderiza nada.
//
// Regla de frecuencia (corregida el 29/07/2026):
//   · Al mostrarse, el popup se silencia durante unas horas (localStorage
//     'presentation_popup_snooze_until'). Si hay algún alumno fuera de plazo el
//     silencio es más corto, porque necesita atención antes.
//
// ANTES: un alumno fuera de plazo hacía que el popup IGNORARA el sessionStorage y
// se mostrara en cada montaje. Como <NavBar/> se renderiza en cada página (no en
// el layout), cada navegación era un montaje nuevo y el popup salía en CADA clic.
// Marcar un email como enviado no lo callaba: bastaba con que quedara otro alumno
// vencido para que volviera. Sol tenía 10 vencidos, Sebastian y Ana 3 cada uno.
//
// El silencio es por tiempo, no "no volver a mostrar": el aviso sigue existiendo,
// pero deja de interrumpir cada vez que el profesor cambia de pantalla. El badge
// permanente de Avisos y Próximas clases sigue mostrando el estado real.
import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { PresentationEmailPopup } from '@/components/PresentationEmailPopup';
import { PresentationModal } from '@/components/PresentationModal';
import { hoursSinceAssigned, PRESENTATION_DEADLINE_HOURS } from '@/lib/presentationEmailUtils';
import { baseStudentOf } from '@/lib/cells';
import type { Assignment, Grid } from '@/types';

const SNOOZE_KEY = 'presentation_popup_snooze_until';
const SNOOZE_OVERDUE_HOURS = 4;    // hay alguno fuera de plazo: insiste, pero cada 4 h
const SNOOZE_NORMAL_HOURS  = 12;   // todos dentro de plazo

function snoozedUntil(): number {
  try { return Number(localStorage.getItem(SNOOZE_KEY) ?? 0) || 0; } catch { return 0; }
}
function snooze(hours: number): void {
  try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + hours * 3_600_000)); } catch {}
}

export function PresentationEmailReminder() {
  const { user } = useAuth();
  const { teachers, assignments, students, updateMeetLink, getTeacherGrid } = useTeachers();

  const isTeacher = user?.role === 'teacher';
  const teacher = teachers.find(t => t.id === user?.teacherId);

  const [showPopup, setShowPopup] = useState(false);
  const [modal, setModal] = useState<Assignment | null>(null);
  const [grid, setGrid] = useState<Grid | null>(null);
  const evaluatedRef = useRef(false);

  // El grid decide qué alumnos son suyos (misma regla que el resto del panel):
  // sin esto el popup insistía con alumnos que ya no tiene asignados. Viene
  // cacheado en el contexto, así que no cuesta una consulta por página.
  useEffect(() => {
    if (!isTeacher || !teacher) return;
    let cancelled = false;
    getTeacherGrid(teacher.id)
      .then(g => { if (!cancelled) setGrid(g); })
      .catch(() => { if (!cancelled) setGrid({}); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTeacher, teacher?.id]);

  const inGrid = new Set<string>();
  for (const cell of Object.values(grid ?? {})) {
    const name = baseStudentOf(cell)?.trim();
    if (name) inGrid.add(name.toLowerCase());
  }

  const myPending = (isTeacher && teacher && grid)
    ? assignments.filter(a =>
        a.teacherId === teacher.id &&
        !a.presentationEmailSent &&
        inGrid.has(a.studentName.trim().toLowerCase()))
    : [];

  // Se evalúa una vez por montaje, pero el silencio persiste entre montajes, que
  // es lo que evita el machaque al navegar. Espera al grid y a los datos.
  useEffect(() => {
    if (!isTeacher || !teacher || !grid || evaluatedRef.current) return;
    if (myPending.length === 0) return;
    evaluatedRef.current = true;
    if (Date.now() < snoozedUntil()) return;
    const hasOverdue = myPending.some(a => hoursSinceAssigned(a.createdAt) >= PRESENTATION_DEADLINE_HOURS);
    setShowPopup(true);
    snooze(hasOverdue ? SNOOZE_OVERDUE_HOURS : SNOOZE_NORMAL_HOURS);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTeacher, teacher?.id, grid, myPending.length]);

  // No hace falta cerrar el popup a mano al enviar el último: el render ya exige
  // `myPending.length > 0`, y esa lista se recalcula en cuanto markPresentationSent
  // actualiza el contexto. Desaparece en el mismo render.

  if (!isTeacher || !teacher) return null;

  return (
    <>
      {showPopup && myPending.length > 0 && (
        <PresentationEmailPopup
          assignments={myPending}
          onSend={(a) => { setShowPopup(false); setModal(a); }}
          onRemindLater={() => setShowPopup(false)}
        />
      )}
      {modal && (
        <PresentationModal
          assignment={modal}
          teacher={teacher}
          students={students}
          updateMeetLink={updateMeetLink}
          onClose={() => setModal(null)}
          onSent={() => {}}
        />
      )}
    </>
  );
}
