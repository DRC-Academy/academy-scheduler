// El ÚNICO perfil de profesor de prueba de DRC Gestión: "Sebastian (test)".
//
// No confundir con PROFESORES_DE_PRUEBA de lib/externalTeachers.ts: esa lista es
// la de los profesores que NO salen por /api/external/* (pagos, métricas) e
// incluye a t2 (Mauricio), que es un profesor REAL con alumnos reales. Para
// decidir si un profesor es "de prueba" en una operación (p. ej. que el LMS o
// un setter no puedan transferir alumnos a él) se usa esta constante.
//
// Por id, no por el "(test)" del nombre: el nombre se edita desde el admin.

/** teacher_id de "Sebastian (test)", el único perfil de prueba. */
export const PERFIL_DE_PRUEBA_TEACHER_ID = 't1';

/** true solo para el perfil de prueba (t1). t2 y el resto son profesores reales. */
export function esPerfilDePrueba(teacherId: string): boolean {
  return teacherId === PERFIL_DE_PRUEBA_TEACHER_ID;
}
