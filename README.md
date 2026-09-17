This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Crons y tareas programadas (DRC Gestión)

El proyecto está en el plan **Hobby** de Vercel: los crons solo pueden ser **diarios**. Por eso hay tres, y lo que necesita más frecuencia se expone como endpoint para llamarlo desde fuera (Zapier).

Todos los endpoints de `/api/cron/*` comparten el mismo guardián (`lib/cronAuth.ts`):

- **Secreto**: cabecera `Authorization: Bearer <CRON_SECRET>` (Vercel la manda sola cuando la variable existe en el proyecto) o `?secret=<CRON_SECRET>`. Se compara en tiempo constante.
- **Cliente admin de Supabase**: usan `SUPABASE_SERVICE_ROLE_KEY`. Si falta, responden `500` con el nombre de la variable y no hacen nada.

| Cron (`vercel.json`) | Horario UTC | Hora de España | Qué hace |
|---|---|---|---|
| `/api/cron/daily-transcript-reminder` | `0 22 * * *` | 00:00 (verano) · 23:00 (invierno) | Email al profesor con los transcripts de hoy sin subir **y** avisos de campanita del plazo de 24 h (menos de 6 h / recién vencidas). |
| `/api/cron/check-ending-plans` | `0 12 * * *` | 14:00 · 13:00 | Aviso interno de planes que terminan en 7 días. |
| `/api/cron/followups-nivel` | `0 8 * * *` | **10:00 (verano) · 09:00 (invierno)** | Follow-ups al alumno que no completó su formulario + prueba de nivel. |

Parámetros útiles en todos: `?dry=1` (simula sin escribir ni enviar). En `followups-nivel` además `?test=tu@email` (manda los 6 correos de ejemplo) y `?limit=N`.

### Plazo de 24 h del transcript

Desde el **22/09/2026** (`TRANSCRIPT_DEADLINE_START_DATE` en `lib/transcriptDeadline.ts`) el profesor tiene 24 h desde el **fin** de la clase (hora de España) para subir el transcript. Pasado el plazo la clase queda **vencida**: no se valida ni se paga, pero sí consume cupo del alumno. El estado se calcula al vuelo (no hay cron que lo marque); lo único que se guarda es la reapertura del admin (botón «Reabrir plazo» en Finanzas, con motivo).

**Avisos con más frecuencia que una vez al día** — el endpoint `/api/cron/transcripts-vencidos` (GET o POST, mismo secreto) recorre las clases y deja las notificaciones de campanita que falten. Es idempotente (id determinista por clase y tipo), así que se puede llamar cada hora. No está en `vercel.json`; para hacerlo con Zapier:

1. Zapier → *Schedule by Zapier* → *Every Hour*.
2. Acción *Webhooks by Zapier* → **POST** a `https://academy-scheduler-aqpt.vercel.app/api/cron/transcripts-vencidos`.
3. Cabecera `Authorization` con valor `Bearer <CRON_SECRET>` (el mismo valor que en Vercel).

### Follow-ups de la prueba de nivel

Un solo reloj por alumno: **día 0 = fecha del enlace** (`form_tokens.created_at`; para los que nunca tuvieron enlace, el día en que el cron se lo genera). Cadencia: días **1, 2, 3 · 6, 9 · 16, 23, 30, 37, 44, 51, 58, 65** (13 envíos). Se corta al completar la prueba, al darse de baja, al eliminar al alumno o con **«No enviar más»**.

- Registro de envíos: tabla `level_test_followups` (una fila por alumno y número de envío; índice único = idempotente).
- Remitente `notificaciones@drcacademy.com`, respuestas a `alumnos@drcacademy.com`.
- **Si un alumno responde pidiendo que no le escribamos más**, el equipo entra en *Admin → Tests de nivel*, abre su ficha y pulsa **«No enviar más»** (`students.followup_opt_out`). Desde ese momento ni el cron ni el botón «Recordar» le escriben; «Volver a enviar» quita la marca.
- El botón «Recordar» del admin manda el siguiente envío ya, fuera de la cadencia (uno por día y alumno como máximo).

### Variables de entorno que necesitan los crons

`CRON_SECRET` · `SUPABASE_SERVICE_ROLE_KEY` · `RESEND_API_KEY` · `NEXT_PUBLIC_APP_URL` · `STUDENT_REPLY_TO_EMAIL` (opcional).

### SQL

Antes de desplegar la rama `plazo-24h-y-followups` hay que correr `supabase-plazo-24h-followups.sql` en el SQL editor de Supabase (idempotente).
