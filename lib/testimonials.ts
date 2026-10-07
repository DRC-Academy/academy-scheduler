// Testimoniales — los clips de una pareja, tal como los guarda la columna
// testimonial_candidates.clips y los enseña la pestaña del admin. Módulo PURO.
//
// Desde la V5 (07/10/2026) la detección vive en lib/testimonialSpeaker (quién es
// el alumno), lib/testimonialPairs (comprobación y emparejamiento) y
// lib/testimonialMomentsStore (servidor).

import { formatSeconds } from '@/lib/fluency';

// ── Clips (columna testimonial_candidates.clips, supabase-testimoniales-clips.sql) ──

/** Un clip corto del alumno, ya comprobado: la cita existe y es suya. */
export interface TestimonialClip {
  analysisId: string;
  /** 'YYYY-MM-DD', fecha de la clase en España. */
  classDate: string;
  teacherId: string | null;
  /** Segundos desde el inicio de la grabación. */
  start: number;
  end: number;
  excerpt: string;
  /** Por qué es un momento malo o bueno (una frase de la IA). */
  why: string;
  /** Grabación de Fathom abierta en `start` (?timestamp=), o null si la clase no la trae. */
  fathomUrl: string | null;
  /** V5: etiqueta del alumno en Fathom en esa clase. */
  speakerLabel?: string;
}

/** Un clip de cada lado (las parejas de antes del 07/10/2026 pueden traer hasta 3). */
export interface TestimonialClips {
  malos: TestimonialClip[];
  buenos: TestimonialClip[];
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** "16 jul · 8:20 – 8:27" */
export function clipLabel(c: Pick<TestimonialClip, 'classDate' | 'start' | 'end'>): string {
  const [, m, d] = c.classDate.slice(0, 10).split('-').map(Number);
  const dia = m && d ? `${d} ${MESES[m - 1]}` : 'Sin fecha';
  return `${dia} · ${formatSeconds(c.start)} – ${formatSeconds(c.end)}`;
}
