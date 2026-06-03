-- ============================================================
-- ACADEMY SCHEDULER — Schema Supabase
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- ── TEACHERS ────────────────────────────────────────────────
create table if not exists teachers (
  id          text primary key,
  name        text not null,
  email       text not null unique,
  avatar      text not null,
  username    text not null unique,
  password    text not null default 'profe123',
  specialties text[] default array['Inglés'],
  created_at  timestamptz default now()
);

-- ── TEACHER CALENDARS ────────────────────────────────────────
-- One row per teacher, grid stored as JSON
create table if not exists teacher_calendars (
  teacher_id  text primary key references teachers(id) on delete cascade,
  grid        jsonb not null default '{}',
  updated_at  timestamptz default now()
);

-- ── STUDENTS ─────────────────────────────────────────────────
create table if not exists students (
  id          text primary key,
  name        text not null,
  email       text not null unique,
  phone       text,
  level       text not null default 'B1',
  plan        text not null default 'Plan Individual',
  notes       text,
  created_at  timestamptz default now()
);

-- ── ASSIGNMENTS ──────────────────────────────────────────────
create table if not exists assignments (
  id            text primary key,
  teacher_id    text not null references teachers(id),
  teacher_name  text not null,
  teacher_email text not null,
  student_id    text not null references students(id),
  student_name  text not null,
  student_email text not null,
  student_level text not null,
  slots         jsonb not null default '[]',   -- [{day, hour}]
  objetivo      text,
  plan          text,
  weekly_hours  int not null default 2,
  availability  text,
  notes         text,
  created_at    timestamptz default now()
);

-- ── APP USERS (setters + admins) ─────────────────────────────
create table if not exists app_users (
  id           text primary key,
  username     text not null unique,
  password     text not null,
  role         text not null check (role in ('admin','setter','teacher')),
  teacher_id   text references teachers(id),
  display_name text not null,
  created_at   timestamptz default now()
);

-- ── SEED: admin and setter users ────────────────────────────
insert into app_users (id, username, password, role, display_name) values
  ('admin1',  'admin',   'admin123',  'admin',  'Administrador'),
  ('setter1', 'setter',  'setter123', 'setter', 'Setter'),
  ('setter2', 'setter2', 'setter123', 'setter', 'Setter 2')
on conflict (username) do nothing;

-- ── SEED: 30 teachers ───────────────────────────────────────
insert into teachers (id, name, email, avatar, username, password) values
  ('t1',  'Sebastian',   'sebastian@drcacademy.com',   'SE', 'sebastian',  'profe123'),
  ('t2',  'Mauricio',    'mauricio@drcacademy.com',    'MA', 'mauricio',   'profe123'),
  ('t3',  'Johny',       'johny@drcacademy.com',       'JO', 'johny',      'profe123'),
  ('t4',  'Barbara',     'barbara@drcacademy.com',     'BA', 'barbara',    'profe123'),
  ('t5',  'Ana',         'ana@drcacademy.com',         'AN', 'ana',        'profe123'),
  ('t6',  'Ignacio',     'ignacio@drcacademy.com',     'IG', 'ignacio',    'profe123'),
  ('t7',  'Daiana.M',    'daianam@drcacademy.com',     'DM', 'daianam',    'profe123'),
  ('t8',  'Victoria',    'victoria@drcacademy.com',    'VI', 'victoria',   'profe123'),
  ('t9',  'Silvia',      'silvia@drcacademy.com',      'SI', 'silvia',     'profe123'),
  ('t10', 'Sol.G',       'solg@drcacademy.com',        'SG', 'solg',       'profe123'),
  ('t11', 'Milagros',    'milagros@drcacademy.com',    'MI', 'milagros',   'profe123'),
  ('t12', 'MFlorencia',  'mflorencia@drcacademy.com',  'MF', 'mflorencia', 'profe123'),
  ('t13', 'Sol',         'sol@drcacademy.com',         'SO', 'sol',        'profe123'),
  ('t14', 'Cristian',    'cristian@drcacademy.com',    'CR', 'cristian',   'profe123'),
  ('t15', 'DanielaN',    'danielan@drcacademy.com',    'DN', 'danielan',   'profe123'),
  ('t16', 'Rebeca',      'rebeca@drcacademy.com',      'RE', 'rebeca',     'profe123'),
  ('t17', 'Marina',      'marina@drcacademy.com',      'MR', 'marina',     'profe123'),
  ('t18', 'Jimena',      'jimena@drcacademy.com',      'JI', 'jimena',     'profe123'),
  ('t19', 'Daniela',     'daniela@drcacademy.com',     'DA', 'daniela',    'profe123'),
  ('t20', 'Antonella',   'antonella@drcacademy.com',   'AT', 'antonella',  'profe123'),
  ('t21', 'Wanda',       'wanda@drcacademy.com',       'WA', 'wanda',      'profe123'),
  ('t22', 'Luciana',     'luciana@drcacademy.com',     'LU', 'luciana',    'profe123'),
  ('t23', 'Agustin',     'agustin@drcacademy.com',     'AG', 'agustin',    'profe123'),
  ('t24', 'Liliana',     'liliana@drcacademy.com',     'LI', 'liliana',    'profe123'),
  ('t25', 'Dana',        'dana@drcacademy.com',        'DN', 'dana',       'profe123'),
  ('t26', 'Vanesa',      'vanesa@drcacademy.com',      'VN', 'vanesa',     'profe123'),
  ('t27', 'Carmela',     'carmela@drcacademy.com',     'CA', 'carmela',    'profe123'),
  ('t28', 'Chiara',      'chiara@drcacademy.com',      'CH', 'chiara',     'profe123'),
  ('t29', 'Maribel',     'maribel@drcacademy.com',     'MB', 'maribel',    'profe123'),
  ('t30', 'Daiana',      'daiana@drcacademy.com',      'DI', 'daiana',     'profe123')
