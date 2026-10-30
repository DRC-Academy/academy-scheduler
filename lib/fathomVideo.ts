// Testimoniales — el VIDEO de una clase a partir de su enlace público de Fathom.
//
// No hay acceso a las cuentas de Fathom de los profesores ni a su API. Lo que sí
// hay es el enlace compartido que el profe pega con el transcript
// (`https://fathom.video/share/<id>`), y esa página, sin iniciar sesión, trae:
//
//   "video_url":"https://fathom.video/share/<id>/video.m3u8"   (lista HLS)
//   "access":"external_view_only", "duration":3357.49, "state":"finalized"
//
// La lista HLS es pública: trozos .ts de 6 s (video 1280x720 + audio AAC mono)
// que redirigen a Google Cloud Storage con una firma temporal. Para un clip se
// bajan SOLO los trozos que lo cubren (+1 de margen) y ffmpeg corta ahí el audio y
// los fotogramas: nunca la clase entera. Medido el 30/10/2026 con 10 enlaces de
// 10 profes: 10/10, 4-5 s y 2-6 MB por recorte de 20 s.
//
// Las funciones puras (parseSharePage, parsePlaylist, chunksFor, classifyShareUrl)
// tienen test; readFathomShare y cutClip hacen red y disco. SOLO SERVIDOR.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const PAGE_TIMEOUT_MS = 15_000;
const CHUNK_TIMEOUT_MS = 20_000;

/** Por qué no se pudo leer un enlace. Solo 'error' cuenta para la alarma de fuente. */
export type FathomFailure = 'privado' | 'borrado' | 'error';

export interface FathomSource {
  shareUrl: string;
  videoUrl: string;
  durationS: number | null;
  access: string | null;
}

export type FathomRead =
  | { ok: true; source: FathomSource; ms: number }
  | { ok: false; cause: FathomFailure; detail: string; ms: number };

// ── Puras ────────────────────────────────────────────────────────────────────

/**
 * El enlace compartido sin parámetros, o por qué no sirve sin abrirlo:
 * `/calls/…` es la grabación dentro de la cuenta del profe (pide sesión).
 */
export function classifyShareUrl(url: string | null | undefined): { shareUrl: string } | { cause: FathomFailure; detail: string } {
  if (!url) return { cause: 'borrado', detail: 'La clase no trae enlace de Fathom.' };
  let u: URL;
  try { u = new URL(url); } catch { return { cause: 'borrado', detail: 'El enlace de Fathom no es una dirección válida.' }; }
  if (!/(^|\.)fathom\.video$/i.test(u.hostname)) return { cause: 'borrado', detail: 'El enlace no es de Fathom.' };
  const m = u.pathname.match(/^\/share\/([^/]+)\/?$/);
  if (!m) {
    return /^\/calls\//.test(u.pathname)
      ? { cause: 'privado', detail: 'Es el enlace interno de la cuenta del profe (/calls/), no el compartido.' }
      : { cause: 'borrado', detail: 'El enlace no tiene la forma fathom.video/share/….' };
  }
  return { shareUrl: `https://fathom.video/share/${m[1]}` };
}

