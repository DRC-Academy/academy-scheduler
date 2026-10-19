// Lo que ve el LMS de una recuperación (forma del contrato,
// docs/recuperaciones-contrato.md). Una sola función para los tres endpoints.

import 'server-only';

import { primerNombre } from '@/lib/studentFollowupEmails';
import type { RecoveryRow } from '@/lib/classRecoveryStore';

export interface LmsRecovery {
  id: string;
  estado: RecoveryRow['status'];
  /**
   * Contrato 1.1. 'ausencia': el profesor no se conectó a la clase y Gestión
   * ofrece los horarios. 'profesor': cualquier otra (canceló el profesor).
   */
  origen: 'ausencia' | 'profesor';
  profesor: string;
  clase_cancelada: { fecha: string; hora: string; horas: number };
  /** Sesión de 2 h recuperada en dos días: qué hora es esta (1 de 2, 2 de 2). */
  parte: { numero: number; de: number };
  ronda: number;
  opciones: Array<{ indice: number; fecha: string; hora: string; horas: number }>;
  mis_propuestas: Array<{ fecha: string; hora: string }>;
  mi_nota: string | null;
  fecha_confirmada: { fecha: string; hora: string; horas: number } | null;
  puede_elegir: boolean;
  puede_decir_ninguna: boolean;
}

export function toLmsRecovery(r: RecoveryRow): LmsRecovery {
  const esperando = r.status === 'esperando_alumno';
  return {
    id: r.id,
    estado: r.status,
    origen: r.origin === 'ausencia' ? 'ausencia' : 'profesor',
    profesor: primerNombre(r.teacherName ?? '') || (r.teacherName ?? ''),
    clase_cancelada: { fecha: r.originalDate, hora: r.originalHour, horas: r.hours * r.parts },
    parte: { numero: r.part, de: r.parts },
    ronda: r.round,
    opciones: esperando ? r.teacherProposals.map((s, i) => ({ indice: i, fecha: s.date, hora: s.hour, horas: s.hours })) : [],
    mis_propuestas: r.studentProposals.map(p => ({ fecha: p.date, hora: p.hour })),
    mi_nota: r.studentNote,
    fecha_confirmada: r.chosenDate && r.chosenHour ? { fecha: r.chosenDate, hora: r.chosenHour, horas: r.hours } : null,
    // Sin opciones (ausencia de un profesor sin horas libres) no hay qué elegir:
    // el LMS muestra directamente el formulario de "proponer horarios".
    puede_elegir: esperando && r.teacherProposals.length > 0,
    puede_decir_ninguna: esperando,
  };
}
