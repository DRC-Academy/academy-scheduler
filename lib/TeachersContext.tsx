'use client';
import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Teacher, Student, Assignment, Grid, ScoringEvent, ClassCount, AppNotification, ClassJoinLog, ClassRecord, FinanceRate, FinancePayment } from '@/types';
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
  dbUpdateTeacherSpecialties, dbUpdateTeacherInfo, dbUpdateTeacherNotificationEmail,
  dbSendNotification, dbGetNotificationsForUser, dbMarkNotificationRead, dbMarkAllNotificationsRead,
  dbUpdateMeetLink, dbLogClassJoin, dbGetClassJoinLogs, dbGetUnassignedStudents,
  dbNotifyNewAssignment,
  dbGetClassRecords, dbUploadClassScreenshot, dbAddClassRecord, dbAttachScreenshotToClass,
  dbGetFinanceRates, dbGetFinancePayments, dbSetFinanceOverrides, dbMarkPaymentPaid,
} from '@/lib/db';
import type { AffectedTeacher } from '@/lib/db';
import { calculateTeacherFinance } from '@/lib/finance';

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
  lastUpdated: Date | null;
  addTeacher: (t: Teacher, username: string) => Promise<void>;
  addStudent: (s: Student) => Promise<void>;
  deleteStudent: (studentId: string, studentName: string, createdBy?: string) => Promise<AffectedTeacher[]>;
  updateStudent: (student: Student) => Promise<void>;
  addAssignment: (a: Assignment) => Promise<void>;
  getTeacherGrid: (teacherId: string) => Promise<Grid>;
  updateTeacherGrid: (teacherId: string, grid: Grid) => Promise<void>;
  updateTeacherRating: (teacherId: string, rating: number) => Promise<void>;
  updateTeacherSpecialties: (teacherId: string, specialties: string[]) => Promise<void>;
  updateTeacherInfo: (teacherId: string, data: { name: string; email: string; specialties: string[]; notificationEmail?: string }) => Promise<void>;
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
  logClassJoin: (teacherId: string, teacherName: string, studentName: string, scheduledDate: string, scheduledTime: string, subscriptionStatus?: string, enteredWithoutActive?: boolean, subscriptionDaysRemaining?: number | null) => Promise<void>;
  loadClassJoinLogs: () => Promise<void>;
  loadClassRecords: () => Promise<void>;
  loadFinanceData: () => Promise<void>;
  registerClassRecord: (teacherId: string, studentName: string, date: string, time: string | undefined, screenshotFile: File) => Promise<void>;
  attachScreenshotToClass: (teacherId: string, studentName: string, date: string, time: string | undefined, screenshotFile: File, comment?: string) => Promise<void>;
  markPaymentAsPaid: (teacherId: string, monthYear: string) => Promise<void>;
  approveReviewClass: (teacherId: string, studentName: string, date: string) => Promise<void>;
  approveExceedLimitClass: (teacherId: string, studentName: string, date: string) => Promise<void>;
}

