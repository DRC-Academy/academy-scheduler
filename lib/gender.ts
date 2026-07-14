// Detección de género por nombre de pila para copys de email personalizados
// ("Estimado" vs "Estimada", "bienvenido" vs "bienvenida"). Sin dependencias
// ni API externa: diccionario de nombres frecuentes en español (España + Latam)
// + heurística de terminación, con fallback NEUTRO cuando no hay confianza.
//
// Orden de resolución recomendado: dato explícito guardado en la base
// (columna `gender`) → detección por nombre → neutro. Ver resolveGender().

export type Gender = 'male' | 'female' | 'neutral';

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Nombres masculinos frecuentes (ES + Latam). No busca exhaustividad: cubre los
// más comunes y las excepciones que la heurística de terminación fallaría.
const MALE = new Set([
  'diego', 'juan', 'jose', 'luis', 'carlos', 'miguel', 'manuel', 'javier', 'francisco', 'antonio',
  'david', 'daniel', 'jorge', 'pedro', 'pablo', 'alejandro', 'fernando', 'sergio', 'ricardo', 'roberto',
  'raul', 'ruben', 'victor', 'oscar', 'angel', 'alberto', 'adrian', 'ivan', 'marcos', 'mario',
  'martin', 'nicolas', 'matias', 'santiago', 'sebastian', 'tomas', 'lucas', 'benjamin', 'joaquin', 'emiliano',
  'maximiliano', 'agustin', 'franco', 'bruno', 'thiago', 'bautista', 'gonzalo', 'ignacio', 'facundo', 'federico',
  'ramiro', 'lautaro', 'mateo', 'gabriel', 'samuel', 'hugo', 'alvaro', 'marc', 'pau', 'aitor',
  'iker', 'unai', 'gael', 'enzo', 'dylan', 'dante', 'leonardo', 'leo', 'cristian', 'christian',
  'cesar', 'cristobal', 'eduardo', 'enrique', 'esteban', 'felipe', 'gerardo', 'gustavo', 'hernan', 'isaac',
  'ismael', 'jesus', 'joel', 'jonathan', 'julian', 'julio', 'lucio', 'marcelo', 'mauricio', 'maximo',
  'nelson', 'omar', 'patricio', 'rafael', 'rodrigo', 'salvador', 'simon', 'vicente', 'walter', 'emilio',
  'elias', 'ezequiel', 'abel', 'adan', 'alan', 'alexis', 'anibal', 'arturo', 'axel', 'borja',
  'dario', 'domingo', 'fabian', 'felix', 'gaspar', 'german', 'guillermo', 'horacio', 'humberto', 'jaime',
  'kevin', 'lorenzo', 'nahuel', 'ramon', 'teo', 'valentin', 'yago',
]);

// Nombres femeninos frecuentes (ES + Latam).
const FEMALE = new Set([
  'maria', 'ana', 'laura', 'marta', 'lucia', 'sara', 'paula', 'carmen', 'elena', 'sofia',
  'julia', 'claudia', 'patricia', 'raquel', 'cristina', 'beatriz', 'rosa', 'isabel', 'pilar', 'teresa',
  'silvia', 'andrea', 'natalia', 'veronica', 'monica', 'sandra', 'alba', 'irene', 'noelia', 'nuria',
  'angela', 'carla', 'clara', 'daniela', 'valentina', 'valeria', 'camila', 'martina', 'emma', 'olivia',
  'victoria', 'antonella', 'florencia', 'agustina', 'catalina', 'renata', 'emilia', 'guadalupe', 'micaela', 'abril',
  'delfina', 'morena', 'rocio', 'belen', 'luz', 'mia', 'ariana', 'ivana', 'malena', 'zoe',
  'adriana', 'alejandra', 'alicia', 'amparo', 'araceli', 'ariadna', 'aurora', 'azucena', 'blanca', 'consuelo',
  'dolores', 'esperanza', 'estela', 'estefania', 'eva', 'fatima', 'gabriela', 'gemma', 'gloria', 'ines',
  'jimena', 'josefina', 'juana', 'leticia', 'lorena', 'lourdes', 'magdalena', 'manuela', 'margarita', 'mariana',
  'marina', 'mayra', 'mercedes', 'milagros', 'mireia', 'montserrat', 'nadia', 'nerea', 'norma', 'ofelia',
  'paloma', 'pamela', 'paz', 'ramona', 'rosalia', 'rosario', 'salome', 'soledad', 'susana', 'tamara',
  'ximena', 'yolanda',
]);

// Excepciones para la heurística de terminación.
const MALE_ENDS_A = new Set(['nicola', 'luca', 'elia', 'bautista', 'josema']); // termina en 'a' pero es masculino
const FEMALE_ENDS_O = new Set(['rosario', 'consuelo', 'amparo', 'socorro', 'charo']); // termina en 'o' pero es femenino

// Detecta el género a partir del nombre completo (usa el primer nombre).
export function detectGender(fullName: string | undefined | null): { gender: Gender; confidence: 'high' | 'low' } {
  const raw = norm(String(fullName ?? ''));
  const first = raw.split(/\s+/)[0];
  if (!first) return { gender: 'neutral', confidence: 'low' };

  if (MALE.has(first)) return { gender: 'male', confidence: 'high' };
  if (FEMALE.has(first)) return { gender: 'female', confidence: 'high' };

  if (MALE_ENDS_A.has(first)) return { gender: 'male', confidence: 'low' };
  if (FEMALE_ENDS_O.has(first)) return { gender: 'female', confidence: 'low' };

  // Heurística de terminación (español): -a → femenino, -o → masculino.
  const last = first.slice(-1);
  if (last === 'a') return { gender: 'female', confidence: 'low' };
  if (last === 'o') return { gender: 'male', confidence: 'low' };
  if (/(cion|sion|dad|triz)$/.test(first)) return { gender: 'female', confidence: 'low' };

  return { gender: 'neutral', confidence: 'low' };
}

// Resuelve el género priorizando el dato explícito (columna `gender`); si está
// vacío, cae en la detección por nombre; si no hay confianza, neutro.
export function resolveGender(explicit: string | null | undefined, name: string | undefined | null): Gender {
  if (explicit === 'male' || explicit === 'female') return explicit;
  return detectGender(name).gender;
}

// Elige la variante correcta según género, con fallback neutro ("masc/fem").
export function g(gender: Gender, masc: string, fem: string, neutral?: string): string {
  if (gender === 'male') return masc;
  if (gender === 'female') return fem;
  return neutral ?? `${masc}/${fem}`;
}

// Saludo formal de email según género, con neutro por defecto.
export function salutation(gender: Gender): string {
  return g(gender, 'Estimado', 'Estimada', 'Estimado/a');
}
