// Ficha del alumno para el profesor que lo recibe en un cambio de profesor: el
// correo "Nuevo alumno asignado" (con Resend simulado) y la campanita, por la vía
// del LMS y por la del admin.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const enviados: Array<{ to: string; subject: string; html: string }> = [];
vi.mock('@/lib/resend', () => ({
  RESEND_PLACEHOLDER_KEY: 're_missing_api_key',
  hasResendKey: () => true,
  resend: { emails: { send: vi.fn(async (m: { to: string; subject: string; html: string }) => { enviados.push(m); return { data: { id: 're_1' }, error: null }; }) } },
}));

import { construirFicha, lineasFicha, textoCampanita, fichaRecibida, mencionaA, type DatosFicha } from '@/lib/fichaAlumnoNuevo';
import { newStudentFichaHtml, sendNewStudentEmail } from '@/lib/emailNotifications';
import { transferirAlumnoCore, type DatosEmailProfeNuevo } from '@/lib/transferencia/core';
import { cambiarProfesorCore } from '@/lib/cambioProfesor/core';
import { AHORA, dbFase2 } from '@/lib/cambioProfesor/fixtures.test-helper';
import type { FakeDb } from '@/lib/transferencia/fakeDb.test-helper';

const SLOTS = [{ day: 'Lunes', hour: '10:00' }, { day: 'Lunes', hour: '11:00' }, { day: 'Miércoles', hour: '18:00' }];
const BASE = 'https://gestion.test';

const COMPLETA: DatosFicha = {
  studentId: 's1', nombre: 'Lucía Pérez', email: 'lucia@x.com', nivelAlta: 'Inglés general', objetivo: 'Aprobar el B2 First en junio',
  plan: 'Ingles General - 3h semanales', slots: SLOTS, profesorAnterior: 'Berta Gómez', base: BASE,
  perfil: {
    teacher_confirmed_level: 'B1', level_test_cefr: 'A2', current_level: 'B2',
    occupation: 'Enfermera', personal_objective: 'Trabajar en Irlanda', strong_points: 'Comprensión lectora',
    weak_points: 'Fluidez al hablar', learning_style: 'Visual, con ejemplos', recommended_focus: 'Speaking con situaciones de hospital',
  },
  analisis: [
    { class_date: '2026-10-01', class_title: 'Past simple vs present perfect', analysis_status: 'ready' },
    { class_date: '2026-10-08', class_title: 'Vocabulario del hospital', analysis_status: 'ready' },
    { class_date: '2026-10-06', topics_covered: 'Phrasal verbs del trabajo', analysis_status: null },
    { class_date: '2026-10-09', class_title: 'Repaso con Berta de la entrevista', analysis_status: 'ready' },   // nombra a la anterior: fuera
    { class_date: '2026-10-10', class_title: 'Aún sin analizar', analysis_status: 'queued' },                 // no terminado: fuera
    { class_date: '2026-09-20', class_title: 'Presentaciones', analysis_status: 'ready' },                    // la 4.ª más reciente: fuera
    { class_date: '2026-10-07', class_title: '   ', analysis_status: 'ready' },                               // sin tema: fuera
  ],
};

const VACIA: DatosFicha = { studentId: 's1', nombre: 'Lucía Pérez', slots: SLOTS, base: BASE };

