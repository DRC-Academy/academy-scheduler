# Contrato Gestión ↔ LMS: autoservicio de cambio de horario y de profesor

Versión 2 · octubre de 2026 · implementado en Gestión (academy-scheduler).

El alumno, desde el LMS, cambia el horario de sus clases **con su mismo
profesor**, de dos formas:

- **«Solo esta clase»** (`modo: "puntual"`): mueve una clase concreta a otro
  hueco. El resto de su horario no cambia.
- **«Desde ahora»** (`modo: "fijo"`): cambia su horario recurrente.

Y desde la versión 2 también puede **cambiar de profesor** (endpoints 4 y 5):
pasa TODAS sus sesiones a otro profesor, con las mismas duraciones.

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
- Si el cambio quedó **a medias**, llega además `"a_medias": true` (ver más
  abajo). En cualquier otro error el campo no aparece.

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

Además, en el **cambio de profesor**:

| HTTP | `codigo` | Cuándo |
|---|---|---|
| 422 | `MISMO_PROFESOR` | El profesor elegido es el que ya tiene |
| 404 | `PROFESOR_NO_EXISTE` | No existe ese profesor |
| 409 | `PROFESOR_ARCHIVADO` | Ya no está en la academia |
| 422 | `PROFESOR_DE_PRUEBA` | Es el perfil de prueba |
| 409 | `CALENDARIO_SIN_ACTUALIZAR` | El calendario del profesor ELEGIDO lleva más de 30 días sin revisar |
| 422 | `HORAS_NO_COINCIDEN` | Los destinos no suman las horas semanales de su plan |
| 409 | `ASIGNACION_CAMBIADA` | Su asignación cambió mientras se guardaba (no se escribió nada) |
| 409 | `ASIGNACION_INACTIVA` | Su asignación ya no está activa |
| 404 | `ASIGNACION_NO_EXISTE` | No se encontró su asignación |

Con `ANTELACION_INSUFICIENTE`, si se sabe, el error trae también
`disponible_desde` (ver el endpoint 1).

### Cambio a medias: `a_medias`

Muy raro: el cambio falló al guardarse y Gestión no pudo deshacer todo lo que
ya había escrito. El equipo ya recibió un aviso y lo arregla a mano. El error
llega con su `codigo` (el del fallo, por ejemplo `HUECO_YA_OCUPADO` o
`ERROR_ESCRITURA`) y **además** con `"a_medias": true`:

```json
{
  "ok": false,
  "codigo": "HUECO_YA_OCUPADO",
  "mensaje": "Ha habido un problema al guardar el cambio y el equipo ya está avisado. No lo intentes de nuevo: te escribiremos.",
  "a_medias": true
}
```

Con `a_medias: true` el LMS **no** reintenta (ni con la misma
`idempotency_key` ni con otra) y no ofrece repetir el cambio. El cambio no
cuenta como hecho, porque no hay `ok: true`. Decide con este campo, no con el
texto del `mensaje`, que puede cambiar.

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
Desde la versión 2 trae además `puede_cambiar_profesor` (ver más abajo).

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

### `puede_cambiar_profesor`

```json
"puede_cambiar_profesor": {
  "puede": false,
  "motivo": "ANTELACION_INSUFICIENTE",
  "detalle_no_elegible": null,
  "disponible_desde": { "fecha": "2026-10-13", "hora": "17:00" }
}
```

- `puede: true` → `motivo`, `detalle_no_elegible` y `disponible_desde` son `null`.
- `motivo`: `NO_ELEGIBLE` (con `detalle_no_elegible`), `RECUPERACION_PENDIENTE`,
  `SESION_NO_ENCONTRADA` o `ANTELACION_INSUFICIENTE`.
- `ANTELACION_INSUFICIENTE`: la próxima clase de alguna de sus sesiones empieza
  en 24 h o menos. `disponible_desde` = el **final** de esa clase (la más tardía
  si son varias).
- El calendario sin actualizar de su profesor **actual** no impide cambiar de
  profesor (sí impide cambiar de horario con él): puede salir
  `elegible: false` con `CALENDARIO_SIN_ACTUALIZAR` y `puede_cambiar_profesor.puede: true`.

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

