# Contrato Gestión ↔ LMS: autoservicio de cambio de horario

Versión 1 · octubre de 2026 · implementado en Gestión (academy-scheduler).

El alumno, desde el LMS, cambia el horario de sus clases **con su mismo
profesor**, de dos formas:

- **«Solo esta clase»** (`modo: "puntual"`): mueve una clase concreta a otro
  hueco. El resto de su horario no cambia.
- **«Desde ahora»** (`modo: "fijo"`): cambia su horario recurrente.

## Principio

Toda la lógica vive en **Gestión**. El LMS solo muestra lo que Gestión le
devuelve y le comunica lo que eligió el alumno. El LMS **nunca** escribe en
`teacher_calendars`, `assignments`, `class_records` ni ninguna otra tabla de
Gestión, aunque compartan base.

Gestión **revalida todo** en el POST, aunque el hueco venga de GET huecos: entre
una llamada y otra el calendario puede haber cambiado.

## Seguridad

Igual que las recuperaciones (`docs/recuperaciones-contrato.md`):

- Llamadas **servidor → servidor** (route handler o server action del LMS), nunca
  desde el navegador.
- Cabecera obligatoria `x-lms-secret` con el valor de `LMS_GESTION_SECRET` (el
  mismo secreto que las recuperaciones).
- El alumno se identifica con `alumno_id` = `students.id` (el mismo `alumno_id`
  de `vista_perfil_alumno`), tomado de la **sesión** del LMS, nunca de un
  parámetro que venga del navegador.

## Formatos

| Campo | Formato | Ejemplo |
|---|---|---|
| `dia` | Igual que en las claves del calendario, **con tilde** | `"Lunes"`, `"Miércoles"`, `"Sábado"` |
| `hora` | `"HH:MM"`, hora de **España peninsular**. Siempre en punto (`MM` = `00`) | `"15:00"` |
| `duracion` | Entero, en horas (de 1 a 4) | `2` |
| `fecha` | `"YYYY-MM-DD"`, fecha de España peninsular | `"2026-10-20"` |
| momento (`disponible_desde`) | `{ "fecha": "YYYY-MM-DD", "hora": "HH:MM" }`, España peninsular | `{ "fecha": "2026-10-13", "hora": "17:00" }` |

Una **sesión** es un bloque de horas seguidas del mismo día: una clase de 2 h
es **una** sesión de `duracion: 2` y se mueve entera a otro bloque de 2 h
seguidas.

## Respuestas

**Éxito:** HTTP 200 con `"ok": true`.

**Error:** cuerpo JSON

```json
{ "ok": false, "codigo": "SLOT_NO_DISPONIBLE", "mensaje": "Ese hueco ya no está libre. Elige otro." }
```

- `codigo` es **estable**: el LMS puede decidir con él.
- `mensaje` está listo para enseñárselo al alumno (español de España, tú).
- Con `NO_ELEGIBLE` llega además `detalle_no_elegible`.

**Regla de oro: un cambio solo está hecho si la respuesta trae `"ok": true`.**
El código HTTP acompaña (tabla de abajo), pero el LMS decide por `ok`. Ante un
timeout, un 5xx o una respuesta sin `ok: true`, el cambio **no** se da por hecho
y se repite con la **misma** `idempotency_key` (ver el endpoint 3).

### Códigos

