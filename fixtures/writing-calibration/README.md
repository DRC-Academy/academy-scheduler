# Set de calibración de la evaluación de escritura

Redacciones de nivel MCER **conocido y externo** contra las que se mide el
evaluador de escritura (`lib/evaluateWriting.ts`).

```
npm run calibrate:writing
```

## La regla que da sentido a todo esto

**Los textos y sus etiquetas tienen que venir de fuera.** Sample answers oficiales
de Cambridge corregidas por examinadores, o equivalente con procedencia
verificable.

Si el texto lo escribe quien construye el evaluador y él mismo lo etiqueta B1, y
después su evaluador dice B1, no se ha validado nada: se ha medido un criterio
contra sí mismo. Un set de calibración sin procedencia externa es peor que no
tener ninguno, porque da una confianza que no está respaldada.

Por eso `source` es obligatorio y el comando **falla** si algún fichero no lo
trae.

## Formato

Un fichero `.md` por texto, con front-matter. Los que empiezan por `_` se ignoran
(ver `_PLANTILLA.md`).

```markdown
---
cefr: B1
source: Cambridge English Preliminary (PET) Handbook for Teachers 2020, Sample Answer 2, p. 34
source_url: https://www.cambridgeenglish.org/...
prompt: Write an email to your friend about a holiday you have booked.
notes: El examinador le da 4/5 en Language y 3/5 en Content.
---

(El texto del alumno, tal cual. Sin corregir la ortografía ni la puntuación:
los errores son parte de la evidencia del nivel.)
```

| Campo | Obligatorio | Qué es |
|---|---|---|
| `cefr` | sí | Nivel oficial: `A1`…`C2` |
| `source` | sí | De dónde sale, con el detalle suficiente para encontrarlo |
| `source_url` | no | Enlace, si lo hay |
| `prompt` | no | La consigna original. Si falta se usa una genérica — que además es una buena prueba: el nivel asignado NO debe depender de la consigna |
| `notes` | no | Lo que ayude a interpretar el resultado |

**Nombre del fichero:** `<nivel>-<n>.md` en minúsculas → `b1-01.md`, `c2-02.md`.

**Cobertura recomendada:** dos por banda, 12 en total. El comando avisa si alguna
banda se queda sin representación, pero no falla por ello: con pocos textos la
señal es más débil, no inválida.

## Criterio de éxito

Codificado en el comando, que devuelve un código de salida distinto de 0 si no se
cumple:

| Desviación | Resultado | Por qué |
|---|---|---|
| Acierta la banda (`0`) | pasa | |
| Falla **una hacia abajo** (`−1`) | pasa | Es el sesgo tolerado. El prompt le pide al evaluador quedarse en el nivel de abajo cuando la evidencia cae entre dos |
| Falla **hacia arriba** (`+1` o más) | **NO pasa** | Es el fallo caro: manda a un alumno a un nivel que no puede seguir |
| Falla por **dos o más hacia abajo** | **NO pasa** | Ya no es prudencia, es no medir |

La asimetría es deliberada.

## Cuándo correrlo

Cada vez que se toque el prompt de `evaluateWriting`, la rúbrica
(`CEFR_WRITING_DESCRIPTORS`) o los umbrales (`CEFR_BANDS`). Son 12 llamadas a
Haiku: del orden de un céntimo y unos segundos.

Necesita `ANTHROPIC_API_KEY` en `.env.local`.
