import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();
let resendKey = true;
vi.mock('@/lib/resend', () => ({
  resend: { emails: { send: (...a: unknown[]) => sendMock(...a) } },
  hasResendKey: () => resendKey,
}));

import {
  notificarAusencia, textoSlackAusencia, emailAusencia, plantillaAusencia, canalesAReintentar, mezclarResultados,
  AUSENCIA_FROM, AUSENCIA_REPLY_TO, type ClaseAusencia,
} from '@/lib/notificaciones/ausencia';
import { claseAusenciaDe, buildAbsencePayload } from '@/lib/teacherAbsences';

const CLASE: ClaseAusencia = {
  claseId: 'aus_t9_2026-11-11_18_ana-perez',
  fecha: '11/11/2026', hora: '18:00',
  profeNombre: 'Laura', profeEmail: 'laura@example.com',
  alumnoNombre: 'Ana Pérez López', alumnoEmail: 'ana@example.com', alumnoTelefono: '+34600111222',
};

const SLACK = 'https://hooks.slack.com/services/T/B/x';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.SLACK_WEBHOOK_AUSENCIAS = SLACK;
  process.env.RESPOND_API_TOKEN = 'tok';
  process.env.RESPOND_CHANNEL_ID = '123';
  resendKey = true;
  sendMock.mockReset().mockResolvedValue({ data: { id: 'e1' }, error: null });
  fetchMock = vi.fn(async (url: string) => (String(url).startsWith(SLACK) ? new Response('ok') : json(200, { messageId: 99 })));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('textos', () => {
  it('Slack: el mensaje pedido, línea a línea', () => {
    expect(textoSlackAusencia(CLASE)).toBe([
      '⚠️ *Posible falta de profesor*',
      '*Profe:* Laura',
      '*Alumno:* Ana Pérez López',
      '*Clase:* 11/11/2026 a las 18:00 (hora de España)',
      '*Teléfono del alumno:* +34600111222',
      '*Email del alumno:* ana@example.com',
      'El profe no pulsó "Ingresar a clase" a los 30 minutos.',
    ].join('\n'));
  });

  it('WhatsApp: plantilla faltaprofe, es, {{1}} = nombre de pila, {{2}} = hora', () => {
    const p = plantillaAusencia(CLASE);
    expect(p).toMatchObject({ plantilla: 'faltaprofe', idioma: 'es', parametros: ['Ana', '18:00'], telefono: '+34600111222' });
  });

  it('email: asunto y cuerpo pedidos', () => {
    const m = emailAusencia(CLASE);
    expect(m.subject).toBe('No te conectaste a tu clase de las 18:00');
    expect(m.text).toBe('Hola Laura,\n\nNo te hemos visto conectado a tu clase de hoy de las 18:00 con Ana Pérez López. ' +
      'Si ha habido algún problema, avísanos respondiendo a este correo.\n\nUn saludo,\nEl equipo de DRC Academy');
  });

  it('el payload guardado se convierte en la clase del aviso', () => {
    const p = buildAbsencePayload({
      id: 'x', date: '2026-11-11', hour: '18:00', teacherName: 'Laura', teacherEmail: 'l@x.com',
      studentName: 'Ana Pérez', studentEmail: 'a@x.com', phone: '+34600111222',
    });
    expect(claseAusenciaDe(p)).toEqual({
      claseId: 'x', fecha: '11/11/2026', hora: '18:00', profeNombre: 'Laura', profeEmail: 'l@x.com',
      alumnoNombre: 'Ana Pérez', alumnoEmail: 'a@x.com', alumnoTelefono: '+34600111222',
    });
  });
});

