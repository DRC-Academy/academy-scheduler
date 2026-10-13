// QUÉ profesor le toca al alumno que cambia de profesor desde el LMS. Módulo puro.
//
// El alumno elige solo horarios; Gestión elige el profesor entre los candidatos
// que tienen libres TODOS esos horarios. El criterio vive SOLO aquí para poder
// cambiarlo sin tocar nada más:
//   1. menos asignaciones activas (reparte la carga);
//   2. si empatan, el calendario actualizado más recientemente
//      (teacher_calendars.updated_at: es el que más se fía de lo que pinta);
//   3. si empatan, el id menor (determinista: la misma entrada da siempre el
//      mismo profesor).

export interface CandidatoAElegir {
  id: string;
  /** Asignaciones activas del profesor ahora mismo. */
  asignacionesActivas: number;
  /** teacher_calendars.updated_at (ISO) o null si no se sabe. */
  calendarioActualizadoEn: string | null;
}

const instante = (iso: string | null): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};

/** Negativo si `a` va antes que `b` según el criterio. */
export function compararCandidatos(a: CandidatoAElegir, b: CandidatoAElegir): number {
  if (a.asignacionesActivas !== b.asignacionesActivas) return a.asignacionesActivas - b.asignacionesActivas;
  const ta = instante(a.calendarioActualizadoEn);
  const tb = instante(b.calendarioActualizadoEn);
  if (ta !== tb) return ta > tb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** El mejor candidato, o null si no hay ninguno. */
export function elegirProfesor<T extends CandidatoAElegir>(candidatos: readonly T[]): T | null {
  return candidatos.reduce<T | null>((mejor, c) => (!mejor || compararCandidatos(c, mejor) < 0 ? c : mejor), null);
}
