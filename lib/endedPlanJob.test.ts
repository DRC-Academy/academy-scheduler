import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();
vi.mock('@/lib/resend', () => ({
  resend: { emails: { send: (...a: unknown[]) => sendMock(...a) } },
  hasResendKey: () => true,
}));
const verificar = vi.fn();
vi.mock('@/lib/subscriptionCheck', () => ({ verificarSuscripcion: (...a: unknown[]) => verificar(...a) }));
vi.mock('@/lib/emailNotifications', () => ({ ENDING_PLANS_EMAIL: 'alumnos@drcacademy.com' }));

import { runEndedPlanNotices, sendEndedPlanSamples } from '@/lib/endedPlanJob';
import { emailAlumno, emailProfe, emailEquipo, planDeEjemplo, WHATSAPP_RENOVAR, ENDED_FROM, ENDED_REPLY_TO } from '@/lib/endedPlanEmails';

// ── Base de mentira: lo justo para lo que hace el job ─────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
function fakeAdmin(opts: { students: Row[]; sinColumnas?: boolean; updates?: Row[] }) {
  const tables: Record<string, Row[]> = {
    assignments: [{ id: 'a1', teacher_id: 't9', student_id: 's1', student_email: 'ana@x.com', student_name: 'Ana Pérez', status: 'active', created_at: '2026-08-01' }],
    teachers: [{ id: 't9', name: 'Laura', email: 'laura@x.com', notification_email: null, is_test: false, archived_at: null }],
  };
  return {
    from(table: string) {
      return {
        select(cols: string) {
          if (table === 'students') {
            const res = opts.sinColumnas && cols.includes('ended_notice')
              ? { data: null, error: { code: '42703', message: 'column students.ended_notice_sent_at does not exist' } }
              : { data: opts.students, error: null };
            const chain = { gte: () => chain, lte: () => Promise.resolve(res) };
            return chain;
          }
          const chain = { order: () => chain, range: () => Promise.resolve({ data: tables[table] ?? [], error: null }) };
          return chain;
        },
        update(v: Row) {
          return { eq: (_c: string, id: string) => { opts.updates?.push({ id, ...v }); return Promise.resolve({ error: null }); } };
        },
      };
    },
  } as never;
}

