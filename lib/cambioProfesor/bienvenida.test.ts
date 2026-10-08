// ¿Sale DE VERDAD la bienvenida 'cambio' en el cambio de profesor del LMS? Se
// corre el flujo entero (cambiarProfesorCore → núcleo de transferencia) con la
// función real de envío (sendWelcomeForAssignment, la de depsServidor). Solo se
// simula Resend.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const enviados: Array<{ to: string; cc?: string[]; subject: string; html: string }> = [];
vi.mock('@/lib/resend', () => ({
  RESEND_PLACEHOLDER_KEY: 're_missing_api_key',
  hasResendKey: () => true,
  resend: { emails: { send: vi.fn(async (m: { to: string; cc?: string[]; subject: string; html: string }) => { enviados.push(m); return { data: { id: 're_1' }, error: null }; }) } },
}));

import { cambiarProfesorCore } from '@/lib/cambioProfesor/core';
import { transferirAlumnoCore } from '@/lib/transferencia/core';
import { sendWelcomeForAssignment, type WelcomeResult } from '@/lib/welcomeEmailSend';
import { AHORA, dbFase2 } from '@/lib/cambioProfesor/fixtures.test-helper';
import type { FakeDb } from '@/lib/transferencia/fakeDb.test-helper';

function preparar(db: FakeDb) {
  // Lo que la bienvenida necesita del alumno: aparecer en la vista del LMS con su
  // email, y un formulario pendiente (para no tener que crear enlaces).
  db.tables.vista_perfil_alumno = [{ alumno_id: 's1', email: 'lucia@x.com' }];
  db.tables.form_tokens = [{ id: 'ft1', token: 'tok1', status: 'pending', student_id: 's1', student_name: 'Lucía Pérez',
    created_at: '2026-10-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' }];
  db.tables.level_test_sessions = [];
  db.tables.class_join_logs = [];
}

async function cambiar(db: FakeDb) {
  const resultados: WelcomeResult[] = [];
  vi.setSystemTime(AHORA);
  await cambiarProfesorCore(db.client(), {
    studentId: 's1', profesorId: 'tB',
    destinos: [{ dia: 'Lunes', hora: '10:00', duracion: 2 }, { dia: 'Miércoles', hora: '18:00', duracion: 1 }],
  }, tp => transferirAlumnoCore(db.client(), tp, {
    enviarEmailProfeNuevo: async () => true,
    // Lo mismo que depsServidor: que la omita no es fallo; un error sí.
    enviarBienvenidaAlumno: async id => {
      const r = await sendWelcomeForAssignment(db.client(), id, 'cambio_profesor', 'https://gestion.test');
      resultados.push(r);
      if ('error' in r) throw new Error(r.error);
    },
    ahora: () => AHORA,
  }), AHORA);
  return resultados;
}

describe('bienvenida "cambio" en el cambio de profesor del LMS', () => {
  beforeEach(() => { enviados.length = 0; vi.useFakeTimers({ toFake: ['Date'] }); });

  it('sale: variante cambio, al email del alumno, con el profesor nuevo', async () => {
    const db = dbFase2(); preparar(db);
    const r = await cambiar(db);
    expect(r).toEqual([expect.objectContaining({ sent: true, variant: 'cambio', to: 'lucia@x.com' })]);
    expect(enviados).toHaveLength(1);
    expect(enviados[0].html).toContain('Carla');
    expect(db.rows('assignments')[0]).toMatchObject({ welcome_email_teacher: 'tB', welcome_email_to: 'lucia@x.com' });
    vi.useRealTimers();
  });

  it('barreras que la frenan: sin email en la ficha, o fuera de vista_perfil_alumno (avisan al admin)', async () => {
    const db = dbFase2(); preparar(db); db.rows('students')[0].email = null;
    expect(await cambiar(db)).toEqual([{ skipped: 'sin_email' }]);
    expect(db.rows('notifications').some(n => String(n.body).includes('no tiene email'))).toBe(true);

    const db2 = dbFase2(); preparar(db2); db2.tables.vista_perfil_alumno = [];
    expect(await cambiar(db2)).toEqual([{ skipped: 'fuera_de_la_vista' }]);
    expect(enviados).toHaveLength(0);
    vi.useRealTimers();
  });

  it('NO la frenan ni la ventana de 72 h (el cambio reinicia created_at) ni una bienvenida anterior con el profesor viejo', async () => {
    const db = dbFase2(); preparar(db);
    Object.assign(db.rows('assignments')[0], {
      created_at: '2026-09-01T00:00:00Z',               // alta de hace más de un mes
      welcome_email_teacher: 'tA', welcome_email_sent_at: '2026-09-01T00:05:00Z', welcome_email_to: 'lucia@x.com',
    });
    expect(await cambiar(db)).toEqual([expect.objectContaining({ sent: true, variant: 'cambio' })]);
    vi.useRealTimers();
  });
});