| HTTP | `codigo` | Cuándo |
|---|---|---|
| 401 | `NO_AUTORIZADO` | Falta o no coincide `x-lms-secret` |
| 503 | `NO_CONFIGURADO` | Gestión sin `LMS_GESTION_SECRET` o sin la service key |
| 422 | `DATOS_INVALIDOS` | Faltan datos o están mal formados; la fecha no cae en ese día; duraciones distintas |
| 404 | `ALUMNO_NO_ENCONTRADO` | No existe un alumno con ese `alumno_id` |
| 403 | `NO_ELEGIBLE` | Su plan no admite autoservicio (ver `detalle_no_elegible`) |
| 409 | `RECUPERACION_PENDIENTE` | Tiene una recuperación abierta o una reserva viva |
| 409 | `CALENDARIO_SIN_ACTUALIZAR` | El calendario de su profesor lleva más de 30 días sin revisar |
| 404 | `SESION_NO_ENCONTRADA` | No tiene esa sesión en el calendario (otro la cambió; recargar) |
| 422 | `MISMO_HORARIO` | El destino es el mismo horario (y fecha, en puntual) |
| 409 | `ANTELACION_INSUFICIENTE` | La clase original o la nueva empiezan dentro de 24 h o menos |
| 422 | `FUERA_DE_VENTANA` | Puntual: la clase original o la nueva están a más de 6 semanas |
| 409 | `MARCA_PUNTUAL_EXISTENTE` | Puntual: la sesión o el destino ya tienen una clase movida o marcada vigente |
| 409 | `SLOT_NO_DISPONIBLE` | El destino no está libre |
| 409 | `HUECO_YA_OCUPADO` | Otro ocupó el hueco mientras se guardaba (no se escribió nada) |
| 409 | `EN_CURSO` | Hay un cambio con esa `idempotency_key` sin terminar; esperar y repetir |
| 503 | `CALENDARIO_ILEGIBLE` | No se pudo leer el calendario |
| 503 | `ERROR_LECTURA` | No se pudo leer la ficha, las asignaciones o las recuperaciones |
| 500 | `ERROR_ESCRITURA` | La base rechazó una escritura |
| 500 | `ERROR_INTERNO` | Error inesperado |

Si un cambio queda **a medias** (muy raro: falló al guardar y no se pudo deshacer
todo), el error llega con su código y un `mensaje` que pide **no** reintentar;
el equipo ya recibió un aviso.

### `detalle_no_elegible`

| Valor | Significa |
|---|---|
| `SIN_ASIGNACION_ACTIVA` | No tiene profesor asignado |
| `VARIAS_ASIGNACIONES` | Tiene más de un profesor activo |
| `PLAN_DOS_ALUMNOS` | Plan de dos alumnos (comparte la clase con otro alumno) |
| `EMPRESA` | Plan de empresa |
| `ORITALK` | Alumno de Oritalk |

Se pueden añadir valores nuevos (está previsto `EN_PAUSA`): el LMS debe tratar
un valor desconocido como «no elegible» genérico.

## Reglas de negocio

- **Elegibilidad:** exactamente un profesor activo y plan individual. Quedan
  fuera los planes de dos alumnos, empresa y Oritalk.
- **Recuperación pendiente** o **calendario sin actualizar** (nadie, salvo el
  sistema, lo ha tocado en 30 días y su última modificación es de hace más de 30
  días): no se ofrece nada.
- **Huecos:** solo huecos libres según el calendario del profesor, dentro de su
  horario de trabajo.
- **Antelación: más de 24 h**, en hora de España.
  - Puntual: la clase original y la nueva.
  - Fijo: la próxima clase con el horario actual y la primera con el nuevo.
- **Puntual:** el destino tiene que estar dentro de las próximas **6 semanas**,
  y cada sesión admite **una** clase movida a la vez. Si ya hay una clase movida
  de esa sesión, de esta semana o posterior, no se puede mover otra hasta que
  acabe esa semana. Lo mismo si el hueco de destino ya tiene una marca vigente.
  Tampoco se puede mover una clase a un bloque que se solape con ella misma ese
  día (por ejemplo, de 14-16 a 15-17).
- **Fijo:** sí se puede mover a un bloque que se solape con el actual (15-17 →
  16-18).
- Mover una clase suelta no consume cupo ni tiene límite.

## 1. Estado

`GET /api/lms/autoservicio/estado?alumno_id=<students.id>`

Qué puede cambiar el alumno y, si algo no se puede, **desde cuándo** podrá.

