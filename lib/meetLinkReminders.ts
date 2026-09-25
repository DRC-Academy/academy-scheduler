// Qué recordatorios del ENLACE DE CLASE tocan en una corrida del cron
// (app/api/cron/check-presentation-emails). Módulo PURO: recibe las filas y la
// hora, devuelve el plan. El cron se encarga de la base y de Resend.
//
// Umbrales desde la asignación (lib/meetLinkStatus): 4 h → profe; 12 h y 24 h →
// profe y admin. Solo asignaciones sin enlace definido y con menos de 96 h
// (REMINDER_WINDOW_HOURS): eso protege de avisos masivos por asignaciones viejas.
//
// COLAPSO DE ATRASOS. Si en una corrida vencen varios umbrales a la vez (el cron
// estuvo parado, o la asignación entró con los indicadores sin marcar) se envía
// SOLO el más alto y se dan por cubiertos los anteriores. Sin esto, un profesor
// recibía de golpe "4 h", "12 h" y "24 h" del mismo alumno.
//
// IDS CON EL PROFESOR DENTRO. Notificaciones y reservas de email llevan el id de
// la asignación Y el del profesor. Un cambio de profesor reinicia los
// indicadores de la fila (dbChangeStudentTeacher); si el id fuera solo de la
// asignación, el aviso del profesor anterior ya existiría con ese id y el nuevo
// no recibiría nada.

import { hoursSinceAssignment, LINK_WARNING_HOURS, LINK_AT_RISK_HOURS, LINK_DEADLINE_HOURS } from '@/lib/meetLinkStatus';

/** Antigüedad máxima (desde created_at) para mandar recordatorios. */
export const REMINDER_WINDOW_HOURS = 96;

export type ReminderThreshold = '4h' | '12h' | '24h';

/** Columna de la asignación que marca cada umbral como cubierto. */
export type ReminderFlag = 'presentation_reminder_4h_sent' | 'presentation_reminder_12h_sent' | 'presentation_reminder_24h_sent';

export interface ReminderRow {
  id: string;
  teacher_id: string;
  teacher_name: string;
  student_name: string;
  created_at: string;
  presentation_reminder_4h_sent: boolean | null;
  presentation_reminder_12h_sent: boolean | null;
  presentation_reminder_24h_sent: boolean | null;
}

export interface ReminderNotification {
  id: string;
  target_user: string | null;
  target_role: string | null;
  title: string;
  body: string;
  type: string;
}

export interface ReminderEmail {
  /** Id de la reserva en daily_reminder_log: una por email, nunca se repite. */
  claimId: string;
  to: 'teacher' | 'admin';
}

export interface PlannedReminder {
  assignmentId: string;
  teacherId: string;
  teacherName: string;
  studentName: string;
  hours: number;
  threshold: ReminderThreshold;
  /** Columnas a marcar true si TODOS los emails salen bien (incluye las de los umbrales colapsados). */
  flags: ReminderFlag[];
  notifications: ReminderNotification[];
  emails: ReminderEmail[];
}

const UMBRALES: Array<{ t: ReminderThreshold; hours: number; flag: ReminderFlag }> = [
  { t: '4h',  hours: LINK_WARNING_HOURS,  flag: 'presentation_reminder_4h_sent' },
  { t: '12h', hours: LINK_AT_RISK_HOURS,  flag: 'presentation_reminder_12h_sent' },
  { t: '24h', hours: LINK_DEADLINE_HOURS, flag: 'presentation_reminder_24h_sent' },
];

const key = (t: ReminderThreshold, to: 'teacher' | 'admin', r: ReminderRow) => `${t}_${to}_${r.id}_${r.teacher_id}`;

function notificationsFor(t: ReminderThreshold, r: ReminderRow, hours: number): ReminderNotification[] {
  const s = r.student_name;
  const h = Math.floor(hours);
  const teacher = (title: string, body: string, type: string): ReminderNotification =>
    ({ id: `meetlink_${key(t, 'teacher', r)}`, target_user: r.teacher_id, target_role: null, title, body, type });
  const admin = (title: string, type: string): ReminderNotification =>
    ({ id: `meetlink_${key(t, 'admin', r)}`, target_user: null, target_role: 'admin', title, body: `${r.teacher_name} aún no ha definido el enlace de ${s} (${h} h).`, type });

  if (t === '4h') {
    return [teacher(
      `🔗 Define el enlace de ${s}`,
      `Han pasado 4 h desde que se te asignó a ${s} y su clase sigue sin enlace. El alumno recibe automáticamente las instrucciones de acceso: solo falta tu enlace de Meet.`,
      'presentation_email_reminder',
    )];
  }
  if (t === '12h') {
    return [
      teacher(
        `⚠️ Enlace pendiente — ${s}`,
        `Llevas 12 h sin definir el enlace de clase de ${s}. Te quedan menos de 12 h para hacerlo a tiempo.`,
        'presentation_email_warning_teacher',
      ),
      admin(`⚠️ Enlace pendiente — ${r.teacher_name}`, 'presentation_email_warning'),
    ];
  }
  return [
    teacher(
      `🔴 Enlace fuera de plazo — ${s}`,
      `La clase de ${s} sigue sin enlace pasadas 24 h. Defínelo cuanto antes: al hacerlo fuera de plazo se descuentan -5 puntos de tu scoring.`,
      'presentation_email_overdue_teacher',
    ),
    admin(`🔴 Enlace fuera de plazo — ${r.teacher_name}`, 'presentation_email_overdue'),
  ];
}

/** El plan de la corrida: como mucho UN umbral por asignación (el más alto vencido y sin cubrir). */
export function planMeetLinkReminders(rows: ReminderRow[], now: number): PlannedReminder[] {
  const out: PlannedReminder[] = [];
  for (const r of rows) {
    const hours = hoursSinceAssignment(r.created_at, now);
    if (hours > REMINDER_WINDOW_HOURS) continue;

    const pendientes = UMBRALES.filter(u => hours >= u.hours && !r[u.flag]);
    if (pendientes.length === 0) continue;
    const top = pendientes[pendientes.length - 1];

    out.push({
      assignmentId: r.id,
      teacherId: r.teacher_id,
      teacherName: r.teacher_name,
      studentName: r.student_name,
      hours,
      threshold: top.t,
      flags: pendientes.map(u => u.flag),
      notifications: notificationsFor(top.t, r, hours),
      emails: top.t === '4h'
        ? [{ claimId: `drl_meetlink_${key(top.t, 'teacher', r)}`, to: 'teacher' }]
        : [
            { claimId: `drl_meetlink_${key(top.t, 'teacher', r)}`, to: 'teacher' },
            { claimId: `drl_meetlink_${key(top.t, 'admin', r)}`, to: 'admin' },
          ],
    });
  }
  return out;
}
