# Contrato Gestión ↔ LMS: autoservicio de cambio de horario y de profesor

Versión 3 · 13 de octubre de 2026 · implementado en Gestión (academy-scheduler).

El alumno, desde el LMS, cambia el horario de sus clases **con su mismo
profesor**, de dos formas:

- **«Solo esta clase»** (`modo: "puntual"`): mueve una clase concreta a otro
  hueco. El resto de su horario no cambia.
- **«Desde ahora»** (`modo: "fijo"`): cambia su horario recurrente.

Y también puede **cambiar de profesor** (endpoints 4 y 5): pasa TODAS sus
sesiones a otro profesor, con las mismas duraciones. **Desde la versión 3 el
alumno no ve ni elige profesores**: elige solo horarios, uno por sesión, y
Gestión le asigna el profesor al confirmar.

### Cambios de la versión 3 (cambio de profesor)

- `GET huecos-profesores` devuelve **horarios sin ningún dato del profesor** (ni
  id ni nombre), paso a paso con `elegidos`. Ya no existen `profesor_id`, `tipo`,
  `huecos` ni el orden aleatorio por profesor.
- `POST cambiar-profesor` ya no lleva `profesor_id` (si llega, se ignora).
  Gestión elige el profesor y, si alguien ocupa un hueco mientras guarda, prueba
  con otro.
- La respuesta 200 trae `profesor: { nombre }` (solo el nombre, para la pantalla
  final). Ya no trae `profesor_nuevo` ni `profesor_anterior`.
- El LMS deja de recibir `MISMO_PROFESOR`, `PROFESOR_NO_EXISTE`,
  `PROFESOR_ARCHIVADO`, `PROFESOR_DE_PRUEBA` y `CALENDARIO_SIN_ACTUALIZAR` en
  estos dos endpoints. No hay códigos nuevos: «ningún profesor tiene libres a la
  vez esos horarios» es `SLOT_NO_DISPONIBLE`, y «alguien los ocupó mientras se
  guardaba, también con los otros profesores» es `HUECO_YA_OCUPADO`.
- Dos horarios del cambio que van **seguidos** el mismo día (10–12 y 12–13) ya
  no valen: en el calendario serían una sola clase de 3 h. GET no los ofrece y
  POST los rechaza con `DATOS_INVALIDOS`, igual que si se solapan.

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
| `duracion` | Entero, en horas (de 1 a 5) | `2` |
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
| 422 | `SESIONES_NO_COINCIDEN` | Los `destinos` (o los `elegidos` de GET) no son uno por cada sesión actual con su misma duración: falta alguna, sobra alguna o una duración no coincide (también con `destinos: []`) |
| 409 | `SLOT_NO_DISPONIBLE` | Ningún profesor tiene libres **a la vez** todos los destinos (volver a elegir desde GET) |
| 409 | `HUECO_YA_OCUPADO` | Alguien ocupó un horario mientras se guardaba, con el profesor elegido y con los siguientes que lo cubrían (hasta 3); no se escribió nada |
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
  **Decisión cerrada (12/10/2026):** se queda así a propósito; el alumno se va de
  ese profesor, así que su calendario no cuenta. Solo cuentan los de los
  profesores a los que se puede pasar: un profesor con el calendario sin revisar
  no es candidato (sus horarios no salen en el endpoint 4).
- En ese caso GET estado llega con `sesiones: []`: las sesiones actuales para el
  cambio de profesor salen de `sesiones` en el endpoint 4.

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

## 4. Horarios para cambiar de profesor

`GET /api/lms/autoservicio/huecos-profesores?alumno_id=<id>[&elegidos=<JSON>][&dia=<día>][&franja=<franja>]`

El alumno **no ve profesores**. Elige un horario para cada una de sus sesiones,
**de una en una y en el orden de `sesiones`**; en cada paso el LMS manda los que
ya eligió en `elegidos` y Gestión devuelve los horarios posibles para la
**siguiente** sesión. Ninguna respuesta lleva datos del profesor (ni id ni
nombre).

- `elegidos`: lista JSON de `{ "dia", "hora", "duracion" }`, **codificada en la
  URL** (`encodeURIComponent(JSON.stringify(elegidos))`). `elegidos[i]` es el
  horario nuevo de `sesiones[i]` y tiene que durar lo mismo. Sin `elegidos` (o
  `[]`): la primera sesión.
- `dia` y `franja`: filtros opcionales sobre los horarios devueltos (el LMS
  también puede filtrar por su cuenta). `franja` va por hora de **inicio**
  (España), las mismas franjas que el LMS:

  | `franja` | Horas de inicio |
  |---|---|
  | `manana` | 06:00–11:59 |
  | `mediodia` | 12:00–14:59 |
  | `tarde` | 15:00–19:59 |
  | `noche` | 20:00–23:59 y la madrugada (00:00–05:59) |

  Otro valor → 422 `DATOS_INVALIDOS`.

**Paso 1, sin `elegidos`** (sesiones de 2 h y 1 h):

