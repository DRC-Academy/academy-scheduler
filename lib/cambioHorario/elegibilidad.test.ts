import { describe, it, expect } from 'vitest';
import {
  esPlanOritalk, esPlanEmpresa, compartenCasillaConOtroAlumno, esPlanDosAlumnos, evaluarElegibilidad,
  type AlumnoElegibilidad, type AsignacionElegibilidad,
} from '@/lib/cambioHorario/elegibilidad';
import { sesionesDelAlumno } from '@/lib/cambioHorario/sesiones';

const alumno = (over: Partial<AlumnoElegibilidad> = {}): AlumnoElegibilidad =>
  ({ id: 's1', name: 'Ana', email: 'ana@x.com', product_name: 'Ingles General - 1h semanal', company_plan_months: null, is_oritalk: false, ...over });
const asg = (over: Partial<AsignacionElegibilidad> = {}): AsignacionElegibilidad =>
  ({ id: 'a1', teacher_id: 't9', teacher_name: 'Berta', student_id: 's1', student_name: 'Ana', student_email: 'ana@x.com',
    status: 'active', slots: [{ day: 'Lunes', hour: '20:00' }], ...over });

describe('criterios de exclusión (uno por función)', () => {
  it('Oritalk: is_oritalk = true', () => {
    expect(esPlanOritalk({ is_oritalk: true })).toBe(true);
    expect(esPlanOritalk({ is_oritalk: false })).toBe(false);
    expect(esPlanOritalk({ is_oritalk: null })).toBe(false);
  });

  it('Empresa: company_plan_months no nulo o product_name con "Empresa" (sin mayúsculas)', () => {
    expect(esPlanEmpresa({ company_plan_months: 3, product_name: null })).toBe(true);
    expect(esPlanEmpresa({ company_plan_months: null, product_name: 'Empresas Intensivos — 5h semanales' })).toBe(true);
    expect(esPlanEmpresa({ company_plan_months: null, product_name: 'curso EMPRESA b2' })).toBe(true);
    expect(esPlanEmpresa({ company_plan_months: null, product_name: 'Ingles General - 2h' })).toBe(false);
    expect(esPlanEmpresa({ company_plan_months: null, product_name: null })).toBe(false);
  });

  it('Dos alumnos, principal: otra assignment activa del mismo profesor comparte una casilla', () => {
    const otra = asg({ id: 'a2', student_id: 's2', student_name: 'Iván' });
    expect(compartenCasillaConOtroAlumno(asg(), [otra])).toBe(true);
    expect(compartenCasillaConOtroAlumno(asg(), [{ ...otra, slots: [{ day: 'Lunes', hour: '21:00' }] }])).toBe(false);
    expect(compartenCasillaConOtroAlumno(asg(), [{ ...otra, teacher_id: 'otro' }])).toBe(false);
    expect(compartenCasillaConOtroAlumno(asg(), [{ ...otra, status: 'inactive' }])).toBe(false);
    expect(compartenCasillaConOtroAlumno(asg(), [asg()])).toBe(false); // ella misma no cuenta
  });

  it('Dos alumnos, refuerzo: product_name con "dos alumnos" (sin mayúsculas)', () => {
    expect(esPlanDosAlumnos({ product_name: 'Ingles general DOS ALUMNOS - 1h semanal' }, asg(), [])).toBe(true);
    expect(esPlanDosAlumnos({ product_name: 'Ingles General - 1h semanal' }, asg(), [])).toBe(false);
  });
});

describe('evaluarElegibilidad', () => {
  const ev = (a: AlumnoElegibilidad, suyas: AsignacionElegibilidad[], delProfe: AsignacionElegibilidad[] = suyas) =>
    evaluarElegibilidad({ alumno: a, activasDelAlumno: suyas, activasDelProfe: delProfe });
  const detalle = (r: ReturnType<typeof ev>) => (r.elegible ? 'ELEGIBLE' : r.detalle);

  it('exactamente una assignment activa', () => {
    expect(detalle(ev(alumno(), []))).toBe('SIN_ASIGNACION_ACTIVA');
    expect(detalle(ev(alumno(), [asg(), asg({ id: 'a2', teacher_id: 't8' })]))).toBe('VARIAS_ASIGNACIONES');
    expect(detalle(ev(alumno(), [asg({ status: 'inactive' })]))).toBe('SIN_ASIGNACION_ACTIVA');
  });

  it('cada exclusión con su código', () => {
    expect(detalle(ev(alumno({ is_oritalk: true }), [asg()]))).toBe('ORITALK');
    expect(detalle(ev(alumno({ company_plan_months: 6 }), [asg()]))).toBe('EMPRESA');
    expect(detalle(ev(alumno(), [asg()], [asg(), asg({ id: 'a2', student_id: 's2', student_name: 'Iván' })]))).toBe('PLAN_DOS_ALUMNOS');
  });

  it('sin product_name (plan desconocido) es elegible: solo se excluye con un dato que lo confirme', () => {
    expect(detalle(ev(alumno({ product_name: null }), [asg()]))).toBe('ELEGIBLE');
  });
});

describe('sesionesDelAlumno', () => {
  it('bloques contiguos por nombre EXACTO del alumno recurrente', () => {
    const r = sesionesDelAlumno({
      'Martes_15:00': { state: 'ocupado', student: ' Ana López ' },
      'Martes_16:00': { state: 'ocupado', student: 'Ana López' },
      'Martes_18:00': { state: 'ocupado', student: 'Ana López' },
      'Jueves_10:00': { state: 'bloqueado', student: 'X', weekDate: '2026-10-12', baseState: 'ocupado', baseStudent: 'Ana López' },
      'Jueves_11:00': { state: 'ocupado', student: 'Ana' },        // no es su nombre exacto
      'Viernes_09:00': { state: 'ocupado', student: 'Ana López' },
    }, 'Ana López');
    expect(r.map(s => `${s.dia} ${s.hora} ${s.duracion}h`)).toEqual(['Martes 15:00 2h', 'Martes 18:00 1h', 'Jueves 10:00 1h', 'Viernes 09:00 1h']);
  });
});
