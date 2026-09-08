# Dashboard principal — propuesta

Maqueta navegable: **`/dashboard-preview`** (solo admin). Todos los números que
se ven ahí están escritos a mano; no hay ninguna consulta nueva.

Este documento explica, bloque por bloque, **qué muestra**, **de dónde saldría el
dato de verdad** y **cuánto cuesta traerlo**. Lo marcado con **[DECISIÓN]** es una
regla de negocio que tenés que fijar vos: el código no puede inventarla.

## Cómo leer el coste

| | Qué significa |
|---|---|
| **Gratis** | El dato ya está cargado en memoria cuando abrís la app (contexto `useTeachers`: profesores, alumnos, asignaciones, clases registradas, eventos de scoring). Pintarlo no cuesta nada. |
| **Barato** | Una consulta de conteo, o una tabla chica. Milisegundos. |
| **Medio** | Una tabla entera de tamaño moderado (unos cientos de filas) pidiendo solo las columnas necesarias. |
| **Caro** | Sale de la red externa (WooCommerce) o cruza varias tablas grandes. Conviene cachearlo o cargarlo aparte, sin bloquear la pantalla. |

---

## 1 · Barra superior

Saludo, fecha y cinco números que resumen el negocio.

| Dato | De dónde sale | Coste |
|---|---|---|
| Alumnos activos | Regla única de `lib/subscriptionAccess.ts`: da acceso quien tiene suscripción activa en Woo, override manual vigente, u Oritalk activo | **Caro** (necesita Woo) |
| Profesores activos | `teachers` del contexto, descartando los que están de vacaciones | Gratis |
| Clases esta semana | `class_records` de la semana en curso | Barato |
| Coste de profesores del mes | `calculateTeacherFinance` (lib/finance.ts), sumando el `totalAPagar` de cada profesor | **Medio** — hay que llamarlo una vez por profesor |
| Ocupación | Clases confirmadas dividido por los cupos totales de los calendarios | Medio |

**[DECISIÓN] Alumnos activos con Woo caído.** Cuando WooCommerce no contesta, el
número correcto no es cero: falta uno de los tres orígenes. ¿Preferís que la
tarjeta muestre un guion y avise, o que enseñe el último valor conocido con la
hora en que se leyó?

**[DECISIÓN] Qué es "esta semana".** De lunes a domingo en hora de Madrid, supongo.
Confirmalo, porque de eso depende que el número cambie los domingos a medianoche.

**[DECISIÓN] Qué cuenta como "cupo" para la ocupación.** Hoy `freeSpots` sale del
calendario de cada profesor. Si un profesor tiene el calendario abierto de 8 a 23
pero solo quiere trabajar seis horas, su ocupación va a parecer bajísima. ¿La
calculamos sobre las horas que el profesor declara, o sobre las que tiene abiertas?

**[DECISIÓN] A partir de qué porcentaje la ocupación es alerta.** Propongo: verde
por encima del 75%, amarillo entre 60 y 75, rojo por debajo de 60.

---

## 2 · Requiere acción hoy

Ocho tarjetas con un número y un destino. Es lo único de la pantalla pensado para
que alguien haga algo hoy, así que va arriba y con color.

| Tarjeta | De dónde sale | Coste |
|---|---|---|
| Validaciones pendientes | `dbCountPendingValidations()` — ya se usa para el badge de la pestaña | Barato |
| Emails de presentación tarde | `getPresentationEmailStatus()` sobre las asignaciones ya cargadas | Gratis |
| Alumnos en riesgo | Alertas abiertas en `student_profiles` (módulo de intervenciones) | Medio |
| Transcripts sin subir | Cruce de `class_join_logs` con `class_analyses`, que es lo que hace `pendingClassesFor` | Medio |
| Próximos a cancelar sin contactar | `lib/endingPlans.ts` + el marcador de contacto de ventas | Medio |
| Solicitudes de revisión | `dbCountPendingReviewRequests()` — ya se usa en el badge de Finanzas | Barato |
| Alumnos sin profesor | `dbAuditStudentAssignments()`, rama `studentsWithoutAssignment` | Medio |
| Análisis de IA fallidos | `class_analyses` con `analysis_status = 'failed'` | Barato |