```json
{
  "ok": true,
  "sesiones": [
    { "dia": "Martes", "hora": "15:00", "duracion": 2 },
    { "dia": "Jueves", "hora": "10:00", "duracion": 1 }
  ],
  "siguiente": { "indice": 0, "duracion": 2 },
  "elegidos_disponibles": true,
  "horarios": [
    { "dia": "Lunes", "hora": "10:00", "duracion": 2, "fecha_primera_clase": "2026-10-12" },
    { "dia": "Martes", "hora": "19:00", "duracion": 2, "fecha_primera_clase": "2026-10-13" },
    { "dia": "Viernes", "hora": "09:00", "duracion": 2, "fecha_primera_clase": "2026-10-16" }
  ]
}
```

**Paso 2**, con `elegidos=[{"dia":"Lunes","hora":"10:00","duracion":2}]`:

```json
{
  "ok": true,
  "sesiones": [
    { "dia": "Martes", "hora": "15:00", "duracion": 2 },
    { "dia": "Jueves", "hora": "10:00", "duracion": 1 }
  ],
  "siguiente": { "indice": 1, "duracion": 1 },
  "elegidos_disponibles": true,
  "horarios": [
    { "dia": "Martes", "hora": "19:00", "duracion": 1, "fecha_primera_clase": "2026-10-13" },
    { "dia": "Martes", "hora": "20:00", "duracion": 1, "fecha_primera_clase": "2026-10-13" },
    { "dia": "Miércoles", "hora": "18:00", "duracion": 1, "fecha_primera_clase": "2026-10-14" }
  ]
}
```

**Paso 3**, con los dos elegidos: `"siguiente": null`, `"horarios": []`. Toca
el POST.

- `sesiones`: sus sesiones actuales, en orden (siempre llegan, también cuando GET
  estado trae `sesiones: []` por `CALENDARIO_SIN_ACTUALIZAR`). El cambio tiene
  que darles destino a TODAS, con las mismas duraciones.
- `siguiente`: la sesión para la que son los `horarios` (`indice` =
  `elegidos.length`) y su duración. `null` cuando ya están todas elegidas.
- `horarios`: los horarios **fijos** semanales libres para esa sesión **en algún
  profesor que también tiene libres TODOS los `elegidos`**, sin solaparse ni ir
  seguidos con ellos. Así, al terminar, siempre hay al menos un profesor que
  cubre todo (salvo que alguien ocupe un hueco entre medias). **Sin duplicados**
  (el mismo horario libre con dos profesores sale una vez) y **ordenados por día
  y hora**. `fecha_primera_clase` es la primera clase con ese horario, siempre a
  más de 24 h.
- `elegidos_disponibles: false`: ningún profesor tiene ya libres todos los
  `elegidos` (alguien ocupó uno). Es un **200 con `horarios: []`**: el LMS
  vuelve a empezar desde el paso 1.
- Una lista vacía con `elegidos_disponibles: true` significa que no hay ningún
  horario para esa sesión compatible con lo elegido: el LMS deja cambiar un
  elegido anterior.
- **Profesores candidatos** (Gestión los usa, el LMS no los ve): todos los de la
  academia excepto el suyo, los que ya no están, el perfil de prueba y los que
  tienen el calendario sin revisar desde hace más de 30 días.
- Errores: `elegidos` mal formado (JSON inválido, día u hora inválidos, dos que
  se solapan o van seguidos) → 422 `DATOS_INVALIDOS`; más `elegidos` que
  sesiones o uno con otra duración que su sesión → 422 `SESIONES_NO_COINCIDEN`;
  si el alumno no puede cambiar de profesor, el mismo error que el POST
  (`NO_ELEGIBLE`, `RECUPERACION_PENDIENTE`…).

## 5. Cambiar de profesor

`POST /api/lms/autoservicio/cambiar-profesor`

```json
{
  "alumno_id": "<students.id>",
  "destinos": [
    { "dia": "Lunes", "hora": "10:00", "duracion": 2 },
    { "dia": "Miércoles", "hora": "18:00", "duracion": 1 }
  ],
  "idempotency_key": "c0a8f1e2-…"
}
```

- `destinos`: los `elegidos` del endpoint 4, uno por cada sesión actual **con las
  mismas duraciones**. Si falta alguna, sobra alguna o una duración no coincide:
  422 `SESIONES_NO_COINCIDEN`. Dos destinos que se solapan o van seguidos el
  mismo día: 422 `DATOS_INVALIDOS`. Vale para cualquier reparto de 1 a 5 h
  semanales (p. ej. 3 h = 3, 2+1 o 1+1+1; 4 h = 4, 3+1, 2+2, 2+1+1 o 1+1+1+1);
  una sesión de 2 h son 2 casillas seguidas.
- **No lleva `profesor_id`**: si llega, se ignora.
- `idempotency_key`: igual que en el cambio de horario (UUID por intento,
  reutilizado en sus reintentos; también vale la cabecera `Idempotency-Key`).
  Hasta 128 caracteres: letras, números, `-`, `_`, `.` o `:` (otro formato → 422
  `DATOS_INVALIDOS`). Un reintento de un cambio ya hecho devuelve 200 con el
  mismo resultado, aunque Gestión hubiera probado con varios profesores. La
  clave de un cambio de otro alumno → 422 `DATOS_INVALIDOS`.

