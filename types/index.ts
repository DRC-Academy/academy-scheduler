export type TeacherStatus = 'available' | 'almost_full' | 'busy' | 'vacation' | 'no_availability';

export interface TimeSlot {
  day: string;
  from: string;
  to: string;
  spots: number;
  usedSpots: number;
}

export interface Vacation {
  from: string;
  to: string;
  note?: string;
}

export interface BlockedSlot {
  date: string;
  from: string;
  to: string;
  reason: string;
}

export interface UpcomingClass {
  id: string;
  studentName: string;
  day: string;
  time: string;
  duration: number;
  type: string;
}

// Avisos por email del profesor. Opt-out: si falta la clave, se envía igual.
export interface EmailPreferences {
  new_student?: boolean;
  form_completed?: boolean;
  presentation_reminder?: boolean;
  milestones?: boolean;
  bonus?: boolean;
  circulars?: boolean;
}

export const EMAIL_PREF_LABELS: Array<{ key: keyof EmailPreferences; label: string }> = [
  { key: 'new_student',           label: 'Nuevo alumno asignado' },
  { key: 'form_completed',        label: 'Formulario inicial completado' },
  { key: 'presentation_reminder', label: 'Recordatorio email de presentación' },
  { key: 'milestones',            label: 'Hitos de clase (15, 30, 50)' },
  { key: 'bonus',                 label: 'Bono de 6 meses disponible' },
  { key: 'circulars',             label: 'Circulares del equipo' },
];

export interface Teacher {
  id: string;
  name: string;
  email: string;
  notificationEmail?: string;    // correo donde llegan los avisos (si vacío, se usa email)
  emailPreferences?: EmailPreferences;   // avisos por email; ausente = todos activados
  gender?: 'male' | 'female';    // opcional; si falta se detecta por nombre (lib/gender.ts)
  avatar: string;
  status: TeacherStatus;
  weeklyLoad: number;
  maxWeeklyLoad: number;
  freeSpots: number;
  totalSpots: number;
  nextClass?: string;
  timeSlots: TimeSlot[];
  blockedSlots: BlockedSlot[];
  vacations: Vacation[];
  upcomingClasses: UpcomingClass[];
  specialties: string[];
  libreCells?: string[];         // exact `${day}_${hour}` keys whose grid cell state === 'libre'
  internalRating?: number;
  createdAt?: string;
  currentLevel?: number;
  totalScore?: number;
  totalEuros?: number;
  // New fields
  retentionRate?: number;
  isBlocked?: boolean;
  isTeacherOfMonth?: boolean;
  isTeacherOfQuarter?: boolean;
  teacherOfMonthDate?: string;
  lastMonthlyReset?: string;
  lastQuarterlyReset?: string;
}

export interface Student {
  id: string;
  name: string;
  email: string;
  phone?: string;
  gender?: 'male' | 'female';    // opcional; si falta se detecta por nombre (lib/gender.ts)
  level: string;
  plan: string;
  assignedTeacher?: string;
  assignedSlots?: Array<{ day: string; hour: string }>;
  notes?: string;
  manualActiveUntil?: string; // 'YYYY-MM-DD' — activación manual / acceso pago único
  productType?: 'subscription' | 'one_time'; // tipo de producto WooCommerce
  productName?: string;       // nombre real del producto en WooCommerce
  createdAt: string;
}

export interface AssignedSlot {
  day: string;
  hour: string;
}

export interface Assignment {
  id: string;
  teacherId: string;
  teacherName: string;
  teacherEmail: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  studentLevel: string;
  slots: AssignedSlot[];         // all assigned day+hour combinations
  objetivo: string;
  plan: string;
  weeklyHours: number;
  availability: string;          // free text: "Lunes a Viernes 16:00hs"
  notes: string;
  startDate?: string;
  createdAt: string;
  manualClassAdjustment?: number;
  meetLink?: string;
  presentationEmailSent?: boolean;    // email de bienvenida enviado al alumno
  presentationEmailSentAt?: string;   // ISO en que se marcó como enviado
}

export interface ClassJoinLog {
  id: string;
  teacherId: string;
  teacherName: string;
  studentName: string;
  scheduledDate: string;
  scheduledTime: string;
  clickedAt: string;
  punctuality: 'on_time' | 'late' | 'very_late';
  subscriptionStatus?: string;          // estado WooCommerce: 'active' | 'cancelled' | 'on-hold' | 'expired' | 'pending-cancel' | 'not_found' | 'error' | 'not_verified'
  enteredWithoutActive?: boolean;       // ingresó pese a no tener suscripción activa
  subscriptionDaysRemaining?: number;   // días restantes hasta fin de suscripción (ej. en 'pending-cancel')
}

export interface AdminAlert {
  id: string;
  type: 'conflict' | 'coverage' | 'warning';
  message: string;
  severity: 'high' | 'medium' | 'low';
}

export type UserRole = 'admin' | 'setter' | 'teacher';

export interface AppUser {
  id: string;
  username: string;
  password: string;
  role: UserRole;
  teacherId?: string;
  displayName: string;
}

