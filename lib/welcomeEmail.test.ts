import { describe, expect, it } from 'vitest';
import {
  WELCOME_EMAIL_START_DATE, firstClassFromSlots, isInWelcomeWindow, pickWelcomeVariant,
} from './welcomeEmail';
import { buildWelcomeEmail } from './welcomeEmailCopy';

const H = 3_600_000;

describe('isInWelcomeWindow — nadie anterior al corte, nadie con más de 72 h', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');

  it('una asignación de hace una hora entra', () => {
    expect(isInWelcomeWindow(new Date(now - H).toISOString(), now)).toBe(true);
  });

  it('una asignación de ayer por la noche en Madrid, anterior al corte, no entra', () => {
    // 24/09 23:30 en Madrid (CEST) = 24/09 21:30 UTC
    expect(isInWelcomeWindow('2026-09-24T21:30:00Z', now)).toBe(false);
  });

  it('el corte es la medianoche de Madrid, no la de UTC', () => {
    expect(WELCOME_EMAIL_START_DATE).toBe('2026-09-25');
    expect(isInWelcomeWindow('2026-09-24T22:30:00Z', now)).toBe(true);   // 00:30 del 25 en Madrid
    expect(isInWelcomeWindow('2026-09-24T21:59:00Z', now)).toBe(false);  // 23:59 del 24 en Madrid
  });

  it('más de 72 h desde created_at no entra aunque sea posterior al corte', () => {
    const later = Date.parse('2026-10-10T12:00:00Z');
    expect(isInWelcomeWindow(new Date(later - 73 * H).toISOString(), later)).toBe(false);
    expect(isInWelcomeWindow(new Date(later - 71 * H).toISOString(), later)).toBe(true);
  });

  it('sin fecha o ilegible no entra', () => {
    expect(isInWelcomeWindow(null, now)).toBe(false);
    expect(isInWelcomeWindow('no-es-fecha', now)).toBe(false);
  });
});

describe('pickWelcomeVariant', () => {
  const base = { reason: 'alta' as const, hasOtherActiveWithOtherTeacher: false, hasPreviousClasses: false, hasPreviousAssignmentWithOtherTeacher: false };

  it('alumno nuevo → bienvenida', () => {
    expect(pickWelcomeVariant(base)).toBe('bienvenida');
  });
  it('otra asignación activa con otro profesor → adicional, gana a todo', () => {
    expect(pickWelcomeVariant({ ...base, reason: 'cambio_profesor', hasOtherActiveWithOtherTeacher: true, hasPreviousClasses: true })).toBe('adicional');
  });
  it('cambio de profesor, clases previas o asignación previa → cambio', () => {
    expect(pickWelcomeVariant({ ...base, reason: 'cambio_profesor' })).toBe('cambio');
    expect(pickWelcomeVariant({ ...base, hasPreviousClasses: true })).toBe('cambio');
    expect(pickWelcomeVariant({ ...base, hasPreviousAssignmentWithOtherTeacher: true })).toBe('cambio');
  });
});

describe('firstClassFromSlots — hora de España', () => {
  // Viernes 25/09/2026 a las 18:00 en Madrid (16:00 UTC).
  const now = new Date('2026-09-25T16:00:00Z');

  it('la clase más cercana de la semana, con día en español', () => {
    const r = firstClassFromSlots([{ day: 'Martes', hour: '11:00' }, { day: 'Lunes', hour: '19:00' }], null, now);
    expect(r).toEqual({ dateIso: '2026-09-28', hour: '19:00', label: 'lunes 28 de septiembre' });
  });

  it('hoy, si la hora aún no pasó; la semana que viene si ya pasó', () => {
    expect(firstClassFromSlots([{ day: 'Viernes', hour: '20:00' }], null, now)?.dateIso).toBe('2026-09-25');
    expect(firstClassFromSlots([{ day: 'Viernes', hour: '10:00' }], null, now)?.dateIso).toBe('2026-10-02');
  });

  it('respeta una fecha de inicio futura y acepta días con o sin tilde', () => {
    expect(firstClassFromSlots([{ day: 'Miercoles', hour: '09:00' }], '2026-10-05', now)?.dateIso).toBe('2026-10-07');
    expect(firstClassFromSlots([{ day: 'Sábado', hour: '9:00' }], null, now)).toMatchObject({ dateIso: '2026-09-26', hour: '09:00' });
  });

  it('sin horario → null', () => {
    expect(firstClassFromSlots([], null, now)).toBeNull();
    expect(firstClassFromSlots([{ day: 'Funday', hour: '10:00' }], null, now)).toBeNull();
  });
});

describe('buildWelcomeEmail', () => {
  const base = {
    studentName: 'JOSÉ García', teacherName: 'Ana <Pérez>', lmsEmail: 'jose@ejemplo.com',
    lmsUrl: 'https://drc-lms.vercel.app/acceso',
    pending: { kind: 'formulario' as const, url: 'https://app/formulario/t1' },
    firstClass: { label: 'lunes 28 de septiembre', hour: '19:00' },
  };

  it('bienvenida: asunto, nombre de pila, dos pasos, email del LMS y HTML escapado', () => {
    const { subject, html } = buildWelcomeEmail({ ...base, variant: 'bienvenida' });
    expect(subject).toBe('Ya tienes profesor en DRC Academy: estos son tus próximos pasos');
    expect(html).toContain('Hola, José:');
    expect(html).toContain('Solo te quedan dos pasos');
    expect(html).toContain('Completar formulario');
    expect(html).toContain('Entrar en mi área');
    expect(html).toContain('jose@ejemplo.com');
    expect(html).toContain('Ana &lt;Pérez&gt;');
    expect(html).toContain('lunes 28 de septiembre a las 19:00');
    // "responde a este correo" solo una vez: en el cuerpo, no en el pie.
    expect(html.match(/responde a este correo/g)).toHaveLength(1);
  });

  it('bienvenida sin nada pendiente: un solo paso y sin formulario', () => {
    const { html } = buildWelcomeEmail({ ...base, variant: 'bienvenida', pending: null, firstClass: null });
    expect(html).toContain('Solo te queda un paso');
    expect(html).not.toContain('Completar formulario');
    expect(html).not.toContain('hora peninsular');
  });

  it('solo falta la prueba: el botón lleva a la prueba', () => {
    const { html } = buildWelcomeEmail({ ...base, variant: 'cambio', pending: { kind: 'prueba', url: 'https://app/test/x' } });
    expect(html).toContain('Hacer la prueba de nivel');
    expect(html).toContain('https://app/test/x');
  });

  it('cambio y adicional: asuntos y línea de primera clase', () => {
    expect(buildWelcomeEmail({ ...base, variant: 'cambio' }).subject).toBe('Tienes nuevo profesor en DRC Academy');
    const ad = buildWelcomeEmail({ ...base, variant: 'adicional' });
    expect(ad.subject).toBe('Tienes un nuevo profesor en DRC Academy');
    expect(ad.html).toContain('además de tus clases actuales');
    expect(ad.html).toContain('Tu primera clase con Ana &lt;Pérez&gt; es el');
  });

  it('prueba: [PRUEBA] en el asunto', () => {
    expect(buildWelcomeEmail({ ...base, variant: 'cambio', test: true }).subject).toBe('[PRUEBA] Tienes nuevo profesor en DRC Academy');
  });
});
