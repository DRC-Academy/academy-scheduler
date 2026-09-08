// El sistema de riesgo tiene DOS niveles: verde y rojo.
//
// El amarillo ("atención") se retiró entero: era una señal débil que generaba
// aviso, incomodaba al profesor y no distinguía nada accionable. El aviso queda
// reservado a lo crítico.
//
// La parte delicada NO es que el amarillo deje de generarse —eso lo garantiza el
// esquema de la IA—, sino qué pasa con lo que YA está guardado: 44 fichas y 34
// alertas abiertas en amarillo. Nada de eso se migra ni se borra. Estos tests
// fijan que caen a verde solas y dejan de avisar, sin romperse por el camino.

import { describe, expect, it } from 'vitest';
import { RISK_META, isRiskSignal, type RiskSignal } from './aiTypes';
import { SEV_OF, SEV, type Severity } from './riskInbox';
import { asIntervention, protocolFor, fallbackSteps, FALLBACK_STEPS_ROJO } from './interventions';
import { RISK_TEXT } from '@/components/alumnos/ui';

// ── La señal solo tiene dos valores ──────────────────────────────────────────

describe('RiskSignal', () => {
  it('acepta verde y rojo', () => {
    expect(isRiskSignal('verde')).toBe(true);
    expect(isRiskSignal('rojo')).toBe(true);
  });

  it('RECHAZA amarillo, incluido el que sigue guardado en la base', () => {
    expect(isRiskSignal('amarillo')).toBe(false);
  });

  it('rechaza cualquier otra cosa', () => {
    for (const v of [null, undefined, '', 'naranja', 'VERDE', 0, {}]) {
      expect(isRiskSignal(v)).toBe(false);
    }
  });

  it('las 44 fichas en amarillo caen a VERDE con el patrón que usan los lectores', () => {
    const leer = (raw: unknown): RiskSignal => (isRiskSignal(raw) ? raw : 'verde');
    expect(leer('amarillo')).toBe('verde');
    expect(leer('rojo')).toBe('rojo');
    expect(leer(null)).toBe('verde');
  });
});

// ── Nada visual queda del amarillo ───────────────────────────────────────────

describe('sin rastro visual del amarillo', () => {
  it('RISK_META solo tiene verde y rojo', () => {
    expect(Object.keys(RISK_META).sort()).toEqual(['rojo', 'verde']);
  });

  it('RISK_TEXT (el punto de color de la ficha) solo tiene verde y rojo', () => {
    expect(Object.keys(RISK_TEXT).sort()).toEqual(['rojo', 'verde']);
  });

  it('ningún color del amarillo DRC sobrevive en la paleta del riesgo', () => {
    const colores = [
      ...Object.values(RISK_META).flatMap(m => [m.color, m.bg, m.border]),
      ...Object.values(RISK_TEXT).map(m => m.color),
      ...Object.values(SEV).flatMap(s => [s.accent, s.bg, s.bd, s.fg]),
    ].join(' ').toUpperCase();
    expect(colores).not.toContain('FFC400');   // amarillo DRC
    expect(colores).not.toContain('255,196,0');
  });

  it('no queda ninguna etiqueta "Atención"', () => {
    const etiquetas = [
      ...Object.values(RISK_META).map(m => m.label),
      ...Object.values(RISK_TEXT).map(m => m.label),
      ...Object.values(SEV).map(s => s.label),
    ];
    expect(etiquetas.some(l => /atenci[oó]n/i.test(l))).toBe(false);
  });
});

// ── Severidad: se acabó el nivel intermedio ──────────────────────────────────

describe('Severity', () => {
  it('solo hay riesgo y buen camino', () => {
    const claves: Severity[] = ['riesgo', 'buen'];
    expect(Object.keys(SEV).sort()).toEqual([...claves].sort());
  });

  it('rojo va a la cola y verde no', () => {
    expect(SEV_OF.rojo).toBe('riesgo');
    expect(SEV_OF.verde).toBe('buen');
    expect(Object.keys(SEV_OF).sort()).toEqual(['rojo', 'verde']);
  });

  it('un alumno en verde con historial de auditorías tiene estilo propio, no el del amarillo', () => {
    // La pestaña "Verificar intervenciones" lista por auditorías, así que puede
    // traer un alumno que hoy está bien. Antes caía en el estilo del amarillo.
    expect(SEV.buen.label).toBe('En buen camino');
    expect(SEV.buen.accent).not.toBe(SEV.riesgo.accent);
  });
});

// ── Las 34 alertas abiertas en amarillo dejan de existir ─────────────────────

describe('asIntervention', () => {
  const base = {
    action: 'Podrías preguntarle cómo lleva el inglés últimamente.',
    steps: ['Podrías recibirlo con normalidad.', 'Quizá ayude bajar el ritmo.'],
    reconnectHook: '',
    escalateToSupport: false,
    channel: 'en_clase',
  };

  it('reconoce una alerta ROJA', () => {
    const a = asIntervention({ ...base, risk: 'rojo' });
    expect(a).not.toBeNull();
    expect(a!.risk).toBe('rojo');
  });

  it('NO reconoce una alerta amarilla: deja de existir sin tocar la base', () => {
    expect(asIntervention({ ...base, risk: 'amarillo' })).toBeNull();
  });

  it('tampoco reconoce una alerta sin color, ni en verde', () => {
    expect(asIntervention({ ...base })).toBeNull();
    expect(asIntervention({ ...base, risk: 'verde' })).toBeNull();
  });

  it('acepta el jsonb venga como objeto o como cadena', () => {
    expect(asIntervention(JSON.stringify({ ...base, risk: 'rojo' }))).not.toBeNull();
    expect(asIntervention(JSON.stringify({ ...base, risk: 'amarillo' }))).toBeNull();
  });

  it('lo vacío o ilegible sigue dando null, sin lanzar', () => {
    expect(asIntervention(null)).toBeNull();
    expect(asIntervention('no es json')).toBeNull();
    expect(asIntervention({})).toBeNull();
  });
});

// ── El protocolo del pop-up se mantiene, y ya no depende del color ───────────

describe('protocolFor', () => {
  it('respeta los pasos que dejó la IA', () => {
    const pasos = ['Podrías arrancar con algo que domine.', 'Quizá ayude bajar el ritmo.'];
    const p = protocolFor(pasos);
    expect(p.steps).toEqual(pasos);
    expect(p.isFallback).toBe(false);
  });

  it('cae al protocolo de CONTENCIÓN cuando no hay pasos utilizables', () => {
    const p = protocolFor([]);
    expect(p.isFallback).toBe(true);
    expect(p.steps).toEqual(FALLBACK_STEPS_ROJO);
  });

  it('ya no hay un segundo juego de pasos: el respaldo es siempre el mismo', () => {
    expect(fallbackSteps()).toEqual(FALLBACK_STEPS_ROJO);
    expect(protocolFor(null).steps).toEqual(fallbackSteps());
  });

  it('los pasos de contención siguen siendo sugerencias, nunca imperativos', () => {
    for (const paso of FALLBACK_STEPS_ROJO) {
      expect(/podrías|quizá|una opción|una buena forma/i.test(paso)).toBe(true);
    }
  });
});