// Calendar cell
// 'bloqueado' = "En recuperación" (clase puntual recuperada). 'reprogramada' = la
// celda ORIGINAL de una clase que se movió a otra fecha (marca puntual de esa semana).
export type CellState = 'libre' | 'ocupado' | 'bloqueado' | 'no_work' | 'reprogramada';

export interface Cell {
  state: CellState;
  student?: string;
  weekDate?: string;      // 'bloqueado'/'reprogramada' cells: Monday ISO date of the specific week (YYYY-MM-DD)
  baseState?: CellState;  // 'bloqueado'/'reprogramada' cells: state to revert to in other weeks
  recoveryFor?: string;   // 'bloqueado' (En recuperación) cells: 'YYYY-MM-DD' de la clase original que se recupera
  recoveryNote?: string;  // 'bloqueado' cells: nota opcional del profesor sobre la recuperación
  rescheduledTo?: string; // 'reprogramada' cells: 'YYYY-MM-DD' de la nueva fecha a la que se movió la clase
}

export type Grid = Record<string, Cell>;

// Multi-slot filter
export interface SlotFilter {
  id: string;
  day: string;
  hour: string;
}

// Scoring
export type ScoringEventType =
  | 'falta_injustificada' | 'falta_justificada'
  | 'atraso' | 'queja' | 'cancelacion_tardia'
  | 'upsell' | 'bonus_retencion' | 'bonus_puntualidad'
  | 'review_trustpilot' | 'bonus_feedback'
  | 'cambio_por_alumno' | 'cambio_por_profesor'
  | 'profe_del_mes' | 'profe_del_trimestre'
  | 'email_presentacion_tardio'
  // Penalización económica por falta sin aviso (-5 €) y su reversión (+5 €).
  | 'falta_sin_aviso_penalizacion' | 'penalizacion_revertida';

export interface ScoringEvent {
  id: string;
  teacherId: string;
  teacherName: string;
  eventType: ScoringEventType;
  points: number;
  euros: number;
  note: string;
  createdAt: string;
  createdBy: string;
  studentRef?: string;
  quantity?: number;
  // Reversión de penalización (Bloque 4.5): la penalización original queda tachada.
  reverted?: boolean;
  revertedBy?: string;
  revertedAt?: string;
}

export interface ClassCount {
  id: string;
  teacherId: string;
  studentName: string;
  studentEmail?: string;
  classNumber: number;
  lastUpdated: string;
}

export interface AppNotification {
  id: string;
  targetUser?: string;
  targetRole?: string;
  title: string;
  body: string;
  type: string;
  readBy: string[];
  createdAt: string;
  createdBy: string;
}

// ── FINANCE ───────────────────────────────────────────────────────────────────

// Tipo de clase registrada por el profesor.
// 'reprogramada' = constancia de una clase movida a otra fecha; NO cuenta para el
// pago (la clase se contará cuando efectivamente se dé). Ver lib/finance.ts.
export type ClassRecordType = 'normal' | 'falta_sin_aviso' | 'cancelacion_hora' | 'recuperacion' | 'reprogramada' | 'falta_con_aviso' | 'cancelada_con_preaviso';

// Captura de pantalla de una clase dada, subida por el profesor.
export interface ClassRecord {
  id: string;
  teacherId: string;
  teacherName: string;
  studentName: string;
  classDate: string;       // 'YYYY-MM-DD'
  classTime?: string;      // 'HH:MM'
  screenshotUrl: string;
  comment?: string;        // comentario opcional del profesor
  classType?: ClassRecordType; // 'normal' por defecto
  subscriptionStatus?: string; // estado WooCommerce al momento de registrar la clase
  originalDate?: string;       // 'reprogramada'/'cancelacion_hora': fecha original de la clase movida
  rescheduledTo?: string;      // 'reprogramada': nueva fecha a la que se movió la clase
  recoveryForDate?: string;    // 'recuperacion': fecha de la clase original que se recupera
  createdAt: string;
}

// Aprobación manual de una clase puntual por el admin (tabla finance_manual_approvals).
export interface FinanceManualApproval {
  id: string;
  teacherId: string;
  studentName: string;
  classDate: string;       // 'YYYY-MM-DD'
  approvedBy: string;
  approvedAt: string;
  reason?: string;         // 'a_revisar_aprobado' | 'excede_limite_aprobado'
}

// Pago mensual liquidado/pendiente por profesor. Cuando status='paid' el mes
// queda congelado como histórico (no se recalcula).
export interface FinancePayment {
  id: string;
  teacherId: string;
  teacherName: string;
  monthYear: string;       // 'YYYY-MM'
  totalClassesPayable: number;
  totalAmount: number;
  bonusAmount: number;
  status: 'pending' | 'paid';
  paidAt?: string;
  approvedOverrides?: string[]; // claves 'studentName__YYYY-MM-DD' forzadas a pagable
}

// Tarifa por tipo de plan + antigüedad.
export interface FinanceRate {
  id: string;
  planType: 'general' | 'examenes';
  tier: 'nuevo' | 'antiguo';
  rate: number;
}
