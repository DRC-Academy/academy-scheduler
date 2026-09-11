import { describe, it, expect } from 'vitest';
import {
  construirSeguimiento, etiquetaDe, filtroDe, pasaFiltro, resumenSeguimiento, buscaEn,
} from './levelTestSeguimiento';
import type { FormTokenRow, StudentRow, DropoutRow } from './formReminders';
import type { LevelTestInfo } from './levelTestClient';

const NOW = new Date('2026-09-11T12:00:00Z').getTime();
const hace = (dias: number, hora = '10:00:00') => new Date(NOW - dias * 86_400_000).toISOString().slice(0, 10) + `T${hora}Z`;

let n = 0;
const token = (o: Partial<FormTokenRow>): FormTokenRow => ({
  id: `ft${++n}`, token: `tok${n}`,
  student_id: 's1', student_name: 'Laura Villegas', student_email: 'laura@x.com',
  teacher_id: 'p1', teacher_name: 'Seba', assignment_id: null, plan: null, level: null,
  status: 'pending', created_at: hace(3), completed_at: null, expires_at: hace(-20),
  form_reminder_count: 0, form_reminder_last_sent: null,
  test_reminder_count: 0, test_reminder_last_sent: null, reminder_variant: null,
  ...o,
});
const sesion = (o: Partial<LevelTestInfo>): LevelTestInfo => ({
  id: `lt${++n}`, token: `t${n}`, status: 'pending', expires_at: hace(-5), completed_at: null,
  student_id: 's1', student_name: 'Laura Villegas', candidate_name: 'Laura Villegas',
  candidate_email: 'laura@x.com', cefr_level: null, overall_score: null, created_at: hace(2),
  ...o,
});
const alumnos: StudentRow[] = [
  { id: 's1', name: 'Laura Villegas', email: 'laura@x.com' },
  { id: 's2', name: 'Jorge Vidal', email: 'jorge@x.com' },
];
const nadie: DropoutRow[] = [];

const armar = (tokens: FormTokenRow[], sessions: LevelTestInfo[] = [], dropouts = nadie, students = alumnos) =>
  construirSeguimiento({ tokens, sessions, students, dropouts, now: NOW });

describe('construirSeguimiento · tonos', () => {
  it('enlace enviado hoy sin nada más → gris "Enviado hoy"', () => {
    const [e] = armar([token({ created_at: hace(0) })]);
    expect(e.tono).toBe('gris');
    expect(etiquetaDe(e)).toBe('Enviado hoy');
    expect(e.formulario).toBeNull();
    expect(e.recordable).toBe(true);
  });

  it('formulario hecho hace 3 días, sin prueba → ámbar "Falta la prueba"', () => {
    const [e] = armar([token({ status: 'completed', created_at: hace(5), completed_at: hace(3) })]);
    expect(e.tono).toBe('ambar');
    expect(etiquetaDe(e)).toBe('Falta la prueba');
    expect(e.formulario).toBe(hace(3));
    expect(e.dias).toBe(3);
  });

  it('sin formulario desde hace 14 días → rojo "Parado 14 d"', () => {
    const [e] = armar([token({ created_at: hace(14), form_reminder_count: 3 })]);
    expect(e.tono).toBe('rojo');
    expect(etiquetaDe(e)).toBe('Parado 14 d');
    expect(filtroDe(e.tono)).toBe('parados');
  });

  it('prueba completada → ok, con las tres fechas y el nivel', () => {
    const [e] = armar(
      [token({ status: 'completed', created_at: hace(7), completed_at: hace(6) })],
      [sesion({ status: 'completed', completed_at: hace(1), cefr_level: 'B2', overall_score: 68, created_at: hace(6) })],
    );
    expect(e.tono).toBe('ok');
    expect(e.enviado).toBe(hace(7));
    expect(e.formulario).toBe(hace(6));
    expect(e.prueba).toBe(hace(1));
    expect(e.cefr).toBe('B2');
    expect(e.recordable).toBe(false);
  });

  it('la prueba completada manda aunque la última sesión esté a medias', () => {
    const [e] = armar(
      [token({ status: 'completed', completed_at: hace(6) })],
      [
        sesion({ status: 'in_progress', created_at: hace(1) }),
        sesion({ status: 'completed', completed_at: hace(4), cefr_level: 'A2', created_at: hace(5) }),
      ],
    );
    expect(e.tono).toBe('ok');
    expect(e.cefr).toBe('A2');
  });

  it('enlace caducado sin abrir → caducado, dentro de "Parados" y sin Recordar', () => {
    const [e] = armar([token({ created_at: hace(40), expires_at: hace(10) })]);
    expect(e.tono).toBe('caducado');
    expect(filtroDe(e.tono)).toBe('parados');
    expect(e.recordable).toBe(false);
  });

  it('alumno de baja → "Baja", solo en Todos', () => {
    const [e] = armar([token({ created_at: hace(20) })], [], [{ student_id: 's1', student_name: 'Laura Villegas' }]);
    expect(e.tono).toBe('baja');
    expect(pasaFiltro(e, 'parados')).toBe(false);
    expect(pasaFiltro(e, 'todos')).toBe(true);
  });

  it('alumno borrado (ya no está en students) → baja', () => {
    const [e] = armar([token({ student_id: 's9', student_name: 'Nadie', created_at: hace(20) })]);
    expect(e.tono).toBe('baja');
  });
});

