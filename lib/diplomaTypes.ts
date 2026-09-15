// Tipos del diploma del LMS, aparte de lib/lmsDiploma.ts para que los componentes
// cliente puedan importarlos sin tocar un módulo `server-only`.

export type DiplomaEstado = 'en-curso' | 'conseguido' | 'sin-curso';

/** La forma fija que devuelve el LMS en los tres estados. */
export interface Diploma {
  estado: DiplomaEstado;
  completadas: number;
  total: number;
  restantes: number;
  curso: { slug: string; titulo: string } | null;
}
