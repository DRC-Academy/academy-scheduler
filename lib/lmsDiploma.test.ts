// La puerta hacia el LMS es best-effort: lo que estos tests fijan es que ante
// cualquier fallo sale `null` (nunca una excepción), que la respuesta se valida,
// y que la caché de 60 s y la deduplicación evitan despertar al LMS de más.
import { describe, it, expect, beforeEach } from 'vitest';
import { getLmsDiploma, parseDiploma, _resetLmsDiploma, LMS_CACHE_MS, LMS_SECRET_HEADER } from './lmsDiploma';

const OK = { estado: 'en-curso', completadas: 60, total: 182, restantes: 122, curso: { slug: 'b1', titulo: 'B1' } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Un fetch de mentira que cuenta llamadas y responde lo que se le diga. */
function fakeFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { f, calls };
}

const base = { url: 'https://lms.test', secret: 's3cr3t' };

beforeEach(() => _resetLmsDiploma());

describe('parseDiploma: solo entra la forma acordada', () => {
  it('acepta los tres estados y normaliza los números', () => {
    expect(parseDiploma(OK)).toEqual(OK);
    expect(parseDiploma({ estado: 'conseguido', completadas: 187, total: 187, restantes: 0, curso: { slug: 'a2', titulo: 'A2' } })?.estado).toBe('conseguido');
    expect(parseDiploma({ estado: 'sin-curso', completadas: 0, total: 0, restantes: 0, curso: null })).toEqual({ estado: 'sin-curso', completadas: 0, total: 0, restantes: 0, curso: null });
  });

  it('rechaza estados desconocidos, números que no lo son y cursos a medias', () => {
    expect(parseDiploma(null)).toBeNull();
    expect(parseDiploma({ ...OK, estado: 'terminado' })).toBeNull();
    expect(parseDiploma({ ...OK, completadas: '60' })).toBeNull();
    expect(parseDiploma({ ...OK, total: -1 })).toBeNull();
    expect(parseDiploma({ ...OK, curso: { slug: 'b1' } })).toBeNull();
    expect(parseDiploma({ error: 'alumno_id_requerido' })).toBeNull();
  });
});

describe('getLmsDiploma: nunca lanza', () => {
  it('pide con el secreto en la cabecera y devuelve el diploma', async () => {
    const { f, calls } = fakeFetch(() => json(OK));
    expect(await getLmsDiploma('s_1', { ...base, fetchImpl: f })).toEqual(OK);
    expect(calls[0].url).toBe('https://lms.test/api/externo/diploma?alumno_id=s_1');
    expect((calls[0].init?.headers as Record<string, string>)[LMS_SECRET_HEADER]).toBe('s3cr3t');
    expect(calls[0].init?.cache).toBe('no-store');
  });

  it('null si el LMS responde con error, con otra forma, o la red falla', async () => {
    expect(await getLmsDiploma('s_1', { ...base, fetchImpl: fakeFetch(() => json({ error: 'no' }, 401)).f })).toBeNull();
    expect(await getLmsDiploma('s_2', { ...base, fetchImpl: fakeFetch(() => json({ estado: 'raro' })).f })).toBeNull();
    expect(await getLmsDiploma('s_3', { ...base, fetchImpl: fakeFetch(() => { throw new Error('ECONNRESET'); }).f })).toBeNull();
    expect(await getLmsDiploma('s_4', { ...base, fetchImpl: fakeFetch(() => Promise.reject(new TypeError('fetch failed'))).f })).toBeNull();
  });

  it('null al vencer el timeout, sin esperar a que el LMS conteste', async () => {
    // Un LMS que solo responde cuando se lo aborta.
    const { f } = fakeFetch((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    }));
    const t0 = Date.now();
    expect(await getLmsDiploma('s_1', { ...base, fetchImpl: f, timeoutMs: 30 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('null sin configuración, sin llamar a nada', async () => {
    const { f, calls } = fakeFetch(() => json(OK));
    expect(await getLmsDiploma('s_1', { url: '', secret: '', fetchImpl: f })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await getLmsDiploma('   ', { ...base, fetchImpl: f })).toBeNull();
  });
});

describe('caché de 60 s y una sola llamada en vuelo', () => {
  it('la segunda petición dentro del minuto no toca el LMS; pasado el minuto, sí', async () => {
    let t = 1_000_000;
    const { f, calls } = fakeFetch(() => json(OK));
    const deps = { ...base, fetchImpl: f, now: () => t };
    await getLmsDiploma('s_1', deps);
    t += LMS_CACHE_MS - 1;
    await getLmsDiploma('s_1', deps);
    expect(calls).toHaveLength(1);
    t += 2;
    await getLmsDiploma('s_1', deps);
    expect(calls).toHaveLength(2);
  });

  it('la caché es por alumno y los fallos no se cachean', async () => {
    let fallar = true;
    const { f, calls } = fakeFetch(() => (fallar ? json({}, 500) : json(OK)));
    expect(await getLmsDiploma('s_1', { ...base, fetchImpl: f })).toBeNull();
    fallar = false;
    expect(await getLmsDiploma('s_1', { ...base, fetchImpl: f })).toEqual(OK);
    await getLmsDiploma('s_2', { ...base, fetchImpl: f });
    expect(calls).toHaveLength(3);
  });

  it('dos fichas del mismo alumno a la vez comparten una llamada', async () => {
    let resolver: (r: Response) => void = () => {};
    const { f, calls } = fakeFetch(() => new Promise<Response>(r => { resolver = r; }));
    const a = getLmsDiploma('s_1', { ...base, fetchImpl: f });
    const b = getLmsDiploma('s_1', { ...base, fetchImpl: f });
    expect(calls).toHaveLength(1);
    resolver(json(OK));
    expect(await a).toEqual(OK);
    expect(await b).toEqual(OK);
  });
});