```json
{
  "ok": true,
  "elegible": true,
  "motivo_no_elegible": null,
  "detalle_no_elegible": null,
  "profesor": { "nombre": "Berta Gómez" },
  "sesiones": [
    {
      "id": "Martes_15:00",
      "dia": "Martes",
      "hora": "15:00",
      "duracion": 2,
      "fijo": {
        "movible": false,
        "motivo_no_movible": "ANTELACION_INSUFICIENTE",
        "disponible_desde": { "fecha": "2026-10-13", "hora": "17:00" }
      },
      "proximas_clases": [
        { "fecha": "2026-10-13", "hora": "15:00", "duracion": 2,
          "movible": false, "motivo_no_movible": "ANTELACION_INSUFICIENTE", "disponible_desde": null },
        { "fecha": "2026-10-20", "hora": "15:00", "duracion": 2,
          "movible": true, "motivo_no_movible": null, "disponible_desde": null }
      ]
    }
  ]
}
```

- `elegible: false` → `motivo_no_elegible` es `NO_ELEGIBLE` (con
  `detalle_no_elegible`), `RECUPERACION_PENDIENTE` o `CALENDARIO_SIN_ACTUALIZAR`,
  y `sesiones` llega vacío. Es una respuesta **200 con `ok: true`**: el estado se
  leyó bien.
- `sesiones[].id` es lo que se pasa en `sesion` a GET huecos.
- `fijo`: si se puede cambiar el horario fijo de esa sesión.
- `proximas_clases`: las clases de esa sesión de las próximas 6 semanas que aún
  no empezaron, cada una con si se puede mover suelta.
- `motivo_no_movible`: `ANTELACION_INSUFICIENTE` o `MARCA_PUNTUAL_EXISTENTE`.

### `disponible_desde`

Momento (España peninsular) a partir del cual ese bloqueo deja de aplicar, o
`null` si no aplica:

| Bloqueo | `disponible_desde` |
|---|---|
| `fijo` por `ANTELACION_INSUFICIENTE` | El **final** de esa próxima clase (inicio + duración) |
| Clase suelta por `MARCA_PUNTUAL_EXISTENTE` | El **lunes a las 00:00** siguiente a la semana de la clase que tiene la marca vigente. Una marca deja de estar vigente cuando termina su semana, no cuando termina su clase. |
| Clase suelta por `ANTELACION_INSUFICIENTE` | `null`: esa clase ya no se podrá mover |
| Marca antigua sin semana | `null` |

`disponible_desde` indica cuándo deja de aplicar **ese** motivo. Otro motivo
puede seguir impidiendo el cambio, por ejemplo una recuperación que se abre
después. Por eso hay que volver a consultar el estado.

## 2. Huecos

`GET /api/lms/autoservicio/huecos?alumno_id=<id>&modo=<puntual|fijo>&sesion=<id de sesión>[&fecha=YYYY-MM-DD]`

- `sesion`: el `id` de GET estado, `"<dia>_<HH:MM>"`, **codificado en UTF-8**
  en la URL (`Mi%C3%A9rcoles_15%3A00`).
- `fecha`: solo en `puntual`, la clase que se quiere mover. Recomendado: con
  ella Gestión comprueba que esa clase se puede mover y no ofrece la propia
  clase. Sin `fecha` se listan los huecos de las 6 semanas sin validar el origen.

```json
{
  "ok": true,
  "modo": "puntual",
  "sesion": { "id": "Martes_15:00", "dia": "Martes", "hora": "15:00", "duracion": 2 },
  "fecha_origen": "2026-10-20",
  "huecos": [
    { "dia": "Jueves", "hora": "10:00", "duracion": 2, "fecha": "2026-10-15" },
    { "dia": "Jueves", "hora": "10:00", "duracion": 2, "fecha": "2026-10-22" }
  ]
}
```

- `huecos` llega **ordenado por fecha y hora**. Cada uno tiene la duración de la
  sesión.
- En `puntual`, `fecha` es el día concreto del hueco: de mañana (más de 24 h) a
  6 semanas.
- En `fijo`, `fecha` es la **primera clase** con el horario nuevo. Es
  informativa.
