// Cliente de Anthropic (Claude) + helper para pedirle respuestas en JSON.
//
// Todas las llamadas del módulo de IA son BEST-EFFORT: si no hay
// ANTHROPIC_API_KEY configurada o la llamada falla, devolvemos un status
// distinto de 'ready' y quien llama sigue funcionando igual. El formulario del
// alumno nunca debe romperse porque la IA no esté disponible.

import Anthropic from '@anthropic-ai/sdk';

// El constructor no lanza si falta la clave (deja apiKey en null): solo fallan
// las requests. Por eso es seguro construirlo a nivel de módulo.
export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export function hasAnthropicKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Modelo por defecto de todo el módulo, configurable por entorno.
export const AI_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

export type AiStatus = 'ready' | 'skipped' | 'error';

export interface AiResult<T> {
  data: T | null;
  status: AiStatus;
  error?: string;
}

export interface AskClaudeJsonOptions {
  system: string;
  prompt: string;
  /** JSON Schema de la respuesta. Requiere additionalProperties:false y required. */
  schema: Record<string, unknown>;
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs?: number;
  /** Sólo para los logs, para saber qué llamada falló. */
  label: string;
  /** Override puntual del modelo (por defecto AI_MODEL=opus-4-8). P. ej. la
   *  evaluación de writing del test de nivel usa 'claude-haiku-4-5'. */
  model?: string;
}

/**
 * Le pide a Claude una respuesta que cumpla `schema` y la devuelve parseada.
 *
 * Usa structured outputs (`output_config.format`): la API restringe la salida al
 * esquema, así que no hace falta pedir "responde sólo con JSON" en el prompt ni
 * limpiar bloques markdown de la respuesta.
 */
export async function askClaudeJson<T>(opts: AskClaudeJsonOptions): Promise<AiResult<T>> {
  if (!hasAnthropicKey()) {
    return { data: null, status: 'skipped', error: 'Falta ANTHROPIC_API_KEY' };
  }

  try {
    const message = await anthropic.messages.create(
      {
        model: opts.model ?? AI_MODEL,
        max_tokens: opts.maxTokens,
        // ── Prompt caching ──────────────────────────────────────────────────────
        // El breakpoint de caché va en el SYSTEM prompt (grande y estable entre
        // llamadas: metodología, formato, avatar), NO en el request completo. El
        // texto del usuario (transcript, ficha del alumno) cambia en cada llamada y
        // queda FUERA del prefijo cacheado — que es justo lo que queremos: en la
        // siguiente llamada con el mismo system, ese prefijo se lee del caché (~10%
        // del costo) y solo se cobra el texto nuevo a precio completo.
        //
        // Ojo: auto-cachear el request completo (cache_control al tope del request)
        // pondría el breakpoint en el último bloque = el texto variable del usuario,
        // generando escrituras de caché sin lecturas (sin ahorro). Por eso va acá.
        //
        // Requiere un prefijo mínimo cacheable (~4096 tokens en Opus 4.8); los system
        // prompts más cortos simplemente no cachean (el log de abajo lo muestra en 0).
        system: [
          { type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } },
        ],
        output_config: {
          format: { type: 'json_schema', schema: opts.schema },
          ...(opts.effort ? { effort: opts.effort } : {}),
        },
        messages: [{ role: 'user', content: opts.prompt }],
      },
      { timeout: opts.timeoutMs ?? 120_000 },
    );

    // Monitoreo de caché (una sola vez, común a todos los endpoints de IA; `label`
    // identifica cuál llamó). cache_read alto en llamadas repetidas = está andando.
    // Si cache_read queda en 0 entre llamadas con el mismo system, algo invalida el
    // prefijo o el prompt no llega al mínimo cacheable.
    console.log('[AI Cache]', {
      endpoint: opts.label,
      cache_read: message.usage?.cache_read_input_tokens ?? 0,
      cache_write: message.usage?.cache_creation_input_tokens ?? 0,
      uncached_input: message.usage?.input_tokens ?? 0,
    });

    // Claude puede negarse por seguridad; en ese caso la salida no cumple el esquema.
    if (message.stop_reason === 'refusal') {
      console.error(`[ai:${opts.label}] Claude rechazó la petición.`);
      return { data: null, status: 'error', error: 'La IA rechazó la petición.' };
    }
    if (message.stop_reason === 'max_tokens') {
      console.error(`[ai:${opts.label}] Respuesta truncada por max_tokens (${opts.maxTokens}).`);
      return { data: null, status: 'error', error: 'La respuesta de la IA quedó incompleta.' };
    }

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    if (!text) {
      console.error(`[ai:${opts.label}] Respuesta sin texto utilizable.`);
      return { data: null, status: 'error', error: 'La IA no devolvió contenido.' };
    }

    return { data: JSON.parse(text) as T, status: 'ready' };
  } catch (err: unknown) {
    const msg = describeError(err);
    console.error(`[ai:${opts.label}] Falló la llamada a Claude: ${msg}`);
    return { data: null, status: 'error', error: msg };
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'ANTHROPIC_API_KEY inválida.';
  if (err instanceof Anthropic.RateLimitError) return 'Límite de peticiones alcanzado. Probá de nuevo en un momento.';
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'La IA tardó demasiado en responder.';
  if (err instanceof Anthropic.APIError) return `Error ${err.status ?? ''} de la API: ${err.message}`;
  if (err instanceof SyntaxError) return `La IA devolvió un JSON inválido: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
