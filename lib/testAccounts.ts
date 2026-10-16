// ── Cuentas de PRUEBA en las pantallas del admin ─────────────────────────────
//
// Un profesor de prueba (teachers.is_test) y sus alumnos de prueba
// (students.is_test) funcionan como cualquier otro: reciben su campanita, sus
// emails, sus pop-ups de riesgo y sus recordatorios, porque sirven para probar la
// plataforma. Lo único que hace este módulo es decir qué filas esconder en las
// pantallas del admin que lo piden.
//
// ALCANCE (16/10/2026, decisión de Facundo): solo Enlaces, Uso de IA y Riesgo
// (con sus contadores de la barra). El resto del admin —dashboard, finanzas,
// listas de gestión, avisos— sigue mostrándolos como siempre.
//
// TODO SALE DE LA BASE. Ni nombres ni ids escritos acá: para sumar otra cuenta de
// prueba alcanza con marcarla en Supabase. Los datos ya vienen con los
// profesores y alumnos que carga TeachersContext (select '*'), así que filtrar no
// cuesta ninguna consulta extra.
//
// No confundir con lib/externalTeachers.ts (alcance /api/external/*) ni con
// lib/perfilDePrueba.ts (bloqueo de transferencias): esos siguen por id.

import type { Student, Teacher } from '@/types';

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/** Lo que una fila cualquiera puede decir de a quién pertenece. */
export interface OwnedRow {
  teacherId?: string | null;
  teacherName?: string | null;
  studentId?: string | null;
  studentName?: string | null;
  studentEmail?: string | null;
}

export interface TestAccountFilter {
  /** true si no hay ninguna cuenta de prueba marcada: los filtros no hacen nada. */
  empty: boolean;
  isTestTeacher(teacherId: string | null | undefined): boolean;
  isTestStudent(s: { id?: string | null; name?: string | null; email?: string | null }): boolean;
  /** La fila es de un profesor de prueba o de un alumno de prueba. */
  isTestRow(r: OwnedRow): boolean;
}

/**
 * Arma el filtro a partir de las listas que ya están en memoria.
 *
 * Alumno: por id si la fila lo trae; si no, por email; y como último recurso por
 * nombre normalizado (el mismo orden tolerante que usa el resto del sistema).
 * Profesor: por id; y por nombre solo cuando la fila no trae id.
 */
export function buildTestAccountFilter(
  teachers: readonly Pick<Teacher, 'id' | 'name' | 'isTest'>[],
  students: readonly Pick<Student, 'id' | 'name' | 'email' | 'isTest'>[],
): TestAccountFilter {
  const teacherIds = new Set<string>();
  const teacherNames = new Set<string>();
  for (const t of teachers) {
    if (!t.isTest) continue;
    teacherIds.add(t.id);
    if (norm(t.name)) teacherNames.add(norm(t.name));
  }

  const studentIds = new Set<string>();
  const studentEmails = new Set<string>();
  const studentNames = new Set<string>();
  for (const s of students) {
    if (!s.isTest) continue;
    studentIds.add(s.id);
    if (norm(s.email)) studentEmails.add(norm(s.email));
    if (norm(s.name)) studentNames.add(norm(s.name));
  }

  const isTestTeacher = (id: string | null | undefined) => !!id && teacherIds.has(id);

  const isTestStudent: TestAccountFilter['isTestStudent'] = ({ id, name, email }) => {
    if (id) return studentIds.has(id);
    if (norm(email)) return studentEmails.has(norm(email));
    return !!norm(name) && studentNames.has(norm(name));
  };

  return {
    empty: teacherIds.size === 0 && studentIds.size === 0,
    isTestTeacher,
    isTestStudent,
    isTestRow: r => {
      if (r.teacherId ? isTestTeacher(r.teacherId) : teacherNames.has(norm(r.teacherName))) return true;
      return isTestStudent({ id: r.studentId, name: r.studentName, email: r.studentEmail });
    },
  };
}
