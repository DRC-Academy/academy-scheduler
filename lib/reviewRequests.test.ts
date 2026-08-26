// Aprobar una solicitud de revisión resuelve la señal `sin_acceso_registrado`
// —que se dispara por el ingreso que falta y que la aprobación acaba de crear—
// pero NO es un pase libre: cualquier otra señal mantiene el transcript en la
// cola de validación.
import { describe, it, expect } from 'vitest';
import { statusAfterAccessResolved } from '@/lib/reviewRequests';

describe('statusAfterAccessResolved', () => {
  it('aprueba cuando sin_acceso_registrado era la única señal', () => {
    const r = statusAfterAccessResolved({
      validationStatus: 'review', score: 95, flags: ['sin_acceso_registrado'],
    });
    expect(r).toEqual({ nextStatus: 'auto_approved', removedFlag: 'sin_acceso_registrado' });
  });

  it('NO aprueba si además hay una señal de contenido', () => {
    for (const otra of ['demasiado_corto', 'sin_timestamps', 'prosa_demasiado_limpia', 'sin_habla_natural', 'ia_no_autentico']) {
      expect(statusAfterAccessResolved({
        validationStatus: 'review', score: 95, flags: ['sin_acceso_registrado', otra],
      }), otra).toBeNull();
    }
  });

  it('NO aprueba si el score no llega al umbral de auto-aprobación', () => {
    expect(statusAfterAccessResolved({
      validationStatus: 'review', score: 40, flags: ['sin_acceso_registrado'],
    })).toBeNull();
  });

  it('no hace nada si el transcript no tenía esa señal', () => {
    expect(statusAfterAccessResolved({
      validationStatus: 'review', score: 95, flags: ['demasiado_corto'],
    })).toBeNull();
  });

  it('no toca lo que ya estaba aprobado ni rechazado', () => {
    for (const estado of ['ok', 'auto_approved', 'approved', 'rejected']) {
      expect(statusAfterAccessResolved({
        validationStatus: estado, score: 95, flags: ['sin_acceso_registrado'],
      }), estado).toBeNull();
    }
  });

  it('tolera flags nulos o vacíos', () => {
    expect(statusAfterAccessResolved({ validationStatus: 'review', score: 95, flags: null })).toBeNull();
    expect(statusAfterAccessResolved({ validationStatus: 'review', score: 95, flags: [] })).toBeNull();
  });

  it('registro_tardio no retiene: tampoco habla del texto', () => {
    // Igual que sin_acceso_registrado, es una señal sobre NUESTRO registro.
    const r = statusAfterAccessResolved({
      validationStatus: 'review', score: 90, flags: ['sin_acceso_registrado', 'registro_tardio'],
    });
    expect(r?.nextStatus).toBe('auto_approved');
  });

  it('alta_similitud es informativa y tampoco retiene', () => {
    const r = statusAfterAccessResolved({
      validationStatus: 'review', score: 90, flags: ['sin_acceso_registrado', 'alta_similitud'],
    });
    expect(r?.nextStatus).toBe('auto_approved');
  });
});
