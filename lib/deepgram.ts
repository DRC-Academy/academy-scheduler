// Deepgram — transcripción de un clip corto (testimoniales). SOLO SERVIDOR.
//
// Según la documentación de Deepgram (developers.deepgram.com, oct/2026):
//   · POST https://api.deepgram.com/v1/listen, audio en bruto en el cuerpo con su
//     Content-Type; la clave va como `Authorization: Token <clave>` (no Bearer).
//   · model=nova-3; language=multi = inglés/español mezclados, con `language` en
//     cada palabra; detect_language=en&detect_language=es = un idioma para todo el
//     clip, con `detected_language` y `language_confidence` en el canal.
//   · diarize_model=latest separa voces (`speaker` por palabra). `diarize=true`
//     está obsoleto y mandar los dos da error.
//   · filler_words=true deja "um", "uh"… (la doc solo lo da para inglés).
//
// La clave vive SOLO en Vercel (DEEPGRAM_API_KEY, Production y Preview).

const ENDPOINT = 'https://api.deepgram.com/v1/listen';
const TIMEOUT_MS = 30_000;

export interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: number;
  speaker_confidence?: number;
  language?: string;
}

export interface DeepgramTranscript {
  requestId: string | null;
  durationS: number | null;
  transcript: string;
  words: DeepgramWord[];
  /** language=multi: idiomas del clip ordenados por número de palabras. */
  languages: string[] | null;
  /** detect_language: idioma de todo el clip y su confianza (0-1). */
  detectedLanguage: string | null;
  languageConfidence: number | null;
  /** Modelos que contestaron (metadata.model_info), para comprobar qué se usó. */
  models: string[];
}

export class DeepgramError extends Error {
  constructor(message: string, readonly status: number | null, readonly body?: string) { super(message); }
}

export type DeepgramParams = Record<string, string | number | boolean | Array<string | number | boolean>>;

/** Query string con parámetros repetidos para las listas (detect_language=en&detect_language=es). */
export function deepgramQuery(params: DeepgramParams): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) for (const x of Array.isArray(v) ? v : [v]) q.append(k, String(x));
  return q.toString();
}

type Json = Record<string, unknown>;

/** Lo que usamos de la respuesta (primer canal, primera alternativa). Puro. */
export function readDeepgramResponse(body: Json): DeepgramTranscript {
  const meta = (body.metadata ?? {}) as Json;
  const channel = (((body.results as Json | undefined)?.channels as Json[] | undefined) ?? [])[0] ?? {};
  const alt = ((channel.alternatives as Json[] | undefined) ?? [])[0] ?? {};
  const info = (meta.model_info ?? {}) as Record<string, { name?: string; version?: string; arch?: string }>;
  return {
    requestId: (meta.request_id as string | undefined) ?? null,
    durationS: typeof meta.duration === 'number' ? meta.duration : null,
    transcript: String(alt.transcript ?? ''),
    words: ((alt.words as DeepgramWord[] | undefined) ?? []),
    languages: Array.isArray(alt.languages) ? (alt.languages as string[]) : null,
    detectedLanguage: (channel.detected_language as string | undefined) ?? null,
    languageConfidence: typeof channel.language_confidence === 'number' ? channel.language_confidence : null,
    models: Object.values(info).map(m => [m.name, m.version, m.arch].filter(Boolean).join(' ')),
  };
}

/** Transcribe un audio corto. Lanza DeepgramError con el cuerpo de la respuesta si falla. */
export async function transcribeAudio(audio: Buffer, params: DeepgramParams, contentType = 'audio/mpeg'): Promise<DeepgramTranscript> {
  const key = process.env.DEEPGRAM_API_KEY?.trim();
  if (!key) throw new DeepgramError('Falta DEEPGRAM_API_KEY en este entorno.', null);
  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}?${deepgramQuery(params)}`, {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': contentType },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new DeepgramError(`No se pudo llamar a Deepgram: ${err instanceof Error ? err.message : String(err)}`, null);
  }
  const text = await res.text();
  if (!res.ok) throw new DeepgramError(`Deepgram responde ${res.status}.`, res.status, text.slice(0, 600));
  try {
    return readDeepgramResponse(JSON.parse(text) as Json);
  } catch {
    throw new DeepgramError('Deepgram devolvió algo que no es JSON.', res.status, text.slice(0, 600));
  }
}
