create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  password_hash text not null,
  role text not null default 'user' check (role in ('admin', 'user')),
  created_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists sessions_user_id_idx
  on public.sessions (user_id);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  teacher_id text not null,
  teacher_name text not null,
  specialty text not null,
  booking_date date not null,
  booking_time text not null,
  created_at timestamptz not null default now(),
  constraint bookings_unique_user_slot unique (user_id, teacher_id, booking_date, booking_time)
);

create index if not exists bookings_user_id_idx
  on public.bookings (user_id);

create index if not exists bookings_date_time_idx
  on public.bookings (booking_date, booking_time);
