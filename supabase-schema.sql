-- Supabase schema for Smart Cycle Lock --


create extension if not exists pgcrypto;

create table if not exists public.rides (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('scheduled', 'active', 'ended', 'canceled')),
  start_time timestamptz not null,
  end_time timestamptz not null,
  amount integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rides_status_start_idx on public.rides (status, start_time);
create index if not exists rides_status_end_idx on public.rides (status, end_time);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists rides_set_updated_at on public.rides;
create trigger rides_set_updated_at
before update on public.rides
for each row execute function public.set_updated_at();
