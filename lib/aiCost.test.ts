// Ahorro de IA (oct/2026): modelo económico sin razonamiento previo, misma
// petición para el análisis inmediato y el lote, y aviso del límite de gasto.

import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AI_MODEL, ECONOMY_MODEL, buildClaudeRequest, readClaudeJson, type AskClaudeJsonOptions } from '@/lib/anthropic';
import { transcriptRequestOptions } from '@/lib/analyzeTranscript';
import { isCreditExhaustedError } from '@/lib/aiCreditAlert';
import { needsAnalysis, isAnalysisQueued } from '@/lib/aiTypes';

const OPTS: AskClaudeJsonOptions = {
  label: 'prueba',
  system: 'Sistema',
  prompt: 'Hola',
  schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
  maxTokens: 100,
};

function message(text: string, stop: Anthropic.StopReason = 'end_turn'): Anthropic.Message {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: ECONOMY_MODEL,
    content: [{ type: 'text', text, citations: null }],
    stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}

describe('buildClaudeRequest', () => {
  it('sin modelo ni thinking: el de siempre, sin parámetro thinking', () => {
    const req = buildClaudeRequest(OPTS);
    expect(req.model).toBe(AI_MODEL);
    expect(req).not.toHaveProperty('thinking');
  });

  it("thinking 'off' manda between_tools (Sonnet 5.5 rechaza 'disabled')", () => {
    const req = buildClaudeRequest({ ...OPTS, model: ECONOMY_MODEL, thinking: 'off' });
    expect(req.model).toBe(ECONOMY_MODEL);
    expect(req.thinking).toEqual({ type: 'between_tools' });
  });

  it('el system lleva el breakpoint de caché', () => {
    const req = buildClaudeRequest(OPTS);
    const sys = req.system as Anthropic.TextBlockParam[];
    expect(sys[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('análisis de transcripts', () => {
  const opts = transcriptRequestOptions({ transcript: 'T', studentName: 'Ana', teacherName: 'Sol' });

  it('va con el modelo económico, sin razonamiento y sin reintentos que se paguen', () => {
    expect(opts.model).toBe(ECONOMY_MODEL);
    expect(opts.thinking).toBe('off');
    expect(opts.maxRetries).toBe(0);
  });

  it("su effort es compatible con between_tools ('high' o menor)", () => {
    expect(['low', 'medium', 'high']).toContain(opts.effort);
  });
});

describe('readClaudeJson', () => {
  it('parsea el JSON de la respuesta', () => {
    expect(readClaudeJson<{ a: string }>(message('{"a":"x"}'), OPTS)).toEqual({ data: { a: 'x' }, status: 'ready' });
  });

  it('una respuesta truncada es error, no un JSON a medias', () => {
    expect(readClaudeJson(message('{"a":', 'max_tokens'), OPTS).status).toBe('error');
  });

  it('un JSON roto es error sin lanzar (en el lote no puede tumbar el ciclo)', () => {
    expect(readClaudeJson(message('{"a":'), OPTS).status).toBe('error');
  });
});

describe('isCreditExhaustedError', () => {
  it('reconoce el límite de gasto del espacio de trabajo', () => {
    expect(isCreditExhaustedError('Error 400 de la API: You have reached your specified workspace API usage limits.')).toBe(true);
  });
  it('sigue reconociendo la falta de saldo', () => {
    expect(isCreditExhaustedError('Your credit balance is too low to access the Anthropic API.')).toBe(true);
  });
  it('no confunde otros errores', () => {
    expect(isCreditExhaustedError('Error 400 de la API: max_tokens: Field required')).toBe(false);
  });
});

describe('clase en cola', () => {
  it('no ofrece "Reintentar análisis" (lo analizaría aparte, a precio completo)', () => {
    const row = { id: 'ca_1', analysis_status: 'queued', class_summary: '' } as Parameters<typeof needsAnalysis>[0];
    expect(needsAnalysis(row)).toBe(false);
    expect(isAnalysisQueued(row)).toBe(true);
  });
  it('una fallida sí lo ofrece', () => {
    const row = { id: 'ca_1', analysis_status: 'failed', class_summary: '' } as Parameters<typeof needsAnalysis>[0];
    expect(needsAnalysis(row)).toBe(true);
  });
});
