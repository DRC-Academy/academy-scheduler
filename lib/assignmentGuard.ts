// Prevención de alumnos con varios profesores. Función PURA: opera sobre las
// assignments ya cargadas, sin tocar la base.
//
// POR QUÉ: el aviso que había en el setter comparaba SOLO `studentId` exacto, y
// se le escapaban los casos reales. Auditoría del 27/07/2026 sobre datos de
// producción: "Virginia Alfonso" y "Facu Test" están dados de alta DOS veces con
// ids distintos, así que el mismo alumno con dos ids pasaba el control sin
// avisar y acababa con dos profesores. Además el flujo del calendario del
// profesor no tenía ningún control.
//
// Aquí se busca por las tres señales que usa el resto del sistema (id, email,
// nombre normalizado) y se informa de CUÁL coincidió, para que el aviso pueda
// decir por qué cree que es la misma persona.

import type { Assignment, AssignedSlot } from '@/types';

export type MatchBy = 'id' | 'email' | 'nombre';

export interface ExistingAssignmentMatch {
  assignmentId: string;
  teacherId: string;
  teacherName: string;
  studentName: string;
  slots: AssignedSlot[];
  startDate?: string;
  matchedBy: MatchBy;
}

const nk = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/**
 * Assignments de OTROS profesores para el mismo alumno.
 *
 * `currentTeacherId` se excluye a propósito: reasignar horarios dentro del mismo
 * profesor no es el caso que queremos frenar.
 */
export function findOtherTeacherAssignments(
  identity: { studentId?: string | null; email?: string | null; name?: string | null },
  assignments: Assignment[],
  currentTeacherId: string,
): ExistingAssignmentMatch[] {
  const id = (identity.studentId ?? '').trim();
  const email = nk(identity.email);
  const name = nk(identity.name);
  if (!id && !email && !name) return [];

  const out: ExistingAssignmentMatch[] = [];
  const vistos = new Set<string>();

  for (const a of assignments) {
    if (a.teacherId === currentTeacherId) continue;
    if (vistos.has(a.id)) continue;

    // El orden importa: se informa de la señal MÁS fuerte que coincidió.
    let matchedBy: MatchBy | null = null;
    if (id && a.studentId === id) matchedBy = 'id';
    else if (email && nk(a.studentEmail) === email) matchedBy = 'email';
    else if (name && nk(a.studentName) === name) matchedBy = 'nombre';
    if (!matchedBy) continue;

    vistos.add(a.id);
    out.push({
      assignmentId: a.id,
      teacherId:    a.teacherId,
      teacherName:  a.teacherName,
      studentName:  a.studentName,
      slots:        a.slots ?? [],
      startDate:    a.startDate,
      matchedBy,
    });
  }
  return out;
}

/** Texto de por qué se considera el mismo alumno (para el aviso). */
export function matchLabel(m: MatchBy): string {
  return m === 'id' ? 'es el mismo alumno'
       : m === 'email' ? 'coincide el email'
       : 'coincide el nombre';
}

/** Resumen legible de los horarios de una asignación. */
export function slotsLabel(slots: AssignedSlot[]): string {
  return slots.map(s => `${s.day} ${s.hour}`).join(', ') || 'sin horario';
}
