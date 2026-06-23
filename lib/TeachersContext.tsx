'use client';
import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Teacher, Student, Assignment, Grid, ScoringEvent, ClassCount } from '@/types';
import {
  dbGetTeachers, dbAddTeacher,
  dbGetStudents, dbUpsertStudent, dbDeleteStudent, dbUpdateStudent,
  dbGetAssignments, dbAddAssignment,
  dbGetTeacherGrid, dbSaveTeacherGrid, dbUpdateTeacherRating,
  dbAddScoringEvent, dbGetScoringEvents,
  dbAssignTeacherOfMonth, dbAssignTeacherOfQuarter,
  dbCheckAndResetMonthly, dbCheckAndResetQuarterly,
  dbForceMonthlyReset, dbForceQuarterlyReset,
  dbGetClassCounts, dbIncrementClassCount,
  dbUpdateAssignmentAdjustment, dbUpdateAssignmentStartDate,
} from '@/lib/db';

interface TeachersContextType {
  teachers: Teacher[];
  students: Student[];
  assignments: Assignment[];
  teacherGrids: Record<string, Grid>;
  loadingTeachers: boolean;
  scoringEvents: ScoringEvent[];
  classCounts: ClassCount[];
  addTeacher: (t: Teacher, username: string) => Promise<void>;
  addStudent: (s: Student) => Promise<void>;
  deleteStudent: (studentId: string, studentName: string) => Promise<void>;
  updateStudent: (student: Student) => Promise<void>;
  addAssignment: (a: Assignment) => Promise<void>;
  getTeacherGrid: (teacherId: string) => Promise<Grid>;
  updateTeacherGrid: (teacherId: string, grid: Grid) => Promise<void>;
  updateTeacherRating: (teacherId: string, rating: number) => Promise<void>;
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
}

const TeachersContext = createContext<TeachersContextType>({
  teachers: [], students: [], assignments: [], teacherGrids: {},
  loadingTeachers: true, scoringEvents: [], classCounts: [],
  addTeacher:           async () => {},
  addStudent:           async () => {},
  deleteStudent:        async () => {},
  updateStudent:        async () => {},
  addAssignment:        async () => {},
  getTeacherGrid:       async () => ({}),
  updateTeacherGrid:    async () => {},
  updateTeacherRating:  async () => {},
  addScoringEvent:      async () => {},
  loadScoringEvents:    async () => {},
  checkAndRunResets:    async () => {},
  assignTeacherOfMonth: async () => {},
  assignTeacherOfQuarter: async () => {},
  forceMonthlyReset:    async () => {},
  forceQuarterlyReset:  async () => {},
  reloadAll:                  async () => {},
  loadClassCounts:            async () => {},
  incrementClassCount:        async () => ({ id: '', teacherId: '', studentName: '', classNumber: 0, lastUpdated: '' }),
  updateAssignmentAdjustment: async () => {},
  updateAssignmentStartDate:  async () => {},
});

export function TeachersProvider({ children }: { children: ReactNode }) {
  const [teachers, setTeachers]         = useState<Teacher[]>([]);
  const [students, setStudents]         = useState<Student[]>([]);
  const [assignments, setAssignments]   = useState<Assignment[]>([]);
  const [teacherGrids, setTeacherGrids] = useState<Record<string, Grid>>({});
  const [loadingTeachers, setLoadingTeachers] = useState(true);
  const [scoringEvents, setScoringEvents] = useState<ScoringEvent[]>([]);
  const [classCounts, setClassCounts]   = useState<ClassCount[]>([]);

  async function reloadAll() {
    setLoadingTeachers(true);
    const [t, s, a, ev] = await Promise.all([
      dbGetTeachers(),
      dbGetStudents(),
      dbGetAssignments(),
      dbGetScoringEvents(),
    ]);
    setTeachers(t);
    setStudents(s);
    setAssignments(a);
    setScoringEvents(ev);
    setTeacherGrids({});
    setLoadingTeachers(false);
  }

  useEffect(() => {
    reloadAll();
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

  async function deleteStudent(studentId: string, studentName: string) {
    await dbDeleteStudent(studentId, studentName);
    const [t, s, a] = await Promise.all([
      dbGetTeachers(),
      dbGetStudents(),
      dbGetAssignments(),
    ]);
    setTeachers(t);
    setStudents(s);
    setAssignments(a);
    setTeacherGrids({});
  }

  async function updateStudent(student: Student) {
    await dbUpdateStudent(student);
    setStudents(prev => prev.map(s => s.id === student.id ? student : s));
  }

  async function addAssignment(a: Assignment) {
    await dbAddAssignment(a);
    setAssignments(prev => [a, ...prev]);
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

  async function addScoringEvent(event: Omit<ScoringEvent, 'id' | 'createdAt'>) {
    const newEvent = await dbAddScoringEvent(event);
    setScoringEvents(prev => [newEvent, ...prev]);
    // Reload teachers to reflect updated scores/blocked status
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

  return (
    <TeachersContext.Provider value={{
      teachers, students, assignments, teacherGrids, loadingTeachers, scoringEvents, classCounts,
      addTeacher, addStudent, deleteStudent, updateStudent, addAssignment,
      getTeacherGrid, updateTeacherGrid, updateTeacherRating, addScoringEvent,
      loadScoringEvents, checkAndRunResets,
      assignTeacherOfMonth, assignTeacherOfQuarter,
      forceMonthlyReset, forceQuarterlyReset,
      reloadAll, loadClassCounts, incrementClassCount,
      updateAssignmentAdjustment, updateAssignmentStartDate,
    }}>
      {children}
    </TeachersContext.Provider>
  );
}

export function useTeachers() {
  return useContext(TeachersContext);
}