describe('notificarAusencia', () => {
  it('manda los tres', async () => {
    const r = await notificarAusencia(CLASE);
    expect(r.slack?.estado).toBe('enviado');
    expect(r.whatsapp?.estado).toBe('enviado');
    expect(r.email?.estado).toBe('enviado');

    const [slackUrl, slackInit] = fetchMock.mock.calls.find(c => String(c[0]).startsWith(SLACK))!;
    expect(slackUrl).toBe(SLACK);
    expect(JSON.parse(slackInit.body).text).toBe(textoSlackAusencia(CLASE));

    const [wUrl, wInit] = fetchMock.mock.calls.find(c => String(c[0]).includes('respond.io'))!;
    expect(wUrl).toBe('https://api.respond.io/v2/contact/phone%3A%2B34600111222/message');
    expect(wInit.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(wInit.body)).toEqual({
      channelId: 123,
      message: { type: 'whatsapp_template', template: { name: 'faltaprofe', languageCode: 'es', components: [
        { type: 'body', parameters: [{ type: 'text', text: 'Ana' }, { type: 'text', text: '18:00' }] },
      ] } },
    });

    const [payload, opts] = sendMock.mock.calls[0];
    expect(payload).toMatchObject({ from: AUSENCIA_FROM, to: 'laura@example.com', replyTo: AUSENCIA_REPLY_TO });
    expect(AUSENCIA_FROM).toBe('DRC Academy <ausencias@drcacademy.com>');
    expect(opts.idempotencyKey).toContain(CLASE.claseId);
  });

  it('si uno falla, los otros siguen', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).startsWith(SLACK)) throw new Error('red caída');
      return json(500, { message: 'boom' });
    });
    const r = await notificarAusencia(CLASE);
    expect(r.slack).toMatchObject({ estado: 'error' });
    expect(r.whatsapp).toMatchObject({ estado: 'error', error: 'Respond.io HTTP 500: boom' });
    expect(r.email?.estado).toBe('enviado');
  });

  it('error de Resend no corta Slack ni WhatsApp', async () => {
    sendMock.mockRejectedValue(new Error('caído'));
    const r = await notificarAusencia(CLASE);
    expect(r.email).toMatchObject({ estado: 'error' });
    expect(r.slack?.estado).toBe('enviado');
    expect(r.whatsapp?.estado).toBe('enviado');
  });

  it('contacto que Respond no conoce: lo crea y reintenta una vez', async () => {
    let mensajes = 0;
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.startsWith(SLACK)) return new Response('ok');
      if (u.includes('/contact/create_or_update/')) return json(200, { id: 1 });
      mensajes++;
      return mensajes === 1 ? json(404, { message: 'Contact not found' }) : json(200, { messageId: 7 });
    });
    const r = await notificarAusencia(CLASE, { canales: ['whatsapp'] });
    expect(r.whatsapp?.estado).toBe('enviado');
    const crear = fetchMock.mock.calls.find(c => String(c[0]).includes('create_or_update'))!;
    expect(JSON.parse(crear[1].body)).toMatchObject({ firstName: 'Ana', lastName: 'Pérez López', phone: '+34600111222', email: 'ana@example.com' });
    expect(mensajes).toBe(2);
  });

  it('dryRun: arma todo y no envía nada', async () => {
    const r = await notificarAusencia(CLASE, { dryRun: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(r.slack).toMatchObject({ estado: 'se_enviaria', vista: { text: textoSlackAusencia(CLASE) } });
    expect(r.whatsapp?.estado).toBe('se_enviaria');
    expect(r.email).toMatchObject({ estado: 'se_enviaria', vista: { subject: 'No te conectaste a tu clase de las 18:00' } });
  });

  it('sin variables: sin_config, sin enviar', async () => {
    delete process.env.SLACK_WEBHOOK_AUSENCIAS;
    delete process.env.RESPOND_CHANNEL_ID;
    resendKey = false;
    const r = await notificarAusencia(CLASE);
    expect(r.slack?.estado).toBe('sin_config');
    expect(r.whatsapp?.estado).toBe('sin_config');
    expect(r.email?.estado).toBe('sin_config');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un webhook que no es de Slack no se usa', async () => {
    process.env.SLACK_WEBHOOK_AUSENCIAS = 'https://hooks.zapier.com/hooks/catch/1/abc/';
    const r = await notificarAusencia(CLASE, { canales: ['slack'] });
    expect(r.slack?.estado).toBe('sin_config');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sin teléfono o sin email del profe: omitido', async () => {
    const r = await notificarAusencia({ ...CLASE, alumnoTelefono: '', profeEmail: '' });
    expect(r.whatsapp?.estado).toBe('omitido');
    expect(r.email?.estado).toBe('omitido');
    expect(r.slack?.estado).toBe('enviado');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toContain('*Teléfono del alumno:* no lo tenemos');
  });

  it('teléfono sin prefijo internacional: no se manda', async () => {
    const r = await notificarAusencia({ ...CLASE, alumnoTelefono: '12345' }, { canales: ['whatsapp'] });
    expect(r.whatsapp?.estado).toBe('omitido');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('reintentos', () => {
  it('sin resultado previo: todos los canales', () => {
    expect(canalesAReintentar(null)).toEqual(['slack', 'whatsapp', 'email']);
  });

  it('solo los que fallaron', () => {
    expect(canalesAReintentar({
      slack: { estado: 'enviado' }, whatsapp: { estado: 'error' }, email: { estado: 'omitido' },
    })).toEqual(['whatsapp']);
    expect(canalesAReintentar({ slack: { estado: 'enviado' }, whatsapp: { estado: 'sin_config' }, email: { estado: 'enviado' } })).toEqual([]);
  });

  it('mezclar nunca pisa lo enviado y no guarda la vista', () => {
    const m = mezclarResultados(
      { slack: { estado: 'enviado', at: 't1' }, whatsapp: { estado: 'error', error: 'x' } },
      { slack: { estado: 'error' }, whatsapp: { estado: 'enviado', at: 't2', vista: { a: 1 } } },
    );
    expect(m).toEqual({ slack: { estado: 'enviado', at: 't1' }, whatsapp: { estado: 'enviado', at: 't2' } });
  });
});
