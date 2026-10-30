import { describe, expect, it } from 'vitest';
import { classifyShareUrl, parseSharePage, parsePlaylist, chunksFor } from '@/lib/fathomVideo';
import { deepgramQuery, readDeepgramResponse } from '@/lib/deepgram';

describe('classifyShareUrl', () => {
  it('deja el enlace compartido sin parámetros', () => {
    expect(classifyShareUrl('https://fathom.video/share/cUxA6xiqSbN8LcyqMsN1JMg2wpPMvffn?timestamp=3083'))
      .toEqual({ shareUrl: 'https://fathom.video/share/cUxA6xiqSbN8LcyqMsN1JMg2wpPMvffn' });
  });
  it('/calls/ es privado; sin enlace u otra web, borrado', () => {
    expect(classifyShareUrl('https://fathom.video/calls/123')).toMatchObject({ cause: 'privado' });
    expect(classifyShareUrl(null)).toMatchObject({ cause: 'borrado' });
    expect(classifyShareUrl('https://example.com/share/abc')).toMatchObject({ cause: 'borrado' });
    expect(classifyShareUrl('no es url')).toMatchObject({ cause: 'borrado' });
  });
});

describe('parseSharePage', () => {
  it('lee video_url, duración y acceso del JSON escapado en el HTML', () => {
    const html = '<div data-page="{&quot;access&quot;:&quot;external_view_only&quot;,&quot;state&quot;:&quot;finalized&quot;,'
      + '&quot;video_url&quot;:&quot;https://fathom.video/share/abc/video.m3u8&quot;,&quot;duration&quot;:3357.498}">';
    expect(parseSharePage(html)).toEqual({
      videoUrl: 'https://fathom.video/share/abc/video.m3u8', durationS: 3357.498, access: 'external_view_only', state: 'finalized',
    });
  });
  it('sin video_url devuelve null', () => {
    expect(parseSharePage('<html>Sign in</html>').videoUrl).toBeNull();
  });
});

describe('parsePlaylist + chunksFor', () => {
  const m3u8 = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-DISCONTINUITY',
    ...Array.from({ length: 10 }, (_, i) => [`#EXTINF:6.000000,`, `/share/abc/video_chunk?key=c${i}.ts`]).flat(), '#EXT-X-ENDLIST'].join('\n');
  const chunks = parsePlaylist(m3u8, 'https://fathom.video/share/abc/video.m3u8');

  it('calcula el inicio de cada trozo y la dirección absoluta', () => {
    expect(chunks).toHaveLength(10);
    expect(chunks[3]).toEqual({ start: 18, duration: 6, uri: 'https://fathom.video/share/abc/video_chunk?key=c3.ts' });
  });
  it('20 s desde el segundo 13 = trozos 12-36 más uno de margen', () => {
    expect(chunksFor(chunks, 13, 20).map(c => c.start)).toEqual([12, 18, 24, 30, 36]);
  });
  it('al final de la grabación no se sale de la lista', () => {
    expect(chunksFor(chunks, 50, 20).map(c => c.start)).toEqual([48, 54]);
    expect(chunksFor(chunks, 70, 20)).toEqual([]);
  });
});

describe('Deepgram', () => {
  it('repite los parámetros de lista (detect_language=en&detect_language=es)', () => {
    expect(deepgramQuery({ model: 'nova-3', detect_language: ['en', 'es'], filler_words: true }))
      .toBe('model=nova-3&detect_language=en&detect_language=es&filler_words=true');
  });
  it('lee idioma, voces y palabras de la respuesta', () => {
    const t = readDeepgramResponse({
      metadata: { request_id: 'r1', duration: 20.1, model_info: { u: { name: 'general-nova-3', version: '1', arch: 'nova-3' } } },
      results: { channels: [{
        detected_language: 'en', language_confidence: 0.97,
        alternatives: [{ transcript: 'um I went', languages: ['en'], words: [{ word: 'um', start: 0, end: 0.3, confidence: 0.9, speaker: 0 }] }],
      }] },
    });
    expect(t).toMatchObject({ requestId: 'r1', durationS: 20.1, detectedLanguage: 'en', languageConfidence: 0.97, languages: ['en'], transcript: 'um I went' });
    expect(t.words[0].speaker).toBe(0);
    expect(t.models).toEqual(['general-nova-3 1 nova-3']);
  });
});
