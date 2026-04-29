create extension if not exists pgcrypto;

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  teacher_id text not null,
  teacher_name text not null,
  specialty text not null,
  booking_date date not null,
  booking_time text not null,
  client_name text,
  client_phone text,
  created_at timestamptz not null default timezone('utc', now()),
  constraint bookings_unique_slot unique (teacher_id, booking_date, booking_time)
);

alter table public.bookings enable row level security;

create policy "Public can read bookings"
on public.bookings
for select
to anon
using (true);

create policy "Public can insert bookings"
on public.bookings
for insert
to anon
with check (true);

create policy "Public can delete bookings"
on public.bookings
for delete
to anon
using (true);
