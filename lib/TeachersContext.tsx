'use client';
import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Teacher, Student, Assignment, Grid, ScoringEvent, ClassCount, AppNotification, ClassJoinLog, ClassRecord, ClassRecordType, FinanceRate, FinancePayment, FinanceManualApproval, EmailPreferences } from '@/types';
import {
  dbGetTeachers, dbAddTeacher,
  dbGetStudents, dbUpsertStudent, dbDeleteStudent, dbUpdateStudent,
  dbGetAssignments, dbAddAssignment, dbGetAllStudentsWithAssignments,
  dbGetTeacherGrid, dbSaveTeacherGrid, dbUpdateTeacherRating,
  dbAddScoringEvent, dbGetScoringEvents,
  dbAssignTeacherOfMonth, dbAssignTeacherOfQuarter,
  dbCheckAndResetMonthly, dbCheckAndResetQuarterly,
  dbForceMonthlyReset, dbForceQuarterlyReset,
  dbGetClassCounts, dbIncrementClassCount,
  dbUpdateAssignmentAdjustment, dbUpdateAssignmentStartDate, dbUpdateAssignmentSlots,
  dbUpdateTeacherSpecialties, dbUpdateTeacherInfo, dbUpdateTeacherNotificationEmail, dbUpdateTeacherEmailPreferences,
  dbSendNotification, dbGetNotificationsForUser, dbMarkNotificationRead, dbMarkAllNotificationsRead,
  dbUpdateMeetLink, dbLogClassJoin, dbGetClassJoinLogs, dbGetUnassignedStudents,
  dbNotifyNewAssignment,
  dbGetClassRecords, dbUploadClassScreenshot, dbAddClassRecord, dbAttachScreenshotToClass,
  dbGetFinanceRates, dbGetFinancePayments, dbMarkPaymentPaid,
  dbGetManualApprovals, dbAddManualApproval,
  dbChangeStudentTeacher, dbAddRescheduleRecord, dbAddRecoveryClass, dbRemoveAssignment,
} from '@/lib/db';
import type { AffectedTeacher, ChangeTeacherParams } from '@/lib/db';
import type { AssignedSlot } from '@/types';
import { calculateTeacherFinance } from '@/lib/finance';
import { checkSubscription } from '@/lib/useSubscriptionStatus';

