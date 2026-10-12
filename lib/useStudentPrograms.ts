// Programas de alumnos (student_programs) en el NAVEGADOR, vía /api/programas.
//
// Dos usos:
//   · useAllPrograms()           → el panel de alumnos y "Próximos a cancelar"
//                                  (una sola petición para todas las tarjetas).
//   · useStudentPrograms(id, e)  → la ficha del profesor (solo ese alumno).
//
// Si la migración no se corrió, /api/programas devuelve una lista vacía y las
// pantallas se comportan como antes.

'use client';

import { useCallback, useEffect, useState } from 'react';
import type { StudentProgramRow } from '@/lib/programs';

async function fetchPrograms(params?: { student?: string | null; email?: string | null }): Promise<StudentProgramRow[]> {
  const qs = new URLSearchParams();
  if (params?.student) qs.set('student', params.student);
  if (params?.email) qs.set('email', params.email);
  try {
    const res = await fetch(`/api/programas${qs.size ? `?${qs}` : ''}`, { cache: 'no-store' });
    const data = await res.json();
    return Array.isArray(data?.programs) ? data.programs : [];
  } catch {
    return [];
  }
}

export function useAllPrograms(): { programs: StudentProgramRow[]; reload: () => Promise<void> } {
  const [programs, setPrograms] = useState<StudentProgramRow[]>([]);
  const reload = useCallback(async () => { setPrograms(await fetchPrograms()); }, []);
  useEffect(() => {
    let alive = true;
    fetchPrograms().then(p => { if (alive) setPrograms(p); });
    return () => { alive = false; };
  }, []);
  return { programs, reload };
}

export function useStudentPrograms(studentId: string | null, email: string | null): StudentProgramRow[] {
  const [programs, setPrograms] = useState<StudentProgramRow[]>([]);
  useEffect(() => {
    if (!studentId && !email) return;
    let alive = true;
    fetchPrograms({ student: studentId, email: email?.trim().toLowerCase() || null })
      .then(p => { if (alive) setPrograms(p); });
    return () => { alive = false; };
  }, [studentId, email]);
  return programs;
}

/** Los programas de un alumno dentro de la lista completa (enlazados o, si no
 *  están enlazados a nadie, por email de facturación). */
export function programsOfStudent(all: StudentProgramRow[], s: { id: string; email?: string | null }): StudentProgramRow[] {
  const e = s.email?.trim().toLowerCase() ?? '';
  return all.filter(r => r.student_id === s.id || (!r.student_id && !!e && r.email === e));
}
