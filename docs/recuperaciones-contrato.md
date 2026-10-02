# Contrato Gestión ↔ LMS: recuperaciones de clases canceladas por el profesor

Versión 1 · octubre de 2026 · implementado en Gestión (academy-scheduler).

## Principio

Toda la lógica vive en **Gestión**. El LMS solo:

1. **muestra** lo que Gestión le devuelve, y
2. **comunica** a Gestión lo que eligió el alumno.

El LMS **nunca** escribe en las tablas de recuperaciones, calendario ni clases
(`class_recoveries`, `teacher_calendars`, `class_records`), aunque compartan base.

## Cómo llega el alumno

Cuando el profesor pulsa «No puedo dar esta clase», el alumno recibe un email con
un botón a:

```
<LMS_URL>/mis-clases?recuperacion=<id>
```

El LMS exige sesión iniciada y solo muestra la recuperación si pertenece al
alumno logueado (consultando el endpoint 1). Si la recuperación no aparece en la
lista del alumno, no se muestra.

## Seguridad

- Llamadas **servidor → servidor** (route handler o server action del LMS).
  Nunca desde el navegador: el secreto no puede viajar al cliente.
- Cabecera obligatoria: `x-lms-secret: <secreto compartido>`
  - En Gestión: variable `LMS_GESTION_SECRET`.
  - En el LMS: la variable que corresponda, con **el mismo valor**.
  - Es un secreto distinto del que usa Gestión para llamar al LMS
    (`LMS_EXTERNAL_SECRET` / `SECRETO_GESTION`): cada dirección tiene el suyo.
- El alumno se identifica con `alumno_id` = `students.id` (el mismo `alumno_id`
  de `vista_perfil_alumno`), tomado de la **sesión** del LMS, nunca de un
  parámetro que venga del navegador.
- Gestión comprueba que cada recuperación pertenece a ese alumno: por su id o por
  su email normalizado (`students.email` / `assignments.student_email`).
- Fechas `YYYY-MM-DD` y horas `HH:00`, siempre en **hora de España**
  (Europe/Madrid).

### Errores comunes

Cuerpo JSON: `{ "error": "<codigo>", "mensaje": "<texto listo para mostrar>" }`

| HTTP | error | Cuándo |
|---|---|---|
| 401 | `no_autorizado` | falta o no coincide `x-lms-secret` |
| 404 | `no_encontrada` | no existe o no es de ese alumno |
| 409 | `estado_cambiado` | ya no admite esa acción (ya eligió, se anuló, las fechas pasaron, otra pestaña) |
| 409 | `hueco_no_disponible` | la fecha elegida ya no está libre en el calendario del profesor |
| 422 | `datos_invalidos` | faltan datos, horarios fuera de rango, más de 3, en el pasado… |
| 503 | `no_configurado` | Gestión sin el secreto o sin la tabla |

## Estados

| estado | Qué significa | Qué hace el LMS |
|---|---|---|
| `esperando_alumno` | El profesor propuso fechas | Mostrar las opciones y los botones «Elegir» y «Ninguna me viene bien» |
| `alumno_propuso` | El alumno propuso otros horarios | «Esperando a que tu profesor responda» + sus propuestas |
| `confirmada` | Hay fecha | Mostrar la fecha confirmada |
| `recuperada` | La clase de recuperación ya se dio | Mostrar como dada |
| `sin_acuerdo` | No se encontró fecha (o pasaron las propuestas) | «El equipo te contactará para encontrar una fecha» |
| `anulada` | Anulada (baja, cambio de plan…) | No mostrar, o mostrar como anulada |

## 1. Listar las recuperaciones del alumno

`GET /api/lms/recuperaciones?alumno_id=<students.id>`

Devuelve las activas (`esperando_alumno`, `alumno_propuso`, `confirmada` con
fecha futura) y las que cambiaron en los últimos 30 días. Las que vencieron sin
respuesta se devuelven ya como `sin_acuerdo`.

```json
{
  "recuperaciones": [
    {
      "id": "rec_mg1abc2def",
      "estado": "esperando_alumno",
      "profesor": "Ignacio",
      "clase_cancelada": { "fecha": "2026-10-08", "hora": "17:00", "horas": 1 },
      "parte": { "numero": 1, "de": 1 },
      "ronda": 1,
      "opciones": [
        { "indice": 0, "fecha": "2026-10-12", "hora": "17:00", "horas": 1 },
        { "indice": 1, "fecha": "2026-10-13", "hora": "19:00", "horas": 1 }
      ],
      "mis_propuestas": [],
      "mi_nota": null,
      "fecha_confirmada": null,
      "puede_elegir": true,
      "puede_decir_ninguna": true
    }
  ]
}
```

- `parte`: una clase de 2 h recuperada «en dos días diferentes» llega como **dos
  recuperaciones** (`parte.numero` 1 y 2 de 2), cada una con sus opciones. El
  alumno elige cada una por separado.
- `opciones` solo viene con datos en `esperando_alumno`.

## 2. Elegir una de las fechas

`POST /api/lms/recuperaciones/<id>/elegir`

```json
{ "alumno_id": "<students.id>", "indice": 1 }
```

Respuesta 200:

```json
{ "estado": "confirmada", "fecha": "2026-10-13", "hora": "19:00", "horas": 1 }
```

Efectos en Gestión: crea la clase de recuperación en el calendario del profesor,
libera la otra fecha y avisa al profesor (campanita + email) y al alumno (email).

**Idempotente**: repetir la misma elección devuelve 200 con el mismo resultado.
Elegir otra opción cuando ya hay fecha devuelve 409 `estado_cambiado`.

## 3. «Ninguna me viene bien»

`POST /api/lms/recuperaciones/<id>/ninguna`

```json
{
  "alumno_id": "<students.id>",
  "horarios": [
    { "fecha": "2026-10-14", "hora": "18:00" },
    { "fecha": "2026-10-15", "hora": "10:00" }
  ],
  "nota": "Por las tardes a partir de las 18 me viene mejor"
}
```

Reglas:
- de 1 a 3 horarios, futuros y dentro de los **7 días siguientes**;
- sin repetidos;
- `nota` opcional, máximo 500 caracteres;
- solo en estado `esperando_alumno`.

Respuesta 200:

```json
{ "estado": "alumno_propuso", "ronda": 1 }
```

- **Ronda 1** → `alumno_propuso`: el profesor recibe los horarios y acepta uno o
  propone 2 fechas nuevas (vuelve a `esperando_alumno`, ronda 2).
- **Ronda 2** → `sin_acuerdo`: ya no hay más vueltas; el equipo contacta al
  alumno. La respuesta es 200 con `"estado": "sin_acuerdo"`.

Con datos inválidos: 422 con `problemas` (lista de textos) además de `mensaje`.

## Prueba rápida (curl)

```bash
curl -s "https://<gestion>/api/lms/recuperaciones?alumno_id=<id>" -H "x-lms-secret: $SECRETO"

curl -s -X POST "https://<gestion>/api/lms/recuperaciones/<rec_id>/elegir" \
  -H "x-lms-secret: $SECRETO" -H "Content-Type: application/json" \
  -d '{"alumno_id":"<id>","indice":0}'
```