**[DECISIÓN] Cuándo un transcript está "atrasado".** Hoy la app sabe que una clase
tuvo acceso y no tiene transcript, pero no cuándo eso pasa a ser un problema. Un
profesor que da clase a las 20:00 y sube el transcript a la mañana siguiente no
debería aparecer en rojo. Propongo contarlo a partir de las 24 horas.

**[DECISIÓN] Qué es "sin contactar".** Hay dos marcas distintas: el aviso
automático que manda el sistema y el contacto manual de ventas. ¿La tarjeta cuenta
a quien no tiene ninguna de las dos, o solo a quien no tuvo contacto humano?

**[DECISIÓN] El orden de las tarjetas.** Ahora está fijo, con las rojas primero.
La alternativa es ordenarlas por urgencia real cada día. Es más útil pero también
significa que la tarjeta que buscás cambia de sitio; me inclino por dejarlo fijo.

---

## 3 · Salud del negocio

Tres tarjetas y un embudo. Esto ya no pide acción: es para saber cómo va el mes.

### Suscripciones por estado

Los estados de WooCommerce con su recuento, marcando cuáles dan acceso a clase.
Sale de `loadSubscriptionsSnapshot()` (`lib/externalSubscriptions.ts`), que ya
devuelve `woocommerce.por_estado` y `dan_acceso`. **Caro**: llama a la API de Woo.

> Ojo: según las notas del proyecto, **WooCommerce no se puede probar en local**.
> Todo lo que dependa de este bloque solo se verifica contra el deploy.

### Alumnos activos por origen

WooCommerce / manual / Oritalk, en una barra apilada. Sale del mismo snapshot
(`alumnos.por_origen`). Los tres son excluyentes por precedencia —Oritalk gana a
manual, y manual gana a suscripción— así que suman el total de activos. **Caro**,
por la misma razón.

### Altas y bajas · 6 meses

Barras verdes y rojas por mes, con el neto debajo. Las bajas salen de
`student_dropouts`, que ya registra cada baja. **Barato.**

**[DECISIÓN] Qué cuenta como alta.** Hoy no hay una tabla de altas. Se puede
derivar de la fecha de creación de la asignación, o de la fecha de la primera
clase registrada. No es lo mismo: entre las dos suele haber una o dos semanas.

### Captación

Embudo de cuatro pasos: formulario enviado → formulario completo → test de nivel
hecho → primera clase dada. Los tres primeros salen de `form_tokens` y
`level_test_sessions`; el último, de la primera clase en `class_records`.
**Medio.**

**[DECISIÓN] Ventana del embudo.** ¿Del mes en curso, o de los últimos 90 días? Con
un mes, en la primera semana el embudo se ve casi vacío y no dice nada.

---

## 4 · Riesgo de baja

**Acá hay que corregir el pedido.** Pediste una distribución verde / amarillo /
rojo, pero el sistema **no tiene amarillo**: en julio de 2026 se eliminó a
propósito y hoy la IA solo clasifica en **verde o rojo**
(`RiskSignal = 'verde' | 'rojo'`). Maqueté dos niveles, que es lo que hay.

**[DECISIÓN] ¿Reintroducimos un nivel intermedio?** Si querés un amarillo, hay que
decidir qué lo dispara, y no puede ser la IA (se le quitó esa capacidad a
propósito). Podría ser una regla mecánica: por ejemplo, alumno sin alerta roja
pero con dos faltas en el mes. Es un cambio de política, no de pantalla.

| Dato | De dónde sale | Coste |
|---|---|---|
| Reparto verde / rojo | Última señal de riesgo de cada alumno en `class_analyses` | Medio |
| Los cinco más urgentes | Alertas abiertas con su causa y el profesor | Medio |

**[DECISIÓN] Qué ordena "más urgente".** Propongo: días que lleva la alerta
abierta sin intervención registrada. Otra opción es cuánto paga el alumno, si lo
que se quiere proteger es la facturación.

---

## 5 · Operación de clases