describe('construirFicha + lineasFicha', () => {
  it('con todos los datos: nivel con la regla única (profesor > prueba), perfil y las 3 últimas clases analizadas', () => {
    const f = construirFicha(COMPLETA);
    const l = lineasFicha(f);
    expect(l.datos).toEqual([
      ['Alumno', 'Lucía Pérez'],
      ['Nivel', 'B1 (confirmado por el profesor)'],
      ['Objetivo', 'Aprobar el B2 First en junio'],
      ['Plan', 'Ingles General - 3h semanales'],
      ['Horas semanales', '3 h'],
      ['Horarios', 'Lunes 10:00 - 12:00 · Miércoles 18:00 - 19:00'],
      ['Email de contacto', 'lucia@x.com'],
    ]);
    expect(l.perfil.map(([k]) => k)).toEqual(['Ocupación', 'Objetivo personal', 'Puntos fuertes', 'Puntos débiles', 'Estilo de aprendizaje', 'Foco recomendado']);
    expect(l.clases).toEqual([
      '8 de octubre de 2026: Vocabulario del hospital',
      '6 de octubre de 2026: Phrasal verbs del trabajo',
      '1 de octubre de 2026: Past simple vs present perfect',
    ]);
    expect(f.enlace).toBe(`${BASE}/mis-alumnos/s1`);
  });

  it('nivel: sin profesor manda la prueba; sin CEFR en ninguna fuente, la línea no sale', () => {
    expect(construirFicha({ ...VACIA, perfil: { level_test_cefr: 'A2', current_level: 'B2' } }).nivel).toBe('A2 (de la prueba de nivel)');
    expect(construirFicha({ ...VACIA, nivelAlta: 'B1 Exámenes' }).nivel).toBe('B1 (del curso contratado)');
    expect(construirFicha({ ...VACIA, nivelAlta: 'Inglés general' }).nivel).toBeNull();
  });

  it('sin datos: solo las líneas que hay, sin perfil ni clases y sin "N/A"', () => {
    const l = lineasFicha(construirFicha({ ...VACIA, perfil: { occupation: '  ', weak_points: null }, analisis: [] }));
    expect(l.datos).toEqual([
      ['Alumno', 'Lucía Pérez'],
      ['Horas semanales', '3 h'],
      ['Horarios', 'Lunes 10:00 - 12:00 · Miércoles 18:00 - 19:00'],
    ]);
    expect(l.perfil).toEqual([]);
    expect(l.clases).toEqual([]);
  });

  it('mencionaA: nombre completo o de pila como palabra, sin tildes; no dentro de otra palabra', () => {
    expect(mencionaA('Repaso con BERTA', 'Berta Gómez')).toBe(true);
    expect(mencionaA('Clase de Berta Gomez', 'Berta Gómez')).toBe(true);
    expect(mencionaA('Analysis of tenses', 'Ana López')).toBe(false);
    expect(mencionaA('Lo que dijo Ana', 'Ana López')).toBe(true);
    expect(mencionaA('Cualquier cosa', null)).toBe(false);
  });
});

describe('correo y campanita', () => {
  it('correo completo: tono neutro, enlace a la ficha, sin el profesor anterior', () => {
    const html = newStudentFichaHtml({ name: 'Carla' }, construirFicha(COMPLETA));
    expect(html).toContain('Hola Carla,');
    expect(html).toContain('Se incorpora a tus clases <strong>Lucía Pérez</strong>');
    for (const t of ['Su perfil', 'Enfermera', 'Speaking con situaciones de hospital', 'Sus últimas clases', 'Vocabulario del hospital', `${BASE}/mis-alumnos/s1`]) {
      expect(html).toContain(t);
    }
    expect(html).not.toMatch(/Berta|dej[oó]|anterior|cambi[oó] de profesor/i);
  });

  it('correo sin datos: ni secciones vacías ni "N/A", "null" o "undefined"', () => {
    const html = newStudentFichaHtml({ name: 'Carla' }, construirFicha(VACIA));
    expect(html).not.toMatch(/N\/A|undefined|null|Su perfil|Sus últimas clases|>Nivel<|>Objetivo<|>Plan<|Email de contacto/);
    expect(html).toContain('Lunes 10:00 - 12:00');
  });

  it('campanita: empieza por el alumno (el panel la enlaza con su asignación) y omite lo que falta', () => {
    expect(textoCampanita(construirFicha(COMPLETA))).toBe(
      'Se incorpora a tus clases Lucía Pérez (nivel B1 (confirmado por el profesor) · 3 h por semana · Lunes 10:00 - 12:00, Miércoles 18:00 - 19:00). '
      + 'Objetivo: Aprobar el B2 First en junio. Tienes su ficha en tu correo y en Alumnos. '
      + 'Recuerda presentarte por correo electrónico (lucia@x.com) antes de la primera clase.',
    );
    const vacia = textoCampanita(construirFicha({ ...VACIA, slots: [] }));
    expect(vacia).toBe('Se incorpora a tus clases Lucía Pérez. Tienes su ficha en tu correo y en Alumnos. Recuerda presentarte por correo electrónico antes de la primera clase.');
  });

  it('sendNewStudentEmail: con ficha, la variante de cambio; sin ella, el correo de un alta de siempre', async () => {
    enviados.length = 0;
    await sendNewStudentEmail({ name: 'Carla', email: 'carla@x.com' }, { studentName: 'Lucía Pérez', ficha: construirFicha(COMPLETA) });
    await sendNewStudentEmail({ name: 'Carla', email: 'carla@x.com' }, { studentName: 'Lucía Pérez', plan: 'Ingles General' });
    expect(enviados.map(e => e.subject)).toEqual(['Nuevo alumno asignado: Lucía Pérez', 'Nuevo alumno asignado: Lucía Pérez']);
    expect(enviados[0].html).toContain('Se incorpora a tus clases');
    expect(enviados[1].html).toContain('Se te ha asignado un nuevo alumno.');
  });

  it('fichaRecibida (/api/emails desde el navegador): solo los campos esperados y el enlace rehecho', () => {
    const f = fichaRecibida({ ...construirFicha(COMPLETA), enlace: 'https://malo.example/phishing', extra: '<script>' });
    expect(f?.enlace).toMatch(/\/mis-alumnos\/s1$/);
    expect(f?.enlace).not.toContain('malo.example');
    expect(f && 'extra' in f).toBe(false);
    expect(f?.ultimasClases).toHaveLength(3);
    expect(fichaRecibida({ nivel: 'B1' })).toBeNull();   // sin nombre no es una ficha
    expect(fichaRecibida('x')).toBeNull();
  });
});

