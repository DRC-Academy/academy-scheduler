import { describe, expect, it } from 'vitest';
import {
  requestsForPair, recordingItems, requestCopy, describeItem, longDate, uploadSentence, type PairForRequest,
} from '@/lib/testimonialRequests';

const pair = (beforeTeacher: string | null, afterTeacher: string | null): PairForRequest => ({
  studentName: 'Sonia Becerra',
  before: { teacherId: beforeTeacher, classNumber: 4, classDate: '2026-07-14', excerptAt: '3:15', fathomUrl: 'https://fathom.video/share/a' },
  after:  { teacherId: afterTeacher,  classNumber: 22, classDate: '2026-09-28', excerptAt: '12:40', fathomUrl: null },
});

describe('requestsForPair', () => {
  it('mismo profe: un solo aviso con las dos grabaciones', () => {
    expect(requestsForPair(pair('t1', 't1'))).toEqual([{ teacherId: 't1', sides: ['antes', 'despues'] }]);
  });
  it('cambió de profe: cada uno la suya', () => {
    expect(requestsForPair(pair('t1', 't2'))).toEqual([
      { teacherId: 't1', sides: ['antes'] },
      { teacherId: 't2', sides: ['despues'] },
    ]);
  });
  it('una clase sin profe no genera aviso', () => {
    expect(requestsForPair(pair(null, 't2'))).toEqual([{ teacherId: 't2', sides: ['despues'] }]);
  });
});

describe('textos del aviso', () => {
  it('fecha en palabras, sin zonas horarias', () => {
    expect(longDate('2026-04-16')).toBe('16 de abril');
    expect(longDate('2026-06-01')).toBe('1 de junio');
  });

  it('detalle de cada grabación: clase, fecha y minuto', () => {
    const [it0] = recordingItems(pair('t1', 't1'), ['antes']);
    expect(describeItem(it0)).toBe('Clase 4 · 14 de julio · momento clave en el minuto 3:15');
  });

  it('mismo profe: "Ignacio, sube la clase del … y la del …", en orden', () => {
    const c = requestCopy('Sonia Becerra', recordingItems(pair('t1', 't1'), ['despues', 'antes']), 'Ignacio Lauridia Polo');
    expect(c.title).toBe('Grabación para testimonio: Sonia Becerra');
    expect(c.body).toBe(
      'Ignacio, sube la clase del 14 de julio y la del 28 de septiembre de Sonia Becerra a la pestaña «Testimoniales» del sheet de grabaciones. ' +
      'Sonia ha mejorado mucho su fluidez y queremos usarlo como testimonio. Cuando las subas, pulsa «Grabación subida» en tus avisos.',
    );
  });

  it('una sola grabación: singular', () => {
    const c = requestCopy('Sonia Becerra', recordingItems(pair('t1', 't2'), ['despues']), 'Mauricio');
    expect(c.body.startsWith('Mauricio, sube la clase del 28 de septiembre de Sonia Becerra')).toBe(true);
    expect(c.body).toContain('Cuando la subas');
  });

  it('sin nombre del profe: "Sube la clase…"', () => {
    expect(uploadSentence(null, 'Sonia Becerra', recordingItems(pair('t1', 't1'), ['antes'])))
      .toBe('Sube la clase del 14 de julio de Sonia Becerra');
  });
});
