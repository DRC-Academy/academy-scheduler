import { describe, expect, it } from 'vitest';
import { requestsForPair, recordingItems, requestCopy, describeItem, type PairForRequest } from '@/lib/testimonialRequests';

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
  it('describe clase, fecha y minuto', () => {
    const [it0] = recordingItems(pair('t1', 't1'), ['antes']);
    expect(describeItem(it0)).toBe('la clase 4 (14/07, momento clave en el minuto 3:15)');
  });

  it('dos grabaciones: plural y las dos clases en orden', () => {
    const c = requestCopy('Sonia Becerra', recordingItems(pair('t1', 't1'), ['despues', 'antes']));
    expect(c.title).toBe('Grabación para testimonio: Sonia Becerra');
    expect(c.body).toContain('las grabaciones de la clase 4 (14/07, momento clave en el minuto 3:15) y la clase 22 (28/09, momento clave en el minuto 12:40)');
    expect(c.body).toContain('Súbelas a la pestaña «Testimoniales»');
  });

  it('una grabación: singular', () => {
    const c = requestCopy('Sonia Becerra', recordingItems(pair('t1', 't2'), ['despues']));
    expect(c.body).toContain('la grabación de la clase 22');
    expect(c.body).toContain('Súbela a la pestaña');
  });
});