interface TeachersContextType {
  teachers: Teacher[];
  students: Student[];
  assignments: Assignment[];
  teacherGrids: Record<string, Grid>;
  loadingTeachers: boolean;
  scoringEvents: ScoringEvent[];
  classCounts: ClassCount[];
  notifications: AppNotification[];
  unassignedStudents: Student[];
  classJoinLogs: ClassJoinLog[];
  classRecords: ClassRecord[];
  financeRates: FinanceRate[];
  financePayments: FinancePayment[];
  manualApprovals: FinanceManualApproval[];
  lastUpdated: Date | null;
  addTeacher: (t: Teacher, username: string) => Promise<void>;
  addStudent: (s: Student) => Promise<void>;
  deleteStudent: (studentId: string, studentName: string, createdBy?: string) => Promise<AffectedTeacher[]>;
  updateStudent: (student: Student) => Promise<void>;
  addAssignment: (a: Assignment) => Promise<void>;
  getTeacherGrid: (teacherId: string, force?: boolean) => Promise<Grid>;
  updateTeacherGrid: (teacherId: string, grid: Grid) => Promise<void>;
  updateTeacherRating: (teacherId: string, rating: number) => Promise<void>;
  updateTeacherSpecialties: (teacherId: string, specialties: string[]) => Promise<void>;
  updateTeacherInfo: (teacherId: string, data: { name: string; email: string; specialties: string[]; notificationEmail?: string }) => Promise<void>;
  updateTeacherEmailPreferences: (teacherId: string, prefs: EmailPreferences) => Promise<void>;
  addScoringEvent: (event: Omit<ScoringEvent, 'id' | 'createdAt'>) => Promise<void>;
  loadScoringEvents: () => Promise<void>;
  checkAndRunResets: () => Promise<void>;
  assignTeacherOfMonth: (teacherId: string, euros: number) => Promise<void>;
  assignTeacherOfQuarter: (teacherId: string, euros: number) => Promise<void>;
  forceMonthlyReset: () => Promise<void>;
  forceQuarterlyReset: () => Promise<void>;
  reloadAll: () => Promise<void>;
  loadClassCounts: (teacherId: string) => Promise<void>;
  incrementClassCount: (teacherId: string, studentName: string, studentEmail?: string) => Promise<ClassCount>;
  updateAssignmentAdjustment: (assignmentId: string, newAdjustment: number) => Promise<void>;
  updateAssignmentStartDate: (assignmentId: string, startDate: string) => Promise<void>;
  updateAssignmentSlots: (assignmentId: string, slots: Array<{ day: string; hour: string }>, weeklyHours: number) => Promise<void>;
  sendNotification: (n: Omit<AppNotification, 'id' | 'createdAt' | 'readBy'>) => Promise<void>;
  loadNotifications: (userId: string, role: string) => Promise<void>;
  markNotificationRead: (notifId: string, userId: string) => Promise<void>;
  markAllNotificationsRead: (userId: string, role: string) => Promise<void>;
  updateMeetLink: (assignmentId: string, link: string) => Promise<void>;
  markPresentationSent: (assignmentId: string) => Promise<{ hoursElapsed: number; sentOnTime: boolean }>;
  logClassJoin: (teacherId: string, teacherName: string, studentName: string, scheduledDate: string, scheduledTime: string, subscriptionStatus?: string, enteredWithoutActive?: boolean, subscriptionDaysRemaining?: number | null) => Promise<void>;
  loadClassJoinLogs: () => Promise<void>;
  loadClassRecords: () => Promise<void>;
  loadFinanceData: () => Promise<void>;
  registerClassRecord: (teacherId: string, studentName: string, date: string, time: string | undefined, screenshotFile: File | null, classType?: ClassRecordType, comment?: string) => Promise<void>;
  attachScreenshotToClass: (teacherId: string, studentName: string, date: string, time: string | undefined, screenshotFile: File, comment?: string) => Promise<void>;
  markPaymentAsPaid: (teacherId: string, monthYear: string) => Promise<void>;
  approveReviewClass: (teacherId: string, studentName: string, date: string, approvedBy?: string) => Promise<void>;
  approveExceedLimitClass: (teacherId: string, studentName: string, date: string, approvedBy?: string) => Promise<void>;
  changeStudentTeacher: (params: ChangeTeacherParams) => Promise<void>;
  removeAssignment: (assignmentId: string, teacherId: string, studentName: string, slots: AssignedSlot[]) => Promise<void>;
  addRescheduleRecord: (p: { teacherId: string; teacherName: string; studentName: string; originalDate: string; originalTime?: string; newDate: string; newTime?: string; classType: 'reprogramada' | 'cancelacion_hora'; comment: string }) => Promise<void>;
  addRecoveryClass: (p: { teacherId: string; teacherName: string; studentName: string; recoveryDate: string; originalDate: string; note?: string; classTime?: string }) => Promise<void>;
}

const TeachersContext = createContext<TeachersContextType>({
  teachers: [], students: [], assignments: [], teacherGrids: {},
  loadingTeachers: true, scoringEvents: [], classCounts: [], notifications: [],
  unassignedStudents: [], classJoinLogs: [], classRecords: [],
  financeRates: [], financePayments: [], manualApprovals: [], lastUpdated: null,
  addTeacher:               async () => {},
  addStudent:               async () => {},
  deleteStudent:            async () => [],
  updateStudent:            async () => {},
  addAssignment:            async () => {},
  getTeacherGrid:           async () => ({}),
  updateTeacherGrid:        async () => {},
  updateTeacherRating:      async () => {},
  updateTeacherSpecialties: async () => {},
  updateTeacherInfo:        async () => {},
  updateTeacherEmailPreferences: async () => {},
  addScoringEvent:          async () => {},
  loadScoringEvents:        async () => {},
  checkAndRunResets:        async () => {},
  assignTeacherOfMonth:     async () => {},
  assignTeacherOfQuarter:   async () => {},
  forceMonthlyReset:        async () => {},
  forceQuarterlyReset:      async () => {},
  reloadAll:                  async () => {},
  loadClassCounts:            async () => {},
  incrementClassCount:        async () => ({ id: '', teacherId: '', studentName: '', classNumber: 0, lastUpdated: '' }),
  updateAssignmentAdjustment: async () => {},
  updateAssignmentStartDate:  async () => {},
  updateAssignmentSlots:      async () => {},
  sendNotification:           async () => {},
  loadNotifications:          async () => {},
  markNotificationRead:       async () => {},
  markAllNotificationsRead:   async () => {},
  updateMeetLink:             async () => {},
  markPresentationSent:       async () => ({ hoursElapsed: 0, sentOnTime: true }),
  logClassJoin:               async () => {},
  loadClassJoinLogs:          async () => {},
  loadClassRecords:           async () => {},
  loadFinanceData:            async () => {},
  registerClassRecord:        async () => {},
  attachScreenshotToClass:    async () => {},
  markPaymentAsPaid:          async () => {},
  approveReviewClass:         async () => {},
  approveExceedLimitClass:    async () => {},
  changeStudentTeacher:       async () => {},
  removeAssignment:           async () => {},
  addRescheduleRecord:        async () => {},
  addRecoveryClass:           async () => {},
});

