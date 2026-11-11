// ── Aviso de "posible falta del profesor" (SOLO SERVIDOR) ────────────────────
//
// Sustituye al zap "Ausencia - Aviso alumno". Lo llama lib/teacherAbsenceStore
// (cron /api/cron/ausencias) cuando, a los 30 minutos del inicio, el profesor
// no pulsó "Ingresar a clase". Tres envíos INDEPENDIENTES:
//   · slack    → SLACK_WEBHOOK_AUSENCIAS (Incoming Webhook de Slack)
//   · whatsapp → al alumno, plantilla "faltaprofe" (lib/notificaciones/whatsapp)
//   · email    → al profesor, desde ausencias@drcacademy.com (Resend)
// Si uno falla, los otros siguen; cada fallo se loguea y vuelve en el resultado
// para que el cron reintente SOLO ese canal.
//
// El anti-duplicado NO vive aquí: lo lleva la fila de teacher_absence_alerts
// (aviso_ausencia_enviado_at + aviso_canales). Esta función envía lo que se le
// pide, sin mirar la base.
//
// `dryRun`: arma exactamente lo que se mandaría (texto de Slack, petición de
// WhatsApp, email) y no envía nada.

import 'server-only';
import { resend, hasResendKey } from '@/lib/resend';
import { enviarPlantillaWhatsApp, proveedorActivo, respondTemplateBody, type PlantillaWhatsApp } from '@/lib/notificaciones/whatsapp';

const SLACK_TIMEOUT_MS = 10_000;

export const AUSENCIA_FROM = 'DRC Academy <ausencias@drcacademy.com>';
export const AUSENCIA_REPLY_TO = 'ausencias@drcacademy.com';
export const AUSENCIA_PLANTILLA = 'faltaprofe';
export const AUSENCIA_IDIOMA = 'es';

export type CanalAusencia = 'slack' | 'whatsapp' | 'email';
export const CANALES_AUSENCIA: readonly CanalAusencia[] = ['slack', 'whatsapp', 'email'];

/** Lo que hace falta de la clase para avisar. */
export interface ClaseAusencia {
  /** Id fijo de la clase (teacher_absence_alerts.id). */
  claseId: string;
  /** 'dd/mm/yyyy' (hora de España). */
  fecha: string;
  /** 'HH:MM' (hora de España). */
  hora: string;
  profeNombre: string;
  /** Donde el profe recibe los avisos (notification_email → email). '' si no hay. */
  profeEmail: string;
  alumnoNombre: string;
  alumnoEmail: string;
  /** '+34600111222', o '' si no lo tenemos. */
  alumnoTelefono: string;
}

/**
 *  enviado     salió bien
 *  error       falló (se reintenta)
 *  sin_config  falta una variable de entorno (no se reintenta hasta que esté)
 *  omitido     no hay destinatario (alumno sin teléfono, profe sin email)
 *  se_enviaria solo en dryRun
 */
export type EstadoCanal = 'enviado' | 'error' | 'sin_config' | 'omitido' | 'se_enviaria';

export interface ResultadoCanal {
  estado: EstadoCanal;
  /** ISO del envío correcto. */
  at?: string;
  error?: string;
  /** En dryRun (y en 'omitido'), qué se mandaría o por qué no. */
  vista?: unknown;
}

export type ResultadoAusencia = Partial<Record<CanalAusencia, ResultadoCanal>>;

// ── Textos ────────────────────────────────────────────────────────────────────

export function nombreDePila(nombre: string): string {
  return (nombre ?? '').trim().split(/\s+/)[0] ?? '';
}

export function telefonoValido(t: string): boolean {
  return /^\+\d{8,15}$/.test(t);
}

export function textoSlackAusencia(c: ClaseAusencia): string {
  return [
    '⚠️ *Posible falta de profesor*',
    `*Profe:* ${c.profeNombre}`,
    `*Alumno:* ${c.alumnoNombre}`,
    `*Clase:* ${c.fecha} a las ${c.hora} (hora de España)`,
    `*Teléfono del alumno:* ${c.alumnoTelefono || 'no lo tenemos'}`,
    `*Email del alumno:* ${c.alumnoEmail || 'no lo tenemos'}`,
    'El profe no pulsó "Ingresar a clase" a los 30 minutos.',
  ].join('\n');
}

