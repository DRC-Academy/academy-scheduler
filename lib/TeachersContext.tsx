'use client';
import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Teacher, Student, Assignment, Grid } from '@/types';
import {
  dbGetTeachers, dbAddTeacher,
  dbGetStudents, dbUpsertStudent, dbDeleteStudent, dbUpdateStudent,
  dbGetAssignments, dbAddAssignment,
  dbGetTeacherGrid, dbSaveTeacherGrid,
} from '@/lib/db';

interface TeachersContextType {
  teachers: Teacher[];
  students: Student[];
  assignments: Assignment[];
  teacherGrids: Record<string, Grid>;
  loadingTeachers: boolean;
  addTeacher: (t: Teacher, username: string) => Promise<void>;
  addStudent: (s: Student) => Promise<void>;
  deleteStudent: (studentId: string, studentName: string) => Promise<void>;
  updateStudent: (student: Student) => Promise<void>;
  addAssignment: (a: Assignment) => Promise<void>;
  getTeacherGrid: (teacherId: string) => Promise<Grid>;
  updateTeacherGrid: (teacherId: string, grid: Grid) => Promise<void>;
}

const TeachersContext = createContext<TeachersContextType>({
  teachers: [], students: [], assignments: [], teacherGrids: {},
  loadingTeachers: true,
  addTeacher: async () => {},
  addStudent: async () => {},
  deleteStudent: async () => {},
  updateStudent: async () => {},
  addAssignment: async () => {},
  getTeacherGrid: async () => ({}),
  updateTeacherGrid: async () => {},
});

export function TeachersProvider({ children }: { children: ReactNode }) {
  const [teachers, setTeachers]         = useState<Teacher[]>([]);
  const [students, setStudents]         = useState<Student[]>([]);
  const [assignments, setAssignments]   = useState<Assignment[]>([]);
  const [teacherGrids, setTeacherGrids] = useState<Record<string, Grid>>({});
  const [loadingTeachers, setLoadingTeachers] = useState(true);

  // Load everything on mount
  useEffect(() => {
    async function load() {
      setLoadingTeachers(true);
      const [t, s, a] = await Promise.all([
        dbGetTeachers(),
        dbGetStudents(),
        dbGetAssignments(),
      ]);
      setTeachers(t);
      setStudents(s);
      setAssignments(a);
      setLoadingTeachers(false);
    }
    load();
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
    setStudents(prev => prev.filter(s => s.id !== studentId));
    setAssignments(prev => prev.filter(a => a.studentId !== studentId && a.studentName !== studentName));
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

  return (
    <TeachersContext.Provider value={{
      teachers, students, assignments, teacherGrids, loadingTeachers,
      addTeacher, addStudent, deleteStudent, updateStudent, addAssignment, getTeacherGrid, updateTeacherGrid,
    }}>
      {children}
    </TeachersContext.Provider>
  );
}

export function useTeachers() {
  return useContext(TeachersContext);
}