## 4. Huecos con otros profesores

`GET /api/lms/autoservicio/huecos-profesores?alumno_id=<id>[&dia=<día>][&franja=<franja>][&profesor_id=<id>]`

Para elegir profesor nuevo. Dos usos:

**a) Sin `profesor_id`: la lista de todos los profesores disponibles**, con sus
huecos para la duración de la **primera** sesión del alumno.

```json
{
  "ok": true,
  "tipo": "lista",
  "sesiones": [
    { "dia": "Martes", "hora": "15:00", "duracion": 2 },
    { "dia": "Jueves", "hora": "10:00", "duracion": 1 }
  ],
  "huecos": [
    { "profesor": { "id": "t15", "nombre": "Carla" }, "dia": "Lunes", "hora": "10:00", "duracion": 2, "fecha_primera_clase": "2026-10-12" },
    { "profesor": { "id": "t15", "nombre": "Carla" }, "dia": "Martes", "hora": "19:00", "duracion": 2, "fecha_primera_clase": "2026-10-13" },
    { "profesor": { "id": "t8", "nombre": "Fran" }, "dia": "Viernes", "hora": "09:00", "duracion": 2, "fecha_primera_clase": "2026-10-16" }
  ]
}
```

- `sesiones`: sus sesiones actuales, en orden. El cambio tiene que darles destino
  a TODAS, con las mismas duraciones.
- **Profesores**: todos los de la academia excepto el suyo, los que ya no están,
  el perfil de prueba y los que tienen el calendario sin revisar desde hace más
  de 30 días. **No se ordenan por puntuación.**
- **Orden**: aleatorio pero **estable** para el mismo alumno durante el día
  (hora de España): la lista no cambia entre recargas; mañana, otro orden. Los
  huecos de cada profesor vienen juntos.
- Cada hueco es un horario **fijo** semanal; `fecha_primera_clase` es la primera
  clase con él, siempre a más de 24 h.
- `dia`: filtra por día (`Lunes`… `Sábado`, con tilde).
- `franja`: por hora de inicio (España): `manana` (antes de las 14:00), `tarde`
  (14:00–19:59) o `noche` (desde las 20:00).

**b) Con `profesor_id`: los huecos de ese profesor para CADA sesión**, para que
el alumno elija los de sus sesiones restantes (la primera también viene, por si
la quiere cambiar).

```json
{
  "ok": true,
  "tipo": "profesor",
  "profesor": { "id": "t15", "nombre": "Carla" },
  "sesiones": [
    { "indice": 0, "dia": "Martes", "hora": "15:00", "duracion": 2,
      "huecos": [ { "profesor": { "id": "t15", "nombre": "Carla" }, "dia": "Lunes", "hora": "10:00", "duracion": 2, "fecha_primera_clase": "2026-10-12" } ] },
    { "indice": 1, "dia": "Jueves", "hora": "10:00", "duracion": 1,
      "huecos": [ { "profesor": { "id": "t15", "nombre": "Carla" }, "dia": "Miércoles", "hora": "18:00", "duracion": 1, "fecha_primera_clase": "2026-10-14" } ] }
  ]
}
```

- Los huecos de cada sesión se calculan por separado: **el LMS no debe dejar
  elegir dos que se solapen** (Gestión lo rechaza en el POST con
  `DATOS_INVALIDOS`).
- Si ese profesor no es elegible, error con el motivo exacto
  (`PROFESOR_ARCHIVADO`, `PROFESOR_DE_PRUEBA`, `MISMO_PROFESOR`,
  `PROFESOR_NO_EXISTE` o `CALENDARIO_SIN_ACTUALIZAR`).
- Si el alumno no puede cambiar de profesor: el mismo error que el POST
  (`NO_ELEGIBLE`, `RECUPERACION_PENDIENTE`…).

## 5. Cambiar de profesor

`POST /api/lms/autoservicio/cambiar-profesor`

