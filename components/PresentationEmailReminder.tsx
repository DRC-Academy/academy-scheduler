'use client';
// ── Recordatorio de emails de presentación (montado en el NavBar) ──────────────
// Aparece en TODA la app del profesor sin duplicar código: el NavBar se renderiza
// en cada página, así que basta montarlo aquí una vez. Solo actúa para el rol
// teacher; para el resto de roles no renderiza nada.
//
// Regla de frecuencia:
//   · Si TODOS los pendientes tienen < 24 h → se muestra una sola vez por sesión
//     (sessionStorage 'presentation_popup_shown').
//   · Si HAY alguno fuera de plazo (≥ 24 h) → se muestra SIEMPRE en cada recarga,
//     ignorando el sessionStorage: ese alumno necesita atención inmediata.
// No existe "no volver a mostrar".
import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { PresentationEmailPopup } from '@/components/PresentationEmailPopup';
import { PresentationModal } from '@/components/PresentationModal';
import { hoursSinceAssigned, PRESENTATION_DEADLINE_HOURS } from '@/lib/presentationEmailUtils';
import type { Assignment } from '@/types';

export function PresentationEmailReminder() {
  const { user } = useAuth();
  const { teachers, assignments, students, updateMeetLink } = useTeachers();

  const isTeacher = user?.role === 'teacher';
  const teacher = teachers.find(t => t.id === user?.teacherId);

  const [showPopup, setShowPopup] = useState(false);
  const [modal, setModal] = useState<Assignment | null>(null);
  const evaluatedRef = useRef(false);

  const myPending = (isTeacher && teacher)
    ? assignments.filter(a => a.teacherId === teacher.id && !a.presentationEmailSent)
    : [];

  // Se evalúa una vez por montaje (login / recarga). No reaparece tras enviar o
  // descartar dentro de la misma vista; una recarga es un montaje nuevo y vuelve
  // a evaluar. Espera a que lleguen los datos (si aún no hay pendientes, no marca
  // evaluatedRef y reintenta al siguiente cambio de assignments).
  useEffect(() => {
    if (!isTeacher || !teacher || evaluatedRef.current) return;
    if (myPending.length === 0) return;
    evaluatedRef.current = true;
    const hasOverdue = myPending.some(a => hoursSinceAssigned(a.createdAt) >= PRESENTATION_DEADLINE_HOURS);
    let shownThisSession = false;
    try { shownThisSession = sessionStorage.getItem('presentation_popup_shown') === '1'; } catch {}
    if (!shownThisSession || hasOverdue) {
      setShowPopup(true);
      try { sessionStorage.setItem('presentation_popup_shown', '1'); } catch {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTeacher, teacher?.id, myPending.length]);

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
