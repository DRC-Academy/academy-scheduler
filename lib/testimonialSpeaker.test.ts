import { describe, expect, it } from 'vitest';
import {
  nameMatchesStrict, resolveStudentLabel, studentInterventions, formatInterventionsForAi, lastSentence,
} from '@/lib/testimonialSpeaker';
import type { Turn } from '@/lib/fluency';

describe('nameMatchesStrict', () => {
  it('acepta el mismo alumno con nombres abreviados, apellidos de más o iniciales', () => {
    expect(nameMatchesStrict('Maximiliano Bilotti', 'Max Bilotti')).toBe(true);
    expect(nameMatchesStrict('Patricia León', 'Patri Leon')).toBe(true);
    expect(nameMatchesStrict('José María Negrillo García Muñoz', 'JOSÉ MARIA NEGRILLO')).toBe(true);
    expect(nameMatchesStrict('María Isabel García Vallina', 'Isabel Vallina Garcia')).toBe(true);
    expect(nameMatchesStrict('Juan AM', 'Juan Aparicio Martínez')).toBe(true);
    expect(nameMatchesStrict('Saray g', 'Saray Garcia')).toBe(true);
    expect(nameMatchesStrict('Victoria (Guest)', 'Victoria Lucas Guerrero')).toBe(true);
    expect(nameMatchesStrict('Elena', 'Elena Tapia')).toBe(true);
    expect(nameMatchesStrict('Nahuel Lopez', 'López Nahuel')).toBe(true);
  });

  it('rechaza a otra persona que comparte un solo nombre o apellido (casos reales de la auditoría)', () => {
    expect(nameMatchesStrict('Bruno18 Casella Martinez', 'Beatriz Martinez Garcia')).toBe(false);
    expect(nameMatchesStrict('sonia becerra', 'Joaquin Becerra espinosa')).toBe(false);
    expect(nameMatchesStrict('Francesc Albert', 'Guillem Albert Baldrich')).toBe(false);
    expect(nameMatchesStrict('Susana Jimenez', 'Susana Manrique')).toBe(false);
    expect(nameMatchesStrict('Alba Lopez', 'Alba Coca')).toBe(false);
    expect(nameMatchesStrict('Manuel Sanchez', 'Manuel Movil')).toBe(false);
    expect(nameMatchesStrict('Elena', 'Ana Aparicio')).toBe(false);
  });

  it('rechaza alias que no se pueden confirmar', () => {
    expect(nameMatchesStrict('Giselle G.G.', 'Sofía Geno')).toBe(false);
    expect(nameMatchesStrict('Y', 'Yanira Fernandez Gallego')).toBe(false);
    expect(nameMatchesStrict('MJ GC', 'María José Cabrera')).toBe(false);
    expect(nameMatchesStrict('BLNNDNN', 'felipe blandon')).toBe(false);
  });
});

const T = (at: string, speaker: string, text: string): Turn => ({ at, speaker, text });
const PROFE = 'Lily DRC (lily@gmail.com)';

describe('resolveStudentLabel', () => {
  const clase = (alumno: string, profe = PROFE): Turn[] => [
    T('0:01', profe, 'Hi! How are you today?'),
    T('0:04', alumno, 'Fine thanks, and you?'),
    T('0:08', profe, 'Good. What did you do at the weekend?'),
    T('0:12', alumno, 'I went to the beach with my family.'),
    T('0:20', profe, 'Nice!'),
  ];

  it('el alumno es el hablante sin email cuyo nombre cuadra', () => {
    expect(resolveStudentLabel(clase('Lourdes Barzola'), 'Lourdes Barzola')).toEqual({
      ok: true, studentLabel: 'Lourdes Barzola', teacherLabel: PROFE,
    });
  });

  it('fuera si no se puede decidir con seguridad', () => {
    const r = (turns: Turn[], name = 'Lourdes Barzola') => {
      const x = resolveStudentLabel(turns, name);
      return x.ok ? 'ok' : x.reason;
    };
    expect(r(clase('Elena'))).toBe('nombre_no_cuadra');
    expect(r(clase('Lourdes Barzola', 'Lily DRC'))).toBe('profe_sin_email');
    expect(r(clase('Lourdes Barzola (lourdes@gmail.com)'))).toBe('dos_con_email');
    expect(r(clase('lourdesbarzola@gmail.com Barzola', PROFE))).toBe('alumno_con_email');
    expect(r([...clase('Lourdes Barzola'), T('0:30', 'Otra Persona', 'Hello')])).toBe('mas_de_dos_hablantes');
    expect(r(clase('Lourdes Barzola').slice(0, 3))).toBe('sin_formato_hablantes');
    expect(r(clase('Lourdes Barzola'), '')).toBe('sin_nombre_alumno');
  });
});

describe('intervenciones del alumno para la IA', () => {
  const turns = [
    T('0:01', PROFE, 'Hi! Welcome back. What did you do at the weekend?'),
    T('0:05', 'Ana', 'I went to the beach with my family and we ate paella.'),
    T('0:15', 'Ana', 'yes'),
    T('0:17', PROFE, 'Great.'),
  ];

  it('solo el alumno, con inicio y fin, y la última frase del profe antes', () => {
    const list = studentInterventions(turns, 'Ana');
    expect(list.map(x => [x.n, x.turnIndex, x.start, x.end])).toEqual([[1, 1, 5, 15], [2, 2, 15, 17]]);
    expect(list[0].teacherBefore).toBe('What did you do at the weekend?');
    expect(list[1].teacherBefore).toBeNull();
  });

  it('el texto marca al profe como NO ELEGIBLE y salta las respuestas de menos de 4 palabras', () => {
    const txt = formatInterventionsForAi(studentInterventions(turns, 'Ana'));
    expect(txt).toBe('[PROFE - SOLO CONTEXTO, NO ELEGIBLE] What did you do at the weekend?\n#1 [0:05–0:15] I went to the beach with my family and we ate paella.');
  });

  it('lastSentence recorta lo largo', () => {
    expect(lastSentence('One. Two three?')).toBe('Two three?');
    expect(lastSentence('a'.repeat(200), 10)).toBe(`…${'a'.repeat(10)}`);
  });
});
