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

export interface Teacher {
  id: string;
  name: string;
  email: string;
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
  level: string;
  plan: string;
  assignedTeacher?: string;
  assignedSlots?: Array<{ day: string; hour: string }>;
  notes?: string;
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
export type CellState = 'libre' | 'ocupado' | 'bloqueado' | 'no_work';

export interface Cell {
  state: CellState;
  student?: string;
  weekDate?: string;     // 'bloqueado' cells: Monday ISO date of the specific week (YYYY-MM-DD)
  baseState?: CellState; // 'bloqueado' cells: state to revert to in other weeks
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
  | 'profe_del_mes' | 'profe_del_trimestre';

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