- Si el alumno no es elegible o esa sesión o clase no se puede mover, devuelve el
  error con **el mismo código que daría el POST**.
- Una lista vacía con `ok: true` significa que no hay huecos libres.

## 3. Cambiar el horario

`POST /api/lms/autoservicio/cambiar-horario`

```json
{
  "alumno_id": "<students.id>",
  "modo": "puntual",
  "sesion_origen": { "dia": "Martes", "hora": "15:00", "duracion": 2 },
  "fecha_origen": "2026-10-20",
  "destino": { "dia": "Jueves", "hora": "10:00", "duracion": 2, "fecha": "2026-10-22" },
  "idempotency_key": "c0a8f1e2-…"
}
```

- `sesion_origen`: la sesión que se mueve (`dia`, `hora`, `duracion` de GET
  estado).
- `fecha_origen`: **obligatoria en `puntual`** (la clase que se mueve). En `fijo`
  se ignora.
- `destino`: **un hueco tal cual lo devolvió GET huecos**. Gestión ignora los
  campos de más y revalida todo. En `puntual` manda su `fecha`.
- `idempotency_key` (opcional pero **muy recomendada**): un UUID generado por el
  LMS **por intento del alumno**, que se reutiliza en los reintentos de ese
  mismo intento. También vale la cabecera `Idempotency-Key`.
  - Mismo cambio ya hecho → 200 con el mismo resultado, sin repetir nada (ni los
    correos).
  - Mismo cambio todavía en curso → 409 `EN_CURSO`.
  - Mismo cambio que falló → se puede reintentar con la misma clave.
  - Reutilizar una clave para **otro** cambio → 422 `DATOS_INVALIDOS`: usa una
    clave nueva por intento.

Respuesta 200:

```json
{
  "ok": true,
  "modo": "puntual",
  "profesor": { "nombre": "Berta Gómez" },
  "sesion_antes": { "dia": "Martes", "hora": "15:00", "duracion": 2 },
  "sesion_despues": { "dia": "Jueves", "hora": "10:00", "duracion": 2 },
  "fecha_original": "2026-10-20",
  "fecha_nueva": "2026-10-22"
}
```

- En `fijo`, `fecha_original` es `null` y `fecha_nueva` es la primera clase con
  el horario nuevo.

Efectos en Gestión (el LMS no tiene que hacer nada):

- **Fijo:** cambia el horario recurrente en el calendario del profesor. Su ficha
  (`assignments.slots`) se actualiza sola a partir del calendario.
- **Puntual:** marca la clase original como reprogramada y bloquea el hueco nuevo
  esa semana, igual que cuando el profesor pulsa «Reprogramar».
- **En los dos modos:**
  - Aviso al profesor por campanita y por email.
  - Email de confirmación al alumno, con copia al email de su asignación si es
    distinto.
- Si falla un aviso o un email, el cambio **sigue hecho** (`ok: true`) y el
  equipo recibe una alerta.

## Prueba rápida (curl)

```bash
curl -s "https://<gestion>/api/lms/autoservicio/estado?alumno_id=<id>" -H "x-lms-secret: $SECRETO"

curl -s "https://<gestion>/api/lms/autoservicio/huecos?alumno_id=<id>&modo=fijo&sesion=Martes_15%3A00" \
  -H "x-lms-secret: $SECRETO"

curl -s -X POST "https://<gestion>/api/lms/autoservicio/cambiar-horario" \
  -H "x-lms-secret: $SECRETO" -H "Content-Type: application/json" \
  -d '{"alumno_id":"<id>","modo":"fijo","sesion_origen":{"dia":"Martes","hora":"15:00","duracion":2},"destino":{"dia":"Jueves","hora":"10:00","duracion":2,"fecha":"2026-10-15"},"idempotency_key":"<uuid>"}'
```

Las dos primeras solo leen. **La tercera cambia el calendario de verdad.** Solo
se prueba con alumnos del perfil de prueba (profesor `t1`).