const TeachersContext = createContext<TeachersContextType>({
  teachers: [], students: [], assignments: [], teacherGrids: {},
  loadingTeachers: true, scoringEvents: [], classCounts: [], notifications: [],
  unassignedStudents: [], classJoinLogs: [], classRecords: [],
  financeRates: [], financePayments: [], lastUpdated: null,
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
  logClassJoin:               async () => {},
  loadClassJoinLogs:          async () => {},
  loadClassRecords:           async () => {},
  loadFinanceData:            async () => {},
  registerClassRecord:        async () => {},
  attachScreenshotToClass:    async () => {},
  markPaymentAsPaid:          async () => {},
  approveReviewClass:         async () => {},
  approveExceedLimitClass:    async () => {},
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
  const [lastUpdated, setLastUpdated]   = useState<Date | null>(null);

  // Silent reload — no loading spinner, just swaps in fresh data.
  // students + assignments se traen JUNTOS (consistentes, con auto-corrección de
  // student_id) y el estado se actualiza recién cuando TODO está disponible, para
  // evitar el race condition que dejaba la UI sin profesor/horarios.
  async function reloadAll() {
    const [t, sa, ev, unassigned] = await Promise.all([
      dbGetTeachers(),
      dbGetAllStudentsWithAssignments(),
      dbGetScoringEvents(),
      dbGetUnassignedStudents(),
    ]);
    setTeachers(t);
    setStudents(sa.students);
    setAssignments(sa.assignments);
    setScoringEvents(ev);
    setUnassignedStudents(unassigned);
    setTeacherGrids({});
    setLastUpdated(new Date());
  }

  useEffect(() => {
    // Initial load — show the loading state only once
    setLoadingTeachers(true);
    reloadAll().finally(() => setLoadingTeachers(false));
    // Finance data (rates/payments/records/logs) — cargado una vez al iniciar.
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
    // Notify the teacher that received a new student (covers setter + teacher flows)
    await dbNotifyNewAssignment(a.teacherId, a.studentName, a.studentEmail);
    setAssignments(prev => [a, ...prev]);
    // The student now has an assignment — drop it from the unassigned list
    setUnassignedStudents(prev => prev.filter(s => s.id !== a.studentId && s.name !== a.studentName));
  }

  async function getTeacherGrid(teacherId: string): Promise<Grid> {
    if (teacherGrids[teacherId]) return teacherGrids[teacherId];
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
    const [rates, payments, records, logs] = await Promise.all([
      dbGetFinanceRates(),
      dbGetFinancePayments(),
      dbGetClassRecords(),
      dbGetClassJoinLogs(),
    ]);
    setFinanceRates(rates);
    setFinancePayments(payments);
    setClassRecords(records);
    setClassJoinLogs(logs);
  }

  async function registerClassRecord(
    teacherId: string, studentName: string, date: string, time: string | undefined, screenshotFile: File,
  ) {
    const teacherName = teachers.find(t => t.id === teacherId)?.name ?? '';
    const url = await dbUploadClassScreenshot(screenshotFile, teacherId);
    const record = await dbAddClassRecord(teacherId, teacherName, studentName, date, time, url);
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
      scoringEvents, payment: existing,
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

  async function addOverride(teacherId: string, studentName: string, date: string) {
    const teacherName = teachers.find(t => t.id === teacherId)?.name ?? '';
    const monthYear = date.slice(0, 7);
    const existing = financePayments.find(p => p.teacherId === teacherId && p.monthYear === monthYear);
    const key = `${studentName}__${date}`;
    const overrides = Array.from(new Set([...(existing?.approvedOverrides ?? []), key]));
    const saved = await dbSetFinanceOverrides(teacherId, teacherName, monthYear, overrides);
    setFinancePayments(prev => {
      const idx = prev.findIndex(p => p.id === saved.id);
      if (idx >= 0) { const next = [...prev]; next[idx] = saved; return next; }
      return [...prev, saved];
    });
  }

  async function approveReviewClass(teacherId: string, studentName: string, date: string) {
    await addOverride(teacherId, studentName, date);
  }

  async function approveExceedLimitClass(teacherId: string, studentName: string, date: string) {
    await addOverride(teacherId, studentName, date);
  }

  return (
    <TeachersContext.Provider value={{
      teachers, students, assignments, teacherGrids, loadingTeachers,
      scoringEvents, classCounts, notifications, unassignedStudents, classJoinLogs,
      classRecords, financeRates, financePayments, lastUpdated,
      addTeacher, addStudent, deleteStudent, updateStudent, addAssignment,
      getTeacherGrid, updateTeacherGrid, updateTeacherRating,
      updateTeacherSpecialties, updateTeacherInfo,
      addScoringEvent, loadScoringEvents, checkAndRunResets,
      assignTeacherOfMonth, assignTeacherOfQuarter,
      forceMonthlyReset, forceQuarterlyReset,
      reloadAll, loadClassCounts, incrementClassCount,
      updateAssignmentAdjustment, updateAssignmentStartDate, updateAssignmentSlots,
      sendNotification, loadNotifications, markNotificationRead, markAllNotificationsRead,
      updateMeetLink, logClassJoin, loadClassJoinLogs,
      loadClassRecords, loadFinanceData, registerClassRecord, attachScreenshotToClass,
      markPaymentAsPaid, approveReviewClass, approveExceedLimitClass,
    }}>
      {children}
    </TeachersContext.Provider>
  );
}

export function useTeachers() {
  return useContext(TeachersContext);
}