describe('construirSeguimiento · agrupación', () => {
  it('solo cuenta el último token de cada alumno', () => {
    const filas = armar([
      token({ created_at: hace(30), expires_at: hace(1) }),
      token({ created_at: hace(2) }),
    ]);
    expect(filas).toHaveLength(1);
    expect(filas[0].enviado).toBe(hace(2));
    expect(filas[0].tono).toBe('ambar');
  });

  it('casa la sesión con el token por email cuando no hay student_id', () => {
    const [e] = armar(
      [token({ student_id: null, student_name: 'Laura Villegas' })],
      [sesion({ student_id: null, student_name: null, candidate_name: 'L. Villegas', candidate_email: 'LAURA@x.com', status: 'completed', completed_at: hace(1), cefr_level: 'B1' })],
    );
    expect(e.tono).toBe('ok');
    expect(e.cefr).toBe('B1');
  });

  it('un candidato con prueba manual y sin formulario es una fila propia', () => {
    const filas = armar(
      [token({})],
      [sesion({ student_id: null, student_name: null, candidate_name: 'Pepe Prospecto', candidate_email: 'pepe@x.com', created_at: hace(9) })],
    );
    expect(filas).toHaveLength(2);
    const pepe = filas.find(f => f.nombre === 'Pepe Prospecto')!;
    expect(pepe.token).toBeNull();
    expect(pepe.formulario).toBeNull();
    expect(pepe.tono).toBe('rojo');
    expect(pepe.recordable).toBe(false);
  });

  it('ordena de la más reciente a la más antigua por la fecha del enlace', () => {
    const filas = armar([
      token({ student_id: 's1', student_name: 'Laura Villegas', created_at: hace(10) }),
      token({ student_id: 's2', student_name: 'Jorge Vidal', student_email: 'jorge@x.com', created_at: hace(1) }),
    ]);
    expect(filas.map(f => f.nombre)).toEqual(['Jorge Vidal', 'Laura Villegas']);
  });
});

describe('cifras y búsqueda', () => {
  it('resumen: solo los enlaces de los últimos 30 días, parados de siempre', () => {
    const filas = armar([
      token({ student_id: 's1', student_name: 'Laura Villegas', created_at: hace(60), expires_at: hace(20) }),  // caducado
      token({ student_id: 's2', student_name: 'Jorge Vidal', student_email: 'jorge@x.com', status: 'completed', created_at: hace(5), completed_at: hace(4) }),
    ]);
    const r = resumenSeguimiento(filas, NOW);
    expect(r).toEqual({ enviadas30: 1, formulario30: 1, prueba30: 0, parados: 1 });
  });

  it('busca por nombre o email, sin distinguir mayúsculas', () => {
    const [e] = armar([token({})]);
    expect(buscaEn(e, 'VILLE')).toBe(true);
    expect(buscaEn(e, 'laura@')).toBe(true);
    expect(buscaEn(e, 'jorge')).toBe(false);
  });
});
