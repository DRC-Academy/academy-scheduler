// ─── Hitos de clase (milestones) ──────────────────────────────────────────────
// Única fuente de verdad para la lógica de hitos: números, links de diapositivas
// y copy de los disclaimers. Reutilizado por el panel del profesor
// (Próximas clases), Conteo automático y Mis clases.

export const MILESTONES = [1, 15, 30, 50] as const;

export const MILESTONE_SLIDES: Record<number, string> = {
  1:  'https://docs.google.com/presentation/d/1S0xIFac3UIQfqERl76hMINNGSaw3VCyc/edit',
  15: 'https://docs.google.com/presentation/d/1IimpCeF6k1KwnRqGIjVX5uo_OR-SpO6z/edit',
  30: 'https://docs.google.com/presentation/d/1llaPvc-lnhC8F7hh7-uIlc2COD3tPPYN/edit',
  50: 'https://docs.google.com/presentation/d/14j3KOCc4gT_iSZs7Pv35uDENtuGcjXdq/edit',
};

export const MILESTONE_COPY: Record<number, string> = {
  1:  'Esta es la clase 1 con [ALUMNO]. Recuerda presentarte con las diapositivas de bienvenida y grabar la sesión con Fathom.',
  15: 'Esta es la clase 15 con [ALUMNO]. Recuerda grabar la clase con Fathom, subir el enlace al Excel y aprovechar para pedir una reseña en Trustpilot.',
  30: 'Esta es la clase 30 con [ALUMNO]. Recuerda grabar la clase con Fathom y subir el enlace al Excel. También podés solicitar el bono de retención al admin.',
  50: 'Esta es la clase 50 con [ALUMNO]. ¡Un hito increíble! Recuerda grabar la clase con Fathom y subir el enlace al Excel.',
};

// Descripción corta de cada hito para la sección "Materiales de clase".
export const MILESTONE_TITLES: Record<number, { title: string; description: string }> = {
  1:  { title: 'Presentación inicial', description: 'Diapositivas de bienvenida para nuevos alumnos' },
  15: { title: 'Hito de seguimiento',  description: 'Revisión de progreso y solicitud de reseña' },
  30: { title: 'Hito de retención',    description: 'Celebración de continuidad con el alumno' },
  50: { title: 'Gran hito',            description: 'Celebración especial de trayectoria' },
};

export function isMilestone(classNumber: number): boolean {
  return (MILESTONES as readonly number[]).includes(classNumber);
}

export function getMilestoneSlides(classNumber: number): string | null {
  return MILESTONE_SLIDES[classNumber] || null;
}

export function getMilestoneCopy(classNumber: number, studentName: string): string | null {
  const template = MILESTONE_COPY[classNumber];
  if (!template) return null;
  return template.replace('[ALUMNO]', studentName);
}

export function getNextMilestone(currentClass: number): number | null {
  return (MILESTONES as readonly number[]).find(m => m > currentClass) ?? null;
}

// Retorna el hito si el alumno está a 'threshold' clases o menos de alcanzarlo.
export function isApproachingMilestone(currentClass: number, threshold: number = 2): number | null {
  const next = getNextMilestone(currentClass);
  if (next && (next - currentClass) <= threshold) return next;
  return null;
}
