// ── Constantes del scoring ───────────────────────────────────────────────────
//
// Vivían en lib/db.ts. Se mudaron acá porque lib/db.ts instancia el cliente de
// Supabase al importarse, y los módulos puros (lib/bonuses, lib/finance) y sus
// tests no pueden arrastrarlo. lib/db.ts las re-exporta tal cual, así que
// `import { EVENT_EUROS } from '@/lib/db'` sigue funcionando: es la MISMA
// constante, definida una sola vez.

export const EVENT_POINTS: Record<string, number> = {
  falta_injustificada: -15,
  falta_justificada:    -5,
  atraso:               -8,
  queja:               -20,
  cancelacion_tardia:  -10,
  upsell:               25,
  bonus_retencion:      30,
  bonus_puntualidad:    20,
  review_trustpilot:    15,
  bonus_feedback:       10,
  cambio_por_alumno:   -10,
  cambio_por_profesor: -20,
  profe_del_mes:        50,
  profe_del_trimestre: 100,
  // Histórico: el email de presentación que mandaba el profesor (hasta sep/2026).
  email_presentacion_tardio: -5,
  // Enlace de clase definido pasadas 24 h de la asignación. Lo aplica SOLO la
  // ruta PUT /api/assignments/[assignmentId]/meet-link, una vez por asignación y
  // profesor (lib/meetLinkStatus.shouldPenalizeLateLink).
  enlace_tardio: -5,
  // Se carga SOLO a mano desde la auditoría de intervenciones (panel de admin).
  // El sistema nunca lo aplica automáticamente: una intervención sutil puede no
  // verse en el transcript, así que la decisión es humana.
  alerta_no_atendida:  -10,
};

// Importe en euros de cada tipo de evento. Los NEGATIVOS son penalizaciones y se
// restan del pago del mes (lib/finance.ts los suma aparte para mostrarlos en rojo).
//
// Los dos POSITIVOS (upsell, bonus_retencion) ya no se pagan por scoring_events:
// desde septiembre de 2026 son filas de `teacher_bonuses` (ver lib/bonuses.ts),
// que lee de acá el importe. Siguen en esta tabla para que el importe tenga una
// única definición.
export const EVENT_EUROS: Record<string, number> = {
  upsell:          20,
  bonus_retencion: 30,
  // Una falta injustificada resta 15 puntos de scoring Y 5 € del pago, igual que
  // la falta sin aviso registrada desde el calendario. Antes solo restaba puntos,
  // así que el admin la cargaba esperando ver el descuento en finanzas y no pasaba
  // nada.
  falta_injustificada: -5,
};