describe('en el cambio de profesor (núcleo de transferencia)', () => {
  function conDatos(db: FakeDb) {
    db.rows('assignments')[0].objetivo = 'Aprobar el B2 First en junio';
    db.tables.student_profiles = [{ id: 'p1', student_id: 's1', student_name: 'Lucía Pérez', level_test_cefr: 'B1', occupation: 'Enfermera', weak_points: 'Fluidez' }];
    db.tables.class_analyses = [
      { id: 'c1', student_id: 's1', class_date: '2026-10-06', class_title: 'Vocabulario del hospital', analysis_status: 'ready' },
      { id: 'c2', student_id: 's1', class_date: '2026-10-08', class_title: 'Repaso con Berta', analysis_status: 'ready' },
    ];
  }
  const capturar = () => {
    const correos: DatosEmailProfeNuevo[] = [];
    return { correos, deps: { enviarEmailProfeNuevo: async (d: DatosEmailProfeNuevo) => { correos.push(d); return true; }, enviarBienvenidaAlumno: async () => {}, ahora: () => AHORA } };
  };

  beforeEach(() => { enviados.length = 0; });

  it('LMS: el correo lleva la ficha (horarios NUEVOS, perfil, clases sin la profesora anterior) y la campanita su resumen', async () => {
    const db = dbFase2(); conDatos(db);
    const { correos, deps } = capturar();
    await cambiarProfesorCore(db.client(), { studentId: 's1', destinos: [{ dia: 'Lunes', hora: '10:00', duracion: 2 }, { dia: 'Miércoles', hora: '18:00', duracion: 1 }] },
      tp => transferirAlumnoCore(db.client(), tp, deps), AHORA);
    expect(correos).toHaveLength(1);
    const f = correos[0].ficha;
    expect(f).toMatchObject({
      nombre: 'Lucía Pérez', nivel: 'B1 (de la prueba de nivel)', objetivo: 'Aprobar el B2 First en junio', horasSemanales: 3,
      horarios: ['Lunes 10:00 - 12:00', 'Miércoles 18:00 - 19:00'],
      perfil: { ocupacion: 'Enfermera', puntosDebiles: 'Fluidez', puntosFuertes: null },
      ultimasClases: [{ fecha: '6 de octubre de 2026', tema: 'Vocabulario del hospital' }],
    });
    expect(f.enlace).toMatch(/\/mis-alumnos\/s1$/);
    const aviso = db.rows('notifications').find(n => n.type === 'new_assignment' && n.target_user === 'tB');
    expect(String(aviso?.body)).toMatch(/^Se incorpora a tus clases Lucía Pérez \(nivel B1/);
    expect(String(aviso?.body)).not.toMatch(/Berta/);
  });

  it('admin (modal del panel): la misma ficha', async () => {
    const db = dbFase2(); conDatos(db);
    const { correos, deps } = capturar();
    await transferirAlumnoCore(db.client(), {
      assignmentId: 'asg1', toTeacherId: 'tE', slots: [{ day: 'Viernes', hour: '09:00' }, { day: 'Viernes', hour: '10:00' }],
      motivo: 'reorg', origen: 'admin', actor: 'Facundo',
    }, deps);
    expect(correos[0].ficha).toMatchObject({ nombre: 'Lucía Pérez', horarios: ['Viernes 09:00 - 11:00'], horasSemanales: 2, perfil: { ocupacion: 'Enfermera' } });
    expect(db.rows('notifications').some(n => n.type === 'new_assignment' && String(n.body).startsWith('Se incorpora a tus clases Lucía Pérez'))).toBe(true);
  });

  it('si no se puede leer el perfil ni las clases, la ficha sale igual con lo que hay', async () => {
    const db = dbFase2();
    db.hooks.failRead = t => (t === 'student_profiles' || t === 'class_analyses' ? { message: 'caído' } : null);
    const { correos, deps } = capturar();
    await transferirAlumnoCore(db.client(), {
      assignmentId: 'asg1', toTeacherId: 'tE', slots: [{ day: 'Viernes', hour: '09:00' }], motivo: 'reorg', origen: 'admin', actor: 'x',
    }, deps);
    expect(correos[0].ficha).toMatchObject({ nombre: 'Lucía Pérez', ultimasClases: [], perfil: { ocupacion: null } });
  });
});