const unescapeHtml = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** Lo que interesa de la página compartida (los datos van en JSON dentro del HTML). */
export function parseSharePage(html: string): { videoUrl: string | null; durationS: number | null; access: string | null; state: string | null } {
  const h = unescapeHtml(html ?? '');
  const str = (k: string) => (h.match(new RegExp(`"${k}":"([^"]*)"`)) ?? [])[1] ?? null;
  const num = (k: string) => {
    const v = Number((h.match(new RegExp(`"${k}":([0-9.]+)`)) ?? [])[1]);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const videoUrl = str('video_url');
  return { videoUrl: videoUrl ? videoUrl.replace(/\\\//g, '/') : null, durationS: num('duration'), access: str('access'), state: str('state') };
}

export interface HlsChunk { start: number; duration: number; uri: string }

/** Trozos de una lista HLS con su segundo de inicio, en direcciones absolutas. */
export function parsePlaylist(text: string, playlistUrl: string): HlsChunk[] {
  const lines = (text ?? '').split(/\r?\n/);
  const out: HlsChunk[] = [];
  let t = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXTINF:')) continue;
    const d = parseFloat(lines[i].slice(8));
    const uri = (lines[i + 1] ?? '').trim();
    if (!Number.isFinite(d) || !uri || uri.startsWith('#')) continue;
    out.push({ start: t, duration: d, uri: new URL(uri, playlistUrl).href });
    t += d;
  }
  return out;
}

/**
 * Trozos que cubren [startS, startS + durS] más un trozo de margen al final: sin
 * él, el último fotograma a veces no se puede decodificar (medido: 3 de 10).
 */
export function chunksFor(chunks: HlsChunk[], startS: number, durS: number): HlsChunk[] {
  const i0 = chunks.findIndex(c => c.start + c.duration > startS);
  if (i0 < 0) return [];
  let i1 = i0;
  while (i1 + 1 < chunks.length && chunks[i1 + 1].start < startS + durS) i1++;
  return chunks.slice(i0, Math.min(chunks.length, i1 + 2));
}

// ── Red ──────────────────────────────────────────────────────────────────────

/** Abre la página compartida sin sesión. Nunca lanza: devuelve la causa. */
export async function readFathomShare(url: string | null | undefined): Promise<FathomRead> {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  const c = classifyShareUrl(url);
  if ('cause' in c) return { ok: false, cause: c.cause, detail: c.detail, ms: ms() };
  try {
    const res = await fetch(c.shareUrl, { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    if (res.status === 404 || res.status === 410) return { ok: false, cause: 'borrado', detail: `Fathom responde ${res.status}: la grabación no existe o se borró.`, ms: ms() };
    if (res.status === 401 || res.status === 403) return { ok: false, cause: 'privado', detail: `Fathom responde ${res.status}: la grabación no es pública.`, ms: ms() };
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') ?? '';
      return /login|sign[_-]?in|auth/i.test(loc)
        ? { ok: false, cause: 'privado', detail: 'Fathom pide iniciar sesión para ver la grabación.', ms: ms() }
        : { ok: false, cause: 'error', detail: `Fathom redirige a ${loc || 'otra página'}.`, ms: ms() };
    }
    if (!res.ok) return { ok: false, cause: 'error', detail: `Fathom responde ${res.status}.`, ms: ms() };
    const page = parseSharePage(await res.text());
    if (!page.videoUrl) {
      return { ok: false, cause: 'error', detail: 'La página de Fathom abrió pero no trae la dirección del video (¿cambió la página?).', ms: ms() };
    }
    return { ok: true, source: { shareUrl: c.shareUrl, videoUrl: page.videoUrl, durationS: page.durationS, access: page.access }, ms: ms() };
  } catch (err) {
    return { ok: false, cause: 'error', detail: `No se pudo abrir Fathom: ${err instanceof Error ? err.message : String(err)}`, ms: ms() };
  }
}

// ── Recorte ──────────────────────────────────────────────────────────────────

export interface CutResult {
  /** MP3 mono 16 kHz, lo justo para transcribir. */
  audio: Buffer;
  /** JPEG del inicio, la mitad y el final del tramo, a 1280 px (los nombres de Meet se leen). */
  frames: Buffer[];
  startS: number;
  durS: number;
  chunks: number;
  bytes: number;
  ms: { playlist: number; download: number; ffmpeg: number };
}

export class FathomCutError extends Error {
  constructor(message: string, readonly failure: FathomFailure) { super(message); }
}

function ffmpegPath(): string {
  // ffmpeg-static usa __dirname: va en serverExternalPackages (next.config.ts) y el
  // binario se añade a la función con outputFileTracingIncludes.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('ffmpeg-static') as string | null;
  if (!p) throw new FathomCutError('ffmpeg no está disponible en este servidor.', 'error');
  return p;
}

/** Baja solo el tramo [startS, startS + durS] y saca el audio y 3 fotogramas. */
export async function cutClip(source: FathomSource, startS: number, durS: number): Promise<CutResult> {
  const t0 = Date.now();
  const pl = await fetch(source.videoUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
  if (!pl.ok) throw new FathomCutError(`La lista del video responde ${pl.status}.`, pl.status === 404 ? 'borrado' : 'error');
  const all = parsePlaylist(await pl.text(), source.videoUrl);
  const total = all.length ? all[all.length - 1].start + all[all.length - 1].duration : 0;
  const start = Math.max(0, Math.min(startS, total - durS));
  const need = chunksFor(all, start, durS);
  if (!need.length) throw new FathomCutError('La lista del video está vacía o el tramo cae fuera de la grabación.', 'error');
  const tPlaylist = Date.now() - t0;

  const t1 = Date.now();
  const bufs = await Promise.all(need.map(async c => {
    const r = await fetch(c.uri, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS) });
    if (!r.ok) throw new FathomCutError(`Un trozo del video responde ${r.status}.`, 'error');
    return Buffer.from(await r.arrayBuffer());
  }));
  const raw = Buffer.concat(bufs);
  const tDownload = Date.now() - t1;

  const t2 = Date.now();
  const dir = await mkdtemp(join(tmpdir(), 'clip-'));
  try {
    const rawPath = join(dir, 'raw.ts');
    await writeFile(rawPath, raw);
    const ff = ffmpegPath();
    // -ss DESPUÉS de -i: corta por tiempo real del archivo (antes de -i, con los
    // trozos concatenados, a veces salían 15 s en vez de 20).
    const off = (start - need[0].start).toFixed(2);
    await run(ff, ['-v', 'error', '-y', '-i', rawPath, '-ss', off, '-t', String(durS),
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', join(dir, 'clip.mp3')]);
    const at = [0.5, durS / 2, Math.max(0.5, durS - 0.5)];
    await Promise.all(at.map((s, i) => run(ff, ['-v', 'error', '-y', '-i', rawPath, '-ss', (start - need[0].start + s).toFixed(2),
      '-frames:v', '1', '-q:v', '4', join(dir, `f${i}.jpg`)])));
    const audio = await readFile(join(dir, 'clip.mp3'));
    const frames = await Promise.all(at.map((_, i) => readFile(join(dir, `f${i}.jpg`)).catch(() => null)));
    return {
      audio, frames: frames.filter((f): f is NonNullable<typeof f> => !!f && f.length > 0),
      startS: start, durS, chunks: need.length, bytes: raw.length,
      ms: { playlist: tPlaylist, download: tDownload, ffmpeg: Date.now() - t2 },
    };
  } catch (err) {
    if (err instanceof FathomCutError) throw err;
    throw new FathomCutError(`ffmpeg no pudo cortar el clip: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`, 'error');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