export function plantillaAusencia(c: ClaseAusencia): PlantillaWhatsApp {
  const partes = (c.alumnoNombre ?? '').trim().split(/\s+/);
  return {
    telefono: c.alumnoTelefono,
    plantilla: AUSENCIA_PLANTILLA,
    idioma: AUSENCIA_IDIOMA,
    parametros: [nombreDePila(c.alumnoNombre), c.hora],
    contacto: { nombre: partes[0] || undefined, apellidos: partes.slice(1).join(' ') || undefined, email: c.alumnoEmail || undefined },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function emailAusencia(c: ClaseAusencia): { to: string; subject: string; text: string; html: string } {
  const parrafos = [
    `Hola ${c.profeNombre},`,
    `No te hemos visto conectado a tu clase de hoy de las ${c.hora} con ${c.alumnoNombre}. Si ha habido algún problema, avísanos respondiendo a este correo.`,
    'Un saludo,\nEl equipo de DRC Academy',
  ];
  return {
    to: c.profeEmail,
    subject: `No te conectaste a tu clase de las ${c.hora}`,
    text: parrafos.join('\n\n'),
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">${
      parrafos.map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>`,
  };
}

// ── Canales ───────────────────────────────────────────────────────────────────

function slackUrl(): { url: string } | { falta: string } {
  const url = process.env.SLACK_WEBHOOK_AUSENCIAS?.trim() ?? '';
  if (!url) return { falta: 'Falta SLACK_WEBHOOK_AUSENCIAS en Vercel.' };
  if (!/^https:\/\/hooks\.slack\.com\//i.test(url)) return { falta: 'SLACK_WEBHOOK_AUSENCIAS no es un Incoming Webhook de Slack (https://hooks.slack.com/…).' };
  return { url };
}

async function canalSlack(c: ClaseAusencia, dryRun: boolean): Promise<ResultadoCanal> {
  const text = textoSlackAusencia(c);
  const cfg = slackUrl();
  if ('falta' in cfg) return { estado: 'sin_config', error: cfg.falta, vista: dryRun ? { text } : undefined };
  if (dryRun) return { estado: 'se_enviaria', vista: { text } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }), signal: controller.signal, cache: 'no-store',
    });
    if (!res.ok) return { estado: 'error', error: `Slack respondió HTTP ${res.status}` };
    return { estado: 'enviado', at: new Date().toISOString() };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    return { estado: 'error', error: err?.name === 'AbortError' ? `Slack: timeout tras ${SLACK_TIMEOUT_MS} ms` : `Slack: ${String(err?.message ?? e)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function canalWhatsApp(c: ClaseAusencia, dryRun: boolean): Promise<ResultadoCanal> {
  const p = plantillaAusencia(c);
  if (!c.alumnoTelefono) return { estado: 'omitido', error: 'El alumno no tiene teléfono.' };
  if (!telefonoValido(c.alumnoTelefono)) return { estado: 'omitido', error: `Teléfono sin formato internacional: ${c.alumnoTelefono}` };
  const proveedor = proveedorActivo();
  const falta = proveedor.faltaConfig();
  const vista = dryRun ? {
    proveedor: proveedor.nombre, telefono: p.telefono, plantilla: p.plantilla, idioma: p.idioma, parametros: p.parametros,
    cuerpo: respondTemplateBody(p, Number(process.env.RESPOND_CHANNEL_ID?.trim() || 0)),
  } : undefined;
  if (falta) return { estado: 'sin_config', error: falta, vista };
  if (dryRun) return { estado: 'se_enviaria', vista };
  const r = await enviarPlantillaWhatsApp(p, proveedor);
  if (r.ok) return { estado: 'enviado', at: new Date().toISOString() };
  return { estado: r.sinConfig ? 'sin_config' : 'error', error: r.error };
}

async function canalEmail(c: ClaseAusencia, dryRun: boolean): Promise<ResultadoCanal> {
  const m = emailAusencia(c);
  if (!m.to) return { estado: 'omitido', error: 'El profesor no tiene email.' };
  const vista = dryRun ? { from: AUSENCIA_FROM, replyTo: AUSENCIA_REPLY_TO, ...m, html: undefined } : undefined;
  if (!hasResendKey()) return { estado: 'sin_config', error: 'Falta RESEND_API_KEY en Vercel.', vista };
  if (dryRun) return { estado: 'se_enviaria', vista };
  try {
    const { error } = await resend.emails.send(
      { from: AUSENCIA_FROM, to: m.to, replyTo: AUSENCIA_REPLY_TO, subject: m.subject, text: m.text, html: m.html },
      // Si un reintento repite el mismo email (p. ej. la respuesta se perdió), Resend no lo duplica.
      { idempotencyKey: `ausencia-email-${c.claseId}`.slice(0, 256) },
    );
    if (error) return { estado: 'error', error: `Resend: ${error.message}` };
    return { estado: 'enviado', at: new Date().toISOString() };
  } catch (e) {
    return { estado: 'error', error: `Resend: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const ENVIAR: Record<CanalAusencia, (c: ClaseAusencia, dryRun: boolean) => Promise<ResultadoCanal>> = {
  slack: canalSlack, whatsapp: canalWhatsApp, email: canalEmail,
};

/** Qué canales tienen sus variables de entorno cargadas. */
export function canalesConfigurados(): Record<CanalAusencia, boolean> {
  return {
    slack: !('falta' in slackUrl()),
    whatsapp: proveedorActivo().faltaConfig() === null,
    email: hasResendKey(),
  };
}

// ── La función ────────────────────────────────────────────────────────────────

/**
 * Manda los avisos de una posible falta del profesor. `canales` limita a cuáles
 * (el cron lo usa para reintentar solo los que fallaron). Nunca lanza.
 */
export async function notificarAusencia(
  clase: ClaseAusencia,
  opts: { dryRun?: boolean; canales?: readonly CanalAusencia[] } = {},
): Promise<ResultadoAusencia> {
  const dryRun = !!opts.dryRun;
  const canales = opts.canales ?? CANALES_AUSENCIA;
  const settled = await Promise.allSettled(canales.map(canal => ENVIAR[canal](clase, dryRun)));
  const out: ResultadoAusencia = {};
  settled.forEach((s, i) => {
    const canal = canales[i];
    const r: ResultadoCanal = s.status === 'fulfilled'
      ? s.value
      : { estado: 'error', error: s.reason instanceof Error ? s.reason.message : String(s.reason) };
    if (r.estado === 'error' || r.estado === 'sin_config') {
      console.error(`[aviso ausencia] ${canal} ${r.estado} (${clase.claseId}): ${r.error}`);
    }
    out[canal] = r;
  });
  return out;
}

/** ¿Hay que reintentar este canal? Solo lo que falló de verdad. */
export function canalesAReintentar(prev: ResultadoAusencia | null | undefined): CanalAusencia[] {
  if (!prev) return [...CANALES_AUSENCIA];
  return CANALES_AUSENCIA.filter(c => !prev[c] || prev[c]!.estado === 'error');
}

/** Junta el resultado de un reintento con lo anterior (lo enviado nunca se pisa). */
export function mezclarResultados(prev: ResultadoAusencia | null | undefined, nuevo: ResultadoAusencia): ResultadoAusencia {
  const out: ResultadoAusencia = { ...(prev ?? {}) };
  for (const c of CANALES_AUSENCIA) {
    if (!nuevo[c]) continue;
    if (out[c]?.estado === 'enviado') continue;
    const sinVista = { ...nuevo[c]! };
    delete sinVista.vista;
    out[c] = sinVista;
  }
  return out;
}