on conflict (id) do nothing;

-- Link teachers to app_users
insert into app_users (id, username, password, role, teacher_id, display_name) values
  ('u_t1',  'sebastian',  'profe123', 'teacher', 't1',  'Sebastian'),
  ('u_t2',  'mauricio',   'profe123', 'teacher', 't2',  'Mauricio'),
  ('u_t3',  'johny',      'profe123', 'teacher', 't3',  'Johny'),
  ('u_t4',  'barbara',    'profe123', 'teacher', 't4',  'Barbara'),
  ('u_t5',  'ana',        'profe123', 'teacher', 't5',  'Ana'),
  ('u_t6',  'ignacio',    'profe123', 'teacher', 't6',  'Ignacio'),
  ('u_t7',  'daianam',    'profe123', 'teacher', 't7',  'Daiana M.'),
  ('u_t8',  'victoria',   'profe123', 'teacher', 't8',  'Victoria'),
  ('u_t9',  'silvia',     'profe123', 'teacher', 't9',  'Silvia'),
  ('u_t10', 'solg',       'profe123', 'teacher', 't10', 'Sol G.'),
  ('u_t11', 'milagros',   'profe123', 'teacher', 't11', 'Milagros'),
  ('u_t12', 'mflorencia', 'profe123', 'teacher', 't12', 'M. Florencia'),
  ('u_t13', 'sol',        'profe123', 'teacher', 't13', 'Sol'),
  ('u_t14', 'cristian',   'profe123', 'teacher', 't14', 'Cristian'),
  ('u_t15', 'danielan',   'profe123', 'teacher', 't15', 'Daniela N.'),
  ('u_t16', 'rebeca',     'profe123', 'teacher', 't16', 'Rebeca'),
  ('u_t17', 'marina',     'profe123', 'teacher', 't17', 'Marina'),
  ('u_t18', 'jimena',     'profe123', 'teacher', 't18', 'Jimena'),
  ('u_t19', 'daniela',    'profe123', 'teacher', 't19', 'Daniela'),
  ('u_t20', 'antonella',  'profe123', 'teacher', 't20', 'Antonella'),
  ('u_t21', 'wanda',      'profe123', 'teacher', 't21', 'Wanda'),
  ('u_t22', 'luciana',    'profe123', 'teacher', 't22', 'Luciana'),
  ('u_t23', 'agustin',    'profe123', 'teacher', 't23', 'Agustín'),
  ('u_t24', 'liliana',    'profe123', 'teacher', 't24', 'Liliana'),
  ('u_t25', 'dana',       'profe123', 'teacher', 't25', 'Dana'),
  ('u_t26', 'vanesa',     'profe123', 'teacher', 't26', 'Vanesa'),
  ('u_t27', 'carmela',    'profe123', 'teacher', 't27', 'Carmela'),
  ('u_t28', 'chiara',     'profe123', 'teacher', 't28', 'Chiara'),
  ('u_t29', 'maribel',    'profe123', 'teacher', 't29', 'Maribel'),
  ('u_t30', 'daiana',     'profe123', 'teacher', 't30', 'Daiana')
on conflict (username) do nothing;

-- ── DISABLE Row Level Security for now (internal tool) ──────
alter table teachers          disable row level security;
alter table teacher_calendars disable row level security;
alter table students          disable row level security;
alter table assignments       disable row level security;
alter table app_users         disable row level security;
