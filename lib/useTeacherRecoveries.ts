'use client';

// Recuperaciones y reservas del profesor, para la agenda (Mis clases) y el
// calendario. Solo se piden si el profesor es beta (el llamador pasa null si no):
// para el resto no se consulta nada y todo sigue como antes.

import { useCallback, useEffect, useState } from 'react';
import { nkName } from '@/lib/sessions';
import { fmtDateDMY } from '@/lib/teacherClasses';

export interface TeacherRecovery {
  id: string; groupId: string; part: number; parts: number;
  studentName: string; originalDate: string; originalHour: string; hours: number;
  status: 'esperando_alumno' | 'alumno_propuso' | 'confirmada' | 'recuperada' | 'sin_acuerdo' | 'anulada';
  teacherProposals: Array<{ date: string; hour: string; hours: number }>;
  studentProposals: Array<{ date: string; hour: string }>;
  chosenDate: string | null; chosenHour: string | null;
}

export interface Reservation { date: string; hour: string; studentName: string }

export function useTeacherRecoveries(teacherId: string | null) {
  const [recoveries, setRecoveries] = useState<TeacherRecovery[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);

  const load = useCallback(async () => {
    if (!teacherId) return;
    try {
      const res = await fetch(`/api/recuperaciones/profesor?teacherId=${encodeURIComponent(teacherId)}`, { cache: 'no-store' });
      const data = await res.json();
      setRecoveries(data.recoveries ?? []);
      setReservations(data.reservations ?? []);
    } catch { /* sin datos: la agenda funciona igual */ }
  }, [teacherId]);

  useEffect(() => {
    if (!teacherId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/recuperaciones/profesor?teacherId=${encodeURIComponent(teacherId)}`, { cache: 'no-store' });
        const data = await res.json();
        if (cancelled) return;
        setRecoveries(data.recoveries ?? []);
        setReservations(data.reservations ?? []);
      } catch { /* sin datos: la agenda funciona igual */ }
    })();
    return () => { cancelled = true; };
  }, [teacherId]);

  return { recoveries, reservations, reload: load };
}

const corta = (s: { date: string; hour: string }) => `${fmtDateDMY(s.date)} ${s.hour}`;

/** Línea de estado bajo una clase cancelada con "No puedo dar esta clase". */
export function recoveryLineFor(recoveries: TeacherRecovery[], studentName: string, date: string, hour: string): string | null {
  const mine = recoveries.filter(r => r.originalDate === date && r.originalHour === hour && nkName(r.studentName) === nkName(studentName) && r.status !== 'anulada');
  if (mine.length === 0) return null;
  return mine.map(r => {
    const pre = r.parts > 1 ? `${r.part}.ª hora: ` : '';
    switch (r.status) {
      case 'esperando_alumno': return `${pre}esperando que elija: ${r.teacherProposals.map(corta).join(' o ')}`;
      case 'alumno_propuso':   return `${pre}propuso otros horarios: ${r.studentProposals.map(corta).join(', ')}`;
      case 'confirmada':       return `${pre}recuperación el ${r.chosenDate ? corta({ date: r.chosenDate, hour: r.chosenHour ?? '' }) : '—'}`;
      case 'recuperada':       return `${pre}recuperada`;
      case 'sin_acuerdo':      return `${pre}sin acuerdo de fecha`;
      default:                 return '';
    }
  }).filter(Boolean).join(' · ');
}

/** ¿Esa hora está reservada para otra recuperación? Devuelve el alumno o null. */
export function reservedSlotAt(reservations: Reservation[], date: string, hour: string): string | null {
  return reservations.find(r => r.date === date && r.hour === hour)?.studentName ?? null;
}