```json
{
  "alumno_id": "<students.id>",
  "profesor_id": "t15",
  "destinos": [
    { "dia": "Lunes", "hora": "10:00", "duracion": 2 },
    { "dia": "Miércoles", "hora": "18:00", "duracion": 1 }
  ],
  "idempotency_key": "c0a8f1e2-…"
}
```

- `destinos`: uno por cada sesión actual, **con las mismas duraciones** (en
  cualquier orden), tomados de los huecos del endpoint 4. Sin solaparse.
- `idempotency_key`: igual que en el cambio de horario (UUID por intento,
  reutilizado en sus reintentos; también vale la cabecera `Idempotency-Key`).
  Un reintento de un cambio ya hecho devuelve 200 con el mismo resultado.

Gestión revalida todo:

- que el alumno pueda (elegibilidad, recuperaciones);
- **antelación**: la próxima clase de cada sesión actual y la primera de cada
  sesión nueva, a **más de 24 h**. Si falla por la actual:
  `ANTELACION_INSUFICIENTE` con `disponible_desde`;
- que el profesor sea elegible y cada destino esté libre.

Respuesta 200:

```json
{
  "ok": true,
  "profesor_anterior": { "nombre": "Berta" },
  "profesor_nuevo": { "id": "t15", "nombre": "Carla" },
  "sesiones_antes": [ { "dia": "Martes", "hora": "15:00", "duracion": 2 }, { "dia": "Jueves", "hora": "10:00", "duracion": 1 } ],
  "sesiones_despues": [ { "dia": "Lunes", "hora": "10:00", "duracion": 2 }, { "dia": "Miércoles", "hora": "18:00", "duracion": 1 } ]
}
```

Efectos en Gestión (los del cambio de profesor de siempre):

- el alumno pasa al calendario del profesor nuevo y sale del anterior;
- correo y campanita al profesor **nuevo**, campanita al **anterior**, aviso al
  equipo;
- **email de bienvenida al alumno** con su profesor nuevo (variante «cambio de
  profesor»), con el enlace al formulario o a la prueba si los tiene pendientes;
- el enlace de Meet se borra: el profesor nuevo define el suyo;
- no afecta a la puntuación de ningún profesor.

Si falla un aviso o un email, el cambio **sigue hecho** (`ok: true`). Si queda a
medias, `a_medias: true` como en el cambio de horario.

## Prueba rápida (curl)

```bash
curl -s "https://<gestion>/api/lms/autoservicio/estado?alumno_id=<id>" -H "x-lms-secret: $SECRETO"

curl -s "https://<gestion>/api/lms/autoservicio/huecos?alumno_id=<id>&modo=fijo&sesion=Martes_15%3A00" \
  -H "x-lms-secret: $SECRETO"

curl -s -X POST "https://<gestion>/api/lms/autoservicio/cambiar-horario" \
  -H "x-lms-secret: $SECRETO" -H "Content-Type: application/json" \
  -d '{"alumno_id":"<id>","modo":"fijo","sesion_origen":{"dia":"Martes","hora":"15:00","duracion":2},"destino":{"dia":"Jueves","hora":"10:00","duracion":2,"fecha":"2026-10-15"},"idempotency_key":"<uuid>"}'
```

Cambio de profesor:

```bash
curl -s "https://<gestion>/api/lms/autoservicio/huecos-profesores?alumno_id=<id>&franja=tarde" -H "x-lms-secret: $SECRETO"

curl -s "https://<gestion>/api/lms/autoservicio/huecos-profesores?alumno_id=<id>&profesor_id=<id>" -H "x-lms-secret: $SECRETO"

curl -s -X POST "https://<gestion>/api/lms/autoservicio/cambiar-profesor" \
  -H "x-lms-secret: $SECRETO" -H "Content-Type: application/json" \
  -d '{"alumno_id":"<id>","profesor_id":"<id>","destinos":[{"dia":"Lunes","hora":"10:00","duracion":1}],"idempotency_key":"<uuid>"}'
```

Los GET solo leen. **Los POST cambian datos de verdad**: el de horario, el
calendario; el de profesor, además, avisa al profesor nuevo (correo y campanita)
y al anterior. Solo se prueban con alumnos del perfil de prueba (profesor `t1`).