export function TeachersProvider({ children }: { children: ReactNode }) {
  const [teachers, setTeachers]         = useState<Teacher[]>([]);
  const [students, setStudents]         = useState<Student[]>([]);
  const [assignments, setAssignments]   = useState<Assignment[]>([]);
  const [teacherGrids, setTeacherGrids] = useState<Record<string, Grid>>({});
  const [loadingTeachers, setLoadingTeachers] = useState(true);
  const [scoringEvents, setScoringEvents] = useState<ScoringEvent[]>([]);
  const [classCounts, setClassCounts]   = useState<ClassCount[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unassignedStudents, setUnassignedStudents] = useState<Student[]>([]);
  const [classJoinLogs, setClassJoinLogs] = useState<ClassJoinLog[]>([]);
  const [classRecords, setClassRecords] = useState<ClassRecord[]>([]);
  const [financeRates, setFinanceRates] = useState<FinanceRate[]>([]);
  const [financePayments, setFinancePayments] = useState<FinancePayment[]>([]);
  const [manualApprovals, setManualApprovals] = useState<FinanceManualApproval[]>([]);
  const [lastUpdated, setLastUpdated]   = useState<Date | null>(null);

  // Silent reload â€” no loading spinner, just swaps in fresh data.
  // students + assignments se traen JUNTOS (consistentes, con auto-correcciÃ³n de
  // student_id) y el estado se actualiza reciÃ©n cuando TODO estÃ¡ disponible.
  //
  // GUARDA ANTI-WIPE: las funciones db devuelven [] ante un error de red. Si un
  // refresh transitorio falla, NO debemos borrar lo que ya tenÃ­amos (eso causaba
  // que el profesor/horarios "desaparecieran" a los segundos). Por eso teachers,
  // students y assignments solo se reemplazan si el fetch trajo datos.
  async function reloadAll() {
    try {
      const [t, sa, ev, unassigned] = await Promise.all([
        dbGetTeachers(),
        dbGetAllStudentsWithAssignments(),
        dbGetScoringEvents(),
        dbGetUnassignedStudents(),
      ]);
      setTeachers(prev => t.length > 0 ? t : prev);
      setStudents(prev => sa.students.length > 0 ? sa.students : prev);
      setAssignments(prev => sa.assignments.length > 0 ? sa.assignments : prev);
      setScoringEvents(ev);
      setUnassignedStudents(unassigned);
      setTeacherGrids({});
      setLastUpdated(new Date());
    } catch (err) {
      // Nunca dejamos la UI en blanco por un error de refresh: se conserva el
      // Ãºltimo estado vÃ¡lido y se reintenta en el prÃ³ximo ciclo.
      console.error('[reloadAll] FallÃ³ el refresh, se conserva el estado anterior:', err);
    }
  }

  useEffect(() => {
    // Initial load â€” show the loading state only once
    setLoadingTeachers(true);
    reloadAll().finally(() => setLoadingTeachers(false));
    // Finance data (rates/payments/records/logs) â€” cargado una vez al iniciar.
    loadFinanceData();

    // Auto-refresh every 60 s, but skip if tab is hidden
    const interval = setInterval(() => {
      if (!document.hidden) reloadAll();
    }, 60_000);

    // Refresh immediately when the tab becomes visible again
    function handleVisibility() {
      if (!document.hidden) reloadAll();
    }
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addTeacher(t: Teacher, username: string) {
    await dbAddTeacher(t, username);
    setTeachers(prev => [...prev, t]);
  }

  async function addStudent(s: Student) {
    await dbUpsertStudent(s);
    setStudents(prev => {
      if (prev.some(x => x.email === s.email)) return prev;
      return [...prev, s];
    });
  }

  async function deleteStudent(studentId: string, studentName: string, createdBy?: string) {
    const affected = await dbDeleteStudent(studentId, studentName, createdBy);
    const [t, sa, unassigned] = await Promise.all([
      dbGetTeachers(),
      dbGetAllStudentsWithAssignments(),
      dbGetUnassignedStudents(),
    ]);
    setTeachers(t);
    setStudents(sa.students);
    setAssignments(sa.assignments);
    setUnassignedStudents(unassigned);
    setTeacherGrids({});
    return affected;
  }

  async function updateStudent(student: Student) {
    await dbUpdateStudent(student);
    setStudents(prev => prev.map(s => s.id === student.id ? student : s));
  }

  async function addAssignment(a: Assignment) {
    await dbAddAssignment(a);
    // Notify the teacher that received a new student (covers setter + teacher flows).
    // Los detalles van al email de aviso; la notificaciÃ³n in-app no los usa.
    await dbNotifyNewAssignment(a.teacherId, a.studentName, a.studentEmail, {
      plan: a.plan, level: a.studentLevel, slots: a.slots, startDate: a.startDate,
    });
    setAssignments(prev => [a, ...prev]);
    // The student now has an assignment â€” drop it from the unassigned list
    setUnassignedStudents(prev => prev.filter(s => s.id !== a.studentId && s.name !== a.studentName));
  }

  // force=true saltea el caché y trae el grid vivo de Supabase. Lo usa el setter
  // al abrir el formulario de asignación: si el profesor acaba de marcar celdas
  // como 'libre', esos slots deben aparecer sin esperar al reloadAll de 60 s.
  async function getTeacherGrid(teacherId: string, force = false): Promise<Grid> {
    if (!force && teacherGrids[teacherId]) return teacherGrids[teacherId];
    const grid = await dbGetTeacherGrid(teacherId);
    setTeacherGrids(prev => ({ ...prev, [teacherId]: grid }));
    return grid;
  }

  async function updateTeacherGrid(teacherId: string, grid: Grid) {
    setTeacherGrids(prev => ({ ...prev, [teacherId]: grid }));
    await dbSaveTeacherGrid(teacherId, grid);
  }

  async function updateTeacherRating(teacherId: string, rating: number) {
    await dbUpdateTeacherRating(teacherId, rating);
    setTeachers(prev => prev.map(t => t.id === teacherId ? { ...t, internalRating: rating } : t));
  }

  async function updateTeacherSpecialties(teacherId: string, specialties: string[]) {
    await dbUpdateTeacherSpecialties(teacherId, specialties);
    setTeachers(prev => prev.map(t => t.id === teacherId ? { ...t, specialties } : t));
  }

  async function updateTeacherInfo(teacherId: string, data: { name: string; email: string; specialties: string[]; notificationEmail?: string }) {
    const { notificationEmail, ...info } = data;
    await dbUpdateTeacherInfo(teacherId, info);
    if (notificationEmail !== undefined) {
      await dbUpdateTeacherNotificationEmail(teacherId, notificationEmail);
    }
    const normalizedNotif = notificationEmail?.trim() ? notificationEmail.trim() : undefined;
    setTeachers(prev => prev.map(t => t.id === teacherId ? { ...t, ...info, notificationEmail: normalizedNotif } : t));
  }

  async function updateTeacherEmailPreferences(teacherId: string, prefs: EmailPreferences) {
    await dbUpdateTeacherEmailPreferences(teacherId, prefs);
    setTeachers(prev => prev.map(t => t.id === teacherId ? { ...t, emailPreferences: prefs } : t));
  }

  async function sendNotification(n: Omit<AppNotification, 'id' | 'createdAt' | 'readBy'>) {
    await dbSendNotification(n);
  }

  async function loadNotifications(userId: string, role: string) {
    const data = await dbGetNotificationsForUser(userId, role);
    setNotifications(data);
  }

  async function markNotificationRead(notifId: string, userId: string) {
    await dbMarkNotificationRead(notifId, userId);
    setNotifications(prev => prev.map(n =>
      n.id === notifId && !n.readBy.includes(userId)
        ? { ...n, readBy: [...n.readBy, userId] }
        : n
    ));
  }

  async function markAllNotificationsRead(userId: string, role: string) {
    await dbMarkAllNotificationsRead(userId, role);
    setNotifications(prev => prev.map(n => ({
      ...n,
      readBy: n.readBy.includes(userId) ? n.readBy : [...n.readBy, userId],
    })));
  }

  async function addScoringEvent(event: Omit<ScoringEvent, 'id' | 'createdAt'>) {
    const newEvent = await dbAddScoringEvent(event);
    setScoringEvents(prev => [newEvent, ...prev]);
    const t = await dbGetTeachers();
    setTeachers(t);
  }

  async function loadScoringEvents() {
    const ev = await dbGetScoringEvents();
    setScoringEvents(ev);
  }

  async function checkAndRunResets() {
    const [monthly, quarterly] = await Promise.all([
      dbCheckAndResetMonthly(),
      dbCheckAndResetQuarterly(),
    ]);
    if (monthly.performed || quarterly.performed) {
      await reloadAll();
    }
  }

  async function assignTeacherOfMonth(teacherId: string, euros: number) {
    await dbAssignTeacherOfMonth(teacherId, euros);
    await reloadAll();
  }

  async function assignTeacherOfQuarter(teacherId: string, euros: number) {
    await dbAssignTeacherOfQuarter(teacherId, euros);
    await reloadAll();
  }

  async function forceMonthlyReset() {
    await dbForceMonthlyReset();
    await reloadAll();
  }

  async function forceQuarterlyReset() {
    await dbForceQuarterlyReset();
    await reloadAll();
  }

  async function loadClassCounts(teacherId: string) {
    const counts = await dbGetClassCounts(teacherId);
    setClassCounts(counts);
  }

  async function incrementClassCount(teacherId: string, studentName: string, studentEmail?: string): Promise<ClassCount> {
    const result = await dbIncrementClassCount(teacherId, studentName, studentEmail);
    setClassCounts(prev => {
      const idx = prev.findIndex(c => c.id === result.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = result;
        return next;
      }
      return [...prev, result];
    });
    return result;
  }

  async function updateAssignmentAdjustment(assignmentId: string, newAdjustment: number) {
    await dbUpdateAssignmentAdjustment(assignmentId, newAdjustment);
    setAssignments(prev => prev.map(a => a.id === assignmentId ? { ...a, manualClassAdjustment: newAdjustment } : a));
  }

  async function updateAssignmentStartDate(assignmentId: string, startDate: string) {
    await dbUpdateAssignmentStartDate(assignmentId, startDate);
    setAssignments(prev => prev.map(a => a.id === assignmentId ? { ...a, startDate } : a));
  }

  async function updateAssignmentSlots(
    assignmentId: string,
    slots: Array<{ day: string; hour: string }>,
    weeklyHours: number,
  ) {
    await dbUpdateAssignmentSlots(assignmentId, slots, weeklyHours);
    setAssignments(prev => prev.map(a => a.id === assignmentId ? { ...a, slots, weeklyHours } : a));
  }

  async function updateMeetLink(assignmentId: string, link: string) {
    await dbUpdateMeetLink(assignmentId, link);
    const trimmed = link.trim();
    setAssignments(prev => prev.map(a => a.id === assignmentId ? { ...a, meetLink: trimmed || undefined } : a));
  }

  // Marca el email de presentaciÃ³n como enviado (persiste vÃ­a API que ademÃ¡s
  // penaliza el scoring si pasaron mÃ¡s de 24 h) y refleja el estado localmente
  // para que los badges cambien a "enviado" sin recargar.
  async function markPresentationSent(assignmentId: string) {
    const res = await fetch(`/api/assignments/${assignmentId}/presentation-sent`, { method: 'PATCH' });
    if (!res.ok) throw new Error('No se pudo marcar el email de presentaciÃ³n como enviado');
    const data = await res.json().catch(() => ({} as { hoursElapsed?: number; sentOnTime?: boolean }));
    const nowIso = new Date().toISOString();
    setAssignments(prev => prev.map(a => a.id === assignmentId
      ? { ...a, presentationEmailSent: true, presentationEmailSentAt: a.presentationEmailSentAt ?? nowIso }
      : a));
    return { hoursElapsed: data.hoursElapsed ?? 0, sentOnTime: data.sentOnTime !== false };
  }

  async function logClassJoin(
    teacherId: string,
    teacherName: string,
    studentName: string,
    scheduledDate: string,
    scheduledTime: string,
    subscriptionStatus?: string,
    enteredWithoutActive?: boolean,
    subscriptionDaysRemaining?: number | null,
  ) {
    const log = await dbLogClassJoin(teacherId, teacherName, studentName, scheduledDate, scheduledTime, subscriptionStatus, enteredWithoutActive, subscriptionDaysRemaining);
    setClassJoinLogs(prev => [log, ...prev]);
  }

  async function loadClassJoinLogs() {
    const logs = await dbGetClassJoinLogs();
    setClassJoinLogs(logs);
  }

  async function loadClassRecords() {
    const records = await dbGetClassRecords();
    setClassRecords(records);
  }

  async function loadFinanceData() {
    const [rates, payments, records, logs, approvals] = await Promise.all([
      dbGetFinanceRates(),
      dbGetFinancePayments(),
      dbGetClassRecords(),
      dbGetClassJoinLogs(),
      dbGetManualApprovals(),
    ]);
    setFinanceRates(rates);
    setFinancePayments(payments);
    setClassRecords(records);
    setClassJoinLogs(logs);
    setManualApprovals(approvals);
  }

  async function registerClassRecord(
    teacherId: string, studentName: string, date: string, time: string | undefined,
    screenshotFile: File | null, classType: ClassRecordType = 'normal', comment?: string,
  ) {
    const teacherName = teachers.find(t => t.id === teacherId)?.name ?? '';
    // Estado de suscripciÃ³n al momento de registrar (no bloquea si falla).
    const email = students.find(s => s.name.trim().toLowerCase() === studentName.trim().toLowerCase())?.email;
    let subscriptionStatus = 'error';
    if (email) {
      // Fuente Ãºnica de verdad (cache compartido con Alumnos / PrÃ³ximas clases).
      subscriptionStatus = (await checkSubscription(email)).status;
    }
    // Las faltas/cancelaciones no llevan captura: se guarda screenshot_url vacÃ­o.
    const url = screenshotFile ? await dbUploadClassScreenshot(screenshotFile, teacherId) : '';
    const record = await dbAddClassRecord(teacherId, teacherName, studentName, date, time, url, classType, comment, subscriptionStatus);
    setClassRecords(prev => [record, ...prev]);
  }

  // Adjunta una captura a una clase puntual existente (o la crea para esa fecha).
  async function attachScreenshotToClass(
    teacherId: string, studentName: string, date: string, time: string | undefined, screenshotFile: File, comment?: string,
  ) {
    const teacherName = teachers.find(t => t.id === teacherId)?.name ?? '';
    const url = await dbUploadClassScreenshot(screenshotFile, teacherId);
    const record = await dbAttachScreenshotToClass(teacherId, teacherName, studentName, date, time, url, comment);
    setClassRecords(prev => {
      const filtered = prev.filter(r =>
        r.id !== record.id && !(r.teacherId === teacherId && r.studentName === studentName && r.classDate === date)
      );
      return [record, ...filtered];
    });
  }

  async function markPaymentAsPaid(teacherId: string, monthYear: string) {
    const teacherName = teachers.find(t => t.id === teacherId)?.name ?? '';
    const existing = financePayments.find(p => p.teacherId === teacherId && p.monthYear === monthYear) ?? null;
    const result = calculateTeacherFinance({
      teacherId, teacherName, monthYear,
      assignments, joinLogs: classJoinLogs, classRecords, rates: financeRates,
      scoringEvents, students, manualApprovals, payment: existing,
    });
    const saved = await dbMarkPaymentPaid(teacherId, teacherName, monthYear, {
      totalClassesPayable: result.totalPagable,
      totalAmount:         result.totalAPagar,
      bonusAmount:         result.bonusFromScoring,
    });
    setFinancePayments(prev => {
      const idx = prev.findIndex(p => p.id === saved.id);
      if (idx >= 0) { const next = [...prev]; next[idx] = saved; return next; }
      return [...prev, saved];
    });
  }

  // AprobaciÃ³n manual de una clase puntual: persiste en finance_manual_approvals
  // y actualiza el estado local para que el cÃ¡lculo se recompute al instante.
  async function approveClass(teacherId: string, studentName: string, date: string, reason: string, approvedBy?: string) {
    const approval = await dbAddManualApproval(teacherId, studentName, date, approvedBy || 'admin', reason);
    setManualApprovals(prev => {
      const dup = prev.some(m => m.teacherId === teacherId && m.studentName === studentName && m.classDate === date);
      return dup ? prev : [...prev, approval];
    });
  }

  async function approveReviewClass(teacherId: string, studentName: string, date: string, approvedBy?: string) {
    await approveClass(teacherId, studentName, date, 'a_revisar_aprobado', approvedBy);
  }

  async function approveExceedLimitClass(teacherId: string, studentName: string, date: string, approvedBy?: string) {
    await approveClass(teacherId, studentName, date, 'excede_limite_aprobado', approvedBy);
  }

  // Cambio de profesor (punto 1): delega en la BD y refresca todo el estado
  // (teachers/students/assignments/grids) para reflejar la transferencia.
  async function changeStudentTeacher(params: ChangeTeacherParams) {
    await dbChangeStudentTeacher(params);
    await reloadAll();
  }

  // Elimina una assignment y libera su grid (resoluciÃ³n de duplicados, punto 4).
  async function removeAssignment(assignmentId: string, teacherId: string, studentName: string, slots: AssignedSlot[]) {
    await dbRemoveAssignment(assignmentId, teacherId, studentName, slots);
    await reloadAll();
  }

  // Constancia de clase reprogramada (punto 2).
  async function addRescheduleRecord(p: { teacherId: string; teacherName: string; studentName: string; originalDate: string; originalTime?: string; newDate: string; newTime?: string; classType: 'reprogramada' | 'cancelacion_hora'; comment: string }) {
    const record = await dbAddRescheduleRecord(p);
    setClassRecords(prev => [record, ...prev]);
  }

  // Clase de recuperaciÃ³n vinculada al alumno (punto 3).
  async function addRecoveryClass(p: { teacherId: string; teacherName: string; studentName: string; recoveryDate: string; originalDate: string; note?: string; classTime?: string }) {
    const record = await dbAddRecoveryClass(p);
    setClassRecords(prev => [record, ...prev]);
  }

  return (
    <TeachersContext.Provider value={{
      teachers, students, assignments, teacherGrids, loadingTeachers,
      scoringEvents, classCounts, notifications, unassignedStudents, classJoinLogs,
      classRecords, financeRates, financePayments, manualApprovals, lastUpdated,
      addTeacher, addStudent, deleteStudent, updateStudent, addAssignment,
      getTeacherGrid, updateTeacherGrid, updateTeacherRating,
      updateTeacherSpecialties, updateTeacherInfo, updateTeacherEmailPreferences,
      addScoringEvent, loadScoringEvents, checkAndRunResets,
      assignTeacherOfMonth, assignTeacherOfQuarter,
      forceMonthlyReset, forceQuarterlyReset,
      reloadAll, loadClassCounts, incrementClassCount,
      updateAssignmentAdjustment, updateAssignmentStartDate, updateAssignmentSlots,
      sendNotification, loadNotifications, markNotificationRead, markAllNotificationsRead,
      updateMeetLink, markPresentationSent, logClassJoin, loadClassJoinLogs,
      loadClassRecords, loadFinanceData, registerClassRecord, attachScreenshotToClass,
      markPaymentAsPaid, approveReviewClass, approveExceedLimitClass,
      changeStudentTeacher, removeAssignment, addRescheduleRecord, addRecoveryClass,
    }}>
      {children}
    </TeachersContext.Provider>
  );
}

export function useTeachers() {
  return useContext(TeachersContext);
}