const ANA: Row = {
  id: 's1', name: 'Ana Pérez', email: 'ana@x.com', phone: '+34600111222', product_type: 'one_time',
  product_name: 'Intensivo FCE — 12:00', plan: null, manual_active_until: '2026-11-16', is_test: false, is_oritalk: false,
  company_plan_months: null, woo_product_id: 30782, ending_notice_for_date: '2026-11-16',
  ended_notice_sent_at: null, ended_notice_for_date: null, ended_notice_canales: null,
};

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue({ data: { id: 'e' }, error: null });
  verificar.mockReset().mockResolvedValue({ active: false, status: 'one_time_no_access', phone: null });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('la vuelta', () => {
  it('SIN el SQL no se envía nada (y dry sí calcula)', async () => {
    const r = await runEndedPlanNotices(fakeAdmin({ students: [ANA], sinColumnas: true }), { today: '2026-11-17' });
    expect(r.migracionPendiente).toBe(true);
    expect(r.ok).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
    expect(verificar).not.toHaveBeenCalled();

    const d = await runEndedPlanNotices(fakeAdmin({ students: [ANA], sinColumnas: true }), { today: '2026-11-17', dry: true });
    expect(d.migracionPendiente).toBe(true);
    expect(d.items[0].resultado).toBe('se_enviaria');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('manda alumno → profe → equipo y marca el ciclo completo', async () => {
    const updates: Row[] = [];
    const r = await runEndedPlanNotices(fakeAdmin({ students: [ANA], updates }), { today: '2026-11-17' });
    expect(r.avisados).toBe(1);
    const tos = sendMock.mock.calls.map(c => c[0].to);
    expect(tos).toEqual(['ana@x.com', 'laura@x.com', 'alumnos@drcacademy.com']);
    expect(sendMock.mock.calls[0][0]).toMatchObject({ from: ENDED_FROM, replyTo: ENDED_REPLY_TO, subject: 'Tu plan ha finalizado' });
    expect(sendMock.mock.calls[1][0].replyTo).toBeUndefined();
    expect(sendMock.mock.calls[0][1].idempotencyKey).toBe('fin-plan-alumno-s1-2026-11-16');
    expect(updates[0]).toMatchObject({ id: 's1', ended_notice_for_date: '2026-11-16' });
    expect(updates[0].ended_notice_sent_at).toBeTruthy();
    expect(updates[0].ended_notice_canales.alumno.estado).toBe('enviado');
  });

  it('si un envío falla, NO se marca como enviado y se guarda el error', async () => {
    sendMock.mockImplementation(async (p: Row) => (p.to === 'laura@x.com' ? { data: null, error: { message: 'caído' } } : { data: {}, error: null }));
    const updates: Row[] = [];
    const r = await runEndedPlanNotices(fakeAdmin({ students: [ANA], updates }), { today: '2026-11-17' });
    expect(r.items[0].resultado).toBe('avisado_con_errores');
    expect(updates[0].ended_notice_sent_at).toBeNull();
    expect(updates[0].ended_notice_canales.profe).toMatchObject({ estado: 'error', error: 'Resend: caído' });
    // El del equipo dice que el profe no recibió el aviso.
    expect(sendMock.mock.calls[2][0].text).toContain('El aviso a su profe NO ha salido');
  });

  it('al día siguiente reintenta SOLO el que falló', async () => {
    const prev = { ...ANA, ended_notice_for_date: '2026-11-16', ended_notice_canales: {
      alumno: { estado: 'enviado', at: 'x' }, profe: { estado: 'error', error: 'caído' }, equipo: { estado: 'enviado', at: 'x' } } };
    const updates: Row[] = [];
    await runEndedPlanNotices(fakeAdmin({ students: [prev], updates }), { today: '2026-11-18' });
    expect(sendMock.mock.calls.map(c => c[0].to)).toEqual(['laura@x.com']);
    expect(updates[0].ended_notice_sent_at).toBeTruthy();
    expect(updates[0].ended_notice_canales.alumno).toEqual({ estado: 'enviado', at: 'x' });
  });

  it.each([
    ['renovó', { active: true, status: 'active' }, 'renovo'],
    ['Woo no responde', { active: null, status: 'error' }, 'no_verificado'],
    ['pago pendiente', { active: false, status: 'on-hold' }, 'en_espera'],
  ])('%s: no se avisa ni se marca', async (_n, v, resultado) => {
    verificar.mockResolvedValue({ ...v, phone: null });
    const updates: Row[] = [];
    const r = await runEndedPlanNotices(fakeAdmin({ students: [ANA], updates }), { today: '2026-11-17' });
    expect(r.items[0].resultado).toBe(resultado);
    expect(sendMock).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('dry: comprueba Woo pero no envía ni marca', async () => {
    const updates: Row[] = [];
    const r = await runEndedPlanNotices(fakeAdmin({ students: [ANA], updates }), { today: '2026-11-17', dry: true });
    expect(r.items[0].vista?.alumno).toEqual({ to: 'ana@x.com', subject: 'Tu plan ha finalizado' });
    expect(r.items[0].vista?.equipo?.to).toBe('alumnos@drcacademy.com');
    expect(sendMock).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('prueba: los tres a la misma dirección, con [PRUEBA]', async () => {
    const r = await sendEndedPlanSamples('yo@x.com');
    expect(sendMock.mock.calls.map(c => c[0].to)).toEqual(['yo@x.com', 'yo@x.com', 'yo@x.com']);
    expect(r.alumno.subject).toBe('[PRUEBA] Tu plan ha finalizado');
  });
});

describe('textos', () => {
  const d = planDeEjemplo();

  it('asuntos', () => {
    expect(emailAlumno(d).subject).toBe('Tu plan ha finalizado');
    expect(emailProfe(d).subject).toBe('Plan de Lucía Fernández Ruiz finalizado');
    expect(emailEquipo(d, {}).subject).toBe('Plan de Lucía Fernández Ruiz ha finalizado');
  });

  it('alumno: plan, profe, fecha y el botón de WhatsApp exacto', () => {
    const m = emailAlumno(d);
    expect(m.html).toContain('Intensivo FCE');
    expect(m.html).toContain('Laura');
    expect(m.html).toContain('17 de noviembre de 2026');
    expect(m.html).toContain(`href="${WHATSAPP_RENOVAR.replace(/&/g, '&amp;')}"`);
    expect(m.html).toContain('Renovar mi plan');
    expect(m.text).toContain(WHATSAPP_RENOVAR);
  });

  it('sin nombre de plan ni profe: frase genérica, sin filas vacías', () => {
    const m = emailAlumno({ ...d, planName: null, teacher: null });
    expect(m.html).toContain('Tu plan en DRC Academy ha finalizado');
    expect(m.html).not.toContain('Tu profe');
  });

  it('marca Radio Canada y ningún gris en los tres', () => {
    for (const m of [emailAlumno(d), emailProfe(d), emailEquipo(d, {})]) {
      expect(m.html).toContain("'Radio Canada'");
      expect(m.html).not.toMatch(/#888880|#5A5A55|rgba\(255,255,255,0\.85\)/i);
    }
  });

  it('escapa lo que viene de la base', () => {
    const m = emailEquipo({ ...d, studentName: 'Ana <b>&</b>' }, {});
    expect(m.html).toContain('Ana &lt;b&gt;&amp;&lt;/b&gt;');
    expect(m.html).not.toContain('<b>&</b>');
  });
});
