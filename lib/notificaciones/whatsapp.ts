// ── WhatsApp por plantilla (SOLO SERVIDOR) ───────────────────────────────────
//
// Una sola puerta para mandar una plantilla de WhatsApp: enviarPlantillaWhatsApp().
// Hoy va por Respond.io; para pasar a WhatsApp Cloud API se escribe otro
// `ProveedorWhatsApp` y se cambia `proveedorActivo()`, sin tocar a quien llama.
//
// Respond.io (API v2):
//   POST https://api.respond.io/v2/contact/phone:+34600111222/message
//   Authorization: Bearer <RESPOND_API_TOKEN>
//   { channelId, message: { type: 'whatsapp_template', template: { name, languageCode, components } } }
// Si el contacto no existe en Respond (404), se crea con
//   POST /v2/contact/create_or_update/phone:+34…
// y se reintenta UNA vez.
//
// Canal: RESPOND_CHANNEL_ID (el id numérico del canal de WhatsApp Business en
// Respond). Sin él, Respond usa el último canal por el que habló el contacto,
// que puede no ser WhatsApp: por eso, si falta, NO se envía.
//
// Nunca lanza: red, timeout o un error de la API vuelven como `{ ok: false }`.

import 'server-only';

const TIMEOUT_MS = 10_000;
const RESPOND_BASE = 'https://api.respond.io/v2';

export interface PlantillaWhatsApp {
  /** Formato internacional: '+34600111222'. */
  telefono: string;
  /** Nombre de la plantilla aprobada por Meta (p. ej. 'faltaprofe'). */
  plantilla: string;
  /** Código de idioma de la plantilla (p. ej. 'es'). */
  idioma: string;
  /** Variables del cuerpo, en orden: [0] → {{1}}, [1] → {{2}}… */
  parametros: string[];
  /** Para crear el contacto si el proveedor no lo conoce. */
  contacto?: { nombre?: string; apellidos?: string; email?: string };
}

export type ResultadoWhatsApp =
  | { ok: true; proveedor: string; messageId?: string | number }
  | { ok: false; proveedor: string; sinConfig?: boolean; error: string };

export interface ProveedorWhatsApp {
  nombre: string;
  /** null si está listo; si no, qué falta (variable de entorno…). */
  faltaConfig(): string | null;
  enviar(p: PlantillaWhatsApp): Promise<ResultadoWhatsApp>;
}

// ── Respond.io ────────────────────────────────────────────────────────────────

async function respondFetch(path: string, token: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${RESPOND_BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function errorDe(status: number, json: Record<string, unknown> | null): string {
  const msg = json && typeof json.message === 'string' ? json.message : '';
  return `Respond.io HTTP ${status}${msg ? `: ${msg}` : ''}`;
}

/** El cuerpo del mensaje de plantilla de Respond (exportado para el modo de prueba). */
export function respondTemplateBody(p: PlantillaWhatsApp, channelId: number): Record<string, unknown> {
  return {
    channelId,
    message: {
      type: 'whatsapp_template',
      template: {
        name: p.plantilla,
        languageCode: p.idioma,
        components: [
          { type: 'body', parameters: p.parametros.map(text => ({ type: 'text', text })) },
        ],
      },
    },
  };
}

export const respondIo: ProveedorWhatsApp = {
  nombre: 'respond.io',
  faltaConfig() {
    if (!process.env.RESPOND_API_TOKEN?.trim()) return 'Falta RESPOND_API_TOKEN en Vercel.';
    if (!Number.isFinite(Number(process.env.RESPOND_CHANNEL_ID?.trim() || NaN))) return 'Falta RESPOND_CHANNEL_ID (id numérico del canal de WhatsApp en Respond) en Vercel.';
    return null;
  },
  async enviar(p) {
    const falta = this.faltaConfig();
    if (falta) return { ok: false, proveedor: this.nombre, sinConfig: true, error: falta };
    const token = process.env.RESPOND_API_TOKEN!.trim();
    const channelId = Number(process.env.RESPOND_CHANNEL_ID!.trim());
    const ident = encodeURIComponent(`phone:${p.telefono}`);
    try {
      let r = await respondFetch(`/contact/${ident}/message`, token, respondTemplateBody(p, channelId));
      if (r.status === 404) {
        // Contacto nuevo para Respond: se crea y se reintenta una vez.
        const c = await respondFetch(`/contact/create_or_update/${ident}`, token, {
          firstName: p.contacto?.nombre || p.telefono,
          ...(p.contacto?.apellidos ? { lastName: p.contacto.apellidos } : {}),
          ...(p.contacto?.email ? { email: p.contacto.email } : {}),
          phone: p.telefono,
        });
        if (c.status >= 300) return { ok: false, proveedor: this.nombre, error: `No se pudo crear el contacto. ${errorDe(c.status, c.json)}` };
        r = await respondFetch(`/contact/${ident}/message`, token, respondTemplateBody(p, channelId));
      }
      if (r.status >= 300) return { ok: false, proveedor: this.nombre, error: errorDe(r.status, r.json) };
      const messageId = r.json?.messageId as string | number | undefined;
      return { ok: true, proveedor: this.nombre, messageId };
    } catch (e) {
      const err = e as { name?: string; message?: string };
      return { ok: false, proveedor: this.nombre, error: err?.name === 'AbortError' ? `Respond.io: timeout tras ${TIMEOUT_MS} ms` : `Respond.io: ${String(err?.message ?? e)}` };
    }
  },
};

// ── La puerta ─────────────────────────────────────────────────────────────────

/** El proveedor en uso. Para WhatsApp Cloud API: devolver aquí el nuevo. */
export function proveedorActivo(): ProveedorWhatsApp {
  return respondIo;
}

export function enviarPlantillaWhatsApp(p: PlantillaWhatsApp, proveedor: ProveedorWhatsApp = proveedorActivo()): Promise<ResultadoWhatsApp> {
  return proveedor.enviar(p);
}