| Dato | De dónde sale | Coste |
|---|---|---|
| Dadas sobre programadas | `buildClassFunnel()` (lib/classFunnel.ts) ya separa las clases con registro de las que tuvieron acceso sin transcript y de las que están fuera del calendario | Medio |
| Faltas sin aviso del mes | `scoring_events` de tipo `falta_sin_aviso_penalizacion`, descartando las revertidas | Gratis |
| Recuperaciones pendientes | `lib/recoveryLedger.ts` cruzado con las clases perdidas del mes | Medio |
| Sesiones de 2 h | Filas de finanzas con dos unidades de facturación | Medio |
| Cupos libres por franja | Cuadrículas de `teacher_calendars`, agrupando por tramo horario | Medio |

**[DECISIÓN] Las franjas horarias.** Maqueté cinco tramos de tres horas (08–11,
11–14, 14–17, 17–20, 20–23) en hora de Madrid. Decime si preferís otros cortes;
los profesores están todos en Argentina, así que si el tramo te sirve para
reclutar puede convenir mirarlo también en su hora.

**[DECISIÓN] Qué faltas se cuentan.** La falta del profesor y la del alumno son
cosas distintas y se registran por separado. Propongo mostrar solo la del
profesor, que es la que penaliza, y dejar la del alumno para el detalle.

---

## 6 · Profesores

Ranking corto por clases del mes, con dos etiquetas por profesor: cupos libres y
transcripts sin subir. Al lado, cuántos profesores usan la generación de clases
con IA.

| Dato | De dónde sale | Coste |
|---|---|---|
| Clases del mes | `class_records` agrupadas por profesor | Barato |
| Cupos libres | `freeSpots`, ya calculado en el contexto | Gratis |
| Transcripts sin subir | El mismo cruce de la tarjeta de acción | Medio |
| Uso de IA | Tabla `ai_class_generations` (`lib/aiUsage.ts`) | Barato |

**[DECISIÓN] Cuántos profesores mostrar y ordenados por qué.** Maqueté los seis
primeros por número de clases. Si lo que querés detectar es quién está flojo, el
ranking al revés es más útil: los seis con menos carga.

---

## 7 · Finanzas del mes

Tres tarjetas: total a pagar con la comparación contra el mes anterior, en qué
estado está ese dinero (pagable / a revisar / retenido) y cuántos profesores ya
cobraron.

Todo sale de `calculateTeacherFinance` (lib/finance.ts), que ya devuelve
`montoPagable`, `montoARevisar`, `montoRetenido`, `bonusFromScoring`,
`penaltiesFromScoring`, `totalAPagar` y `paymentStatus`. **Medio**: hay que
llamarlo una vez por profesor, y cada llamada cruza clases, tarifas, aprobaciones
manuales y eventos de scoring.

**[DECISIÓN] Si esto se carga al abrir el dashboard.** Es el bloque más pesado de
la pantalla. Se puede cargar aparte, después del resto, con las tarjetas en gris
mientras llega. Yo lo haría así.

**[DECISIÓN] Comparación con el mes anterior.** ¿Contra el mes cerrado completo, o
contra el mismo día del mes anterior? A día 5, comparar contra un mes entero hace
que siempre parezca que se gasta menos.

---

## 8 · Herramientas de mantenimiento

Los cuatro desplegables actuales, sin cambios y plegados al final: auditoría de
vínculos, sincronización de calendario, sincronización con WooCommerce y estilo de
los textos de IA. Ya funcionan y ya vienen cerrados; lo único que cambia es que
tienen un título de sección propio.

---

## Dos cosas que conviene arreglar al conectar

**La auditoría lee los calendarios dos veces.** `dbAuditStudentAssignments()` pide
las cuadrículas de todos los profesores una vez por cada uno de sus dos
sub-cálculos. Es la consulta más pesada de la pantalla y ya está preparada para
recibir los datos ya leídos, así que es un arreglo chico.

**Woo conviene cachearlo.** Los bloques de suscripciones son los únicos que salen
por red a un servicio externo. Si el dashboard es la pantalla de entrada del
admin, se va a cargar muchas veces al día. Propongo guardar el último resultado
unos minutos y mostrar la hora de la última lectura.