Gestión revalida todo y elige el profesor en el momento:

1. que el alumno pueda (elegibilidad, recuperaciones);
2. **antelación**: la próxima clase de cada sesión actual y la primera de cada
   sesión nueva, a **más de 24 h**. Si falla por la actual:
   `ANTELACION_INSUFICIENTE` con `disponible_desde`;
3. los profesores candidatos que tienen libres **todos** los destinos. Si no hay
   ninguno: 409 `SLOT_NO_DISPONIBLE` (volver al endpoint 4);
4. elige el mejor: **menos alumnos activos**; si empatan, el calendario
   **actualizado más recientemente**; si empatan, el id menor (siempre el mismo
   para la misma situación);
5. si al guardar alguien ocupó uno de los horarios con ese profesor, prueba con
   el siguiente que cubra todo, **hasta 3 profesores**. Si no lo consigue: 409
   `HUECO_YA_OCUPADO`, sin nada escrito.

Respuesta 200:

```json
{
  "ok": true,
  "profesor": { "nombre": "Carla" },
  "sesiones_antes": [ { "dia": "Martes", "hora": "15:00", "duracion": 2 }, { "dia": "Jueves", "hora": "10:00", "duracion": 1 } ],
  "sesiones_despues": [ { "dia": "Lunes", "hora": "10:00", "duracion": 2 }, { "dia": "Miércoles", "hora": "18:00", "duracion": 1 } ]
}
```

- `profesor.nombre`: solo para la pantalla final. No hay id del profesor.
- `sesiones_antes` y `sesiones_despues` van ordenadas por día y hora.

Errores típicos del POST:

```json
{ "ok": false, "codigo": "SLOT_NO_DISPONIBLE", "mensaje": "Ese hueco ya no está libre. Elige otro." }
```

```json
{ "ok": false, "codigo": "HUECO_YA_OCUPADO", "mensaje": "Alguien acaba de ocupar ese hueco. Elige otro." }
```

Efectos en Gestión (los del cambio de profesor de siempre):

- el alumno pasa al calendario del profesor nuevo y sale del anterior;
- correo y campanita al profesor **nuevo** con la **ficha del alumno** (nivel,
  objetivo, plan y horas, horarios nuevos, perfil y sus últimas clases), en tono
  neutro («Se incorpora a tus clases…»); campanita al **anterior**; aviso al
  equipo;
- **email de bienvenida al alumno** con su profesor nuevo (variante «cambio de
  profesor»), con el enlace al formulario o a la prueba si los tiene pendientes;
- el enlace de Meet se borra: el profesor nuevo define el suyo;
- no afecta a la puntuación de ningún profesor.

Si falla un aviso o un email, el cambio **sigue hecho** (`ok: true`). Si queda a
medias, `a_medias: true` como en el cambio de horario (y Gestión no prueba con
otro profesor).

## Prueba rápida (curl)

```bash
curl -s "https://<gestion>/api/lms/autoservicio/estado?alumno_id=<id>" -H "x-lms-secret: $SECRETO"

curl -s "https://<gestion>/api/lms/autoservicio/huecos?alumno_id=<id>&modo=fijo&sesion=Martes_15%3A00" \
  -H "x-lms-secret: $SECRETO"

curl -s -X POST "https://<gestion>/api/lms/autoservicio/cambiar-horario" \
  -H "x-lms-secret: $SECRETO" -H "Content-Type: application/json" \
  -d '{"alumno_id":"<id>","modo":"fijo","sesion_origen":{"dia":"Martes","hora":"15:00","duracion":2},"destino":{"dia":"Jueves","hora":"10:00","duracion":2,"fecha":"2026-10-15"},"idempotency_key":"<uuid>"}'
```

Cambio de profesor, paso a paso (`elegidos` codificado en la URL):

```bash
curl -s "https://<gestion>/api/lms/autoservicio/huecos-profesores?alumno_id=<id>" -H "x-lms-secret: $SECRETO"

curl -s -G "https://<gestion>/api/lms/autoservicio/huecos-profesores" -H "x-lms-secret: $SECRETO" \
  --data-urlencode "alumno_id=<id>" \
  --data-urlencode 'elegidos=[{"dia":"Lunes","hora":"10:00","duracion":2}]'

curl -s -X POST "https://<gestion>/api/lms/autoservicio/cambiar-profesor" \
  -H "x-lms-secret: $SECRETO" -H "Content-Type: application/json" \
  -d '{"alumno_id":"<id>","destinos":[{"dia":"Lunes","hora":"10:00","duracion":2},{"dia":"Miércoles","hora":"18:00","duracion":1}],"idempotency_key":"<uuid>"}'
```

Los GET solo leen. **Los POST cambian datos de verdad**: el de horario, el
calendario; el de profesor, además, avisa al profesor nuevo (correo y campanita)
y al anterior. Solo se prueban con alumnos del perfil de prueba (profesor `t1`).
