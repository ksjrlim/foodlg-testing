-- FoodLG Validation MVP — schema v0.1.0
-- Pseudonymous by design: no names, NRIC, phone or address anywhere.
-- Access is enforced in the database with row-level security (RLS).
-- The app connects as role `foodlg_app` (no superuser, no BYPASSRLS) and sets,
-- per transaction:  app.actor_role ('dietitian' | 'patient' | 'admin' | 'anon'),
--                   app.actor_id   (uuid of the dietitian or patient),
--                   app.rule_version (rule library version used for this request).

drop schema if exists foodlg cascade;
create schema foodlg;
set search_path = foodlg;

-- ---------- helpers ----------
create function actor_role() returns text language sql stable set search_path = foodlg as
  $$ select coalesce(nullif(current_setting('app.actor_role', true), ''), 'anon') $$;
create function actor_id() returns uuid language sql stable set search_path = foodlg as
  $$ select nullif(current_setting('app.actor_id', true), '')::uuid $$;

-- ---------- tables ----------
create table clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_synthetic boolean not null default true,
  created_at timestamptz not null default now()
);

create table dietitians (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id),
  role text not null default 'dietitian' check (role in ('dietitian','admin')),
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table patients (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                      -- e.g. P-0001; the key to the person stays with the clinic
  clinic_id uuid not null references clinics(id),
  dietitian_id uuid not null references dietitians(id),
  invite_token_hash text,                         -- cleared once used
  passcode_hash text,
  consent_version text,
  consent_at timestamptz,
  status text not null default 'invited' check (status in ('invited','active','withdrawn')),
  reminder_time time,
  created_at timestamptz not null default now()
);

create table plans (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id),
  version int not null,
  goal text not null,
  scope text not null check (scope in ('drink_sugar')),
  preapproved_option_ids text[] not null,
  start_date date not null,
  review_date date,
  approved_by uuid not null references dietitians(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (patient_id, version)
);
create unique index one_active_plan on plans(patient_id) where is_active;

create table choices (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id),
  plan_id uuid not null references plans(id),
  option_id text not null,
  stall text not null check (stall in ('yes','unsure','no')),
  control text not null check (control in ('yes','no')),
  taste int not null check (taste between 1 and 3),
  confidence int not null check (confidence between 1 and 10),
  chosen boolean not null default false,
  created_at timestamptz not null default now()
);

create table cycles (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id),
  plan_id uuid not null references plans(id),
  option_id text not null,
  start_date date not null,
  end_date date not null,
  outcome text check (outcome in ('continue','smaller_step','next_change')),
  created_at timestamptz not null default now()
);

create table checkins (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references cycles(id),
  patient_id uuid not null references patients(id),
  day date not null,
  outcome text not null check (outcome in ('followed','not_followed','no_opportunity')),
  context text check (context in ('alone','family','colleagues','ordered_for_me')),
  barrier_id text,
  barrier_level text check (barrier_level in ('personal','social','environmental')),
  response_id text,
  action text,
  permission text check (permission in ('automatic','requested')),
  created_at timestamptz not null default now(),
  unique (cycle_id, day),
  -- a barrier only exists for a not-followed day
  check ((outcome = 'not_followed') or (barrier_id is null and barrier_level is null))
);

create table requests (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id),
  type text not null,
  detail jsonb not null default '{}',
  reason text not null,
  status text not null default 'awaiting' check (status in ('awaiting','approved','held')),
  decided_by uuid references dietitians(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table followups (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id),
  week int not null check (week in (4,8,12)),
  frequency text not null check (frequency in ('never','some','most','every')),
  created_at timestamptz not null default now(),
  unique (patient_id, week)
);

create table study_assessments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id),
  timepoint text not null check (timepoint in ('baseline','week12')),
  instrument text not null,
  result jsonb not null,
  assessor text not null,
  created_at timestamptz not null default now()
);

create table audit_events (
  id bigserial primary key,
  actor_role text not null,
  actor_id uuid,
  action text not null,
  entity text not null,
  entity_id uuid,
  rule_library_version text,
  at timestamptz not null default now()
);

-- ---------- audit: every write, recorded by trigger (cannot be skipped by the app) ----------
create function audit_write() returns trigger language plpgsql security definer set search_path = foodlg as $$
begin
  insert into audit_events(actor_role, actor_id, action, entity, entity_id, rule_library_version)
  values (actor_role(), actor_id(), lower(tg_op), tg_table_name,
          case when tg_op = 'DELETE' then old.id else new.id end,
          nullif(current_setting('app.rule_version', true), ''));
  return coalesce(new, old);
end $$;

do $$ declare t text; begin
  foreach t in array array['clinics','dietitians','patients','plans','choices','cycles','checkins','requests','followups','study_assessments'] loop
    execute format('create trigger audit_%1$s after insert or update or delete on %1$I for each row execute function audit_write()', t);
  end loop;
end $$;

-- ---------- guard: a plan can only be changed by a dietitian ----------
create function guard_plan() returns trigger language plpgsql set search_path = foodlg as $$
begin
  if actor_role() not in ('dietitian','admin') then
    raise exception 'only a dietitian can create or change a plan';
  end if;
  return new;
end $$;
create trigger guard_plans before insert or update on plans for each row execute function guard_plan();

-- ---------- guard: patients may only choose options pre-approved in their active plan ----------
create function guard_preapproved() returns trigger language plpgsql set search_path = foodlg as $$
declare allowed text[];
begin
  select preapproved_option_ids into allowed from plans where id = new.plan_id and is_active;
  if allowed is null or not (new.option_id = any(allowed)) then
    raise exception 'option % is not pre-approved for this patient', new.option_id;
  end if;
  return new;
end $$;
create trigger guard_choice_option before insert on choices for each row when (new.chosen) execute function guard_preapproved();
create trigger guard_cycle_option_ins before insert on cycles for each row execute function guard_preapproved();
create trigger guard_cycle_option_upd before update on cycles for each row when (new.option_id is distinct from old.option_id) execute function guard_preapproved();

-- ---------- row-level security ----------
do $$ declare t text; begin
  foreach t in array array['clinics','dietitians','patients','plans','choices','cycles','checkins','requests','followups','study_assessments','audit_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- the patient record a row belongs to must be the actor's own (patient) or one of the actor's patients (dietitian)
create function can_see_patient(pid uuid) returns boolean language sql stable security definer set search_path = foodlg as $$
  select case actor_role()
    when 'admin' then true
    when 'patient' then pid = actor_id()
    when 'dietitian' then exists (select 1 from patients p where p.id = pid and p.dietitian_id = actor_id())
    else false end
$$;

create policy clinics_read on clinics for select using (
  actor_role() = 'admin'
  or id in (select clinic_id from dietitians where id = actor_id())
  or id in (select clinic_id from patients where id = actor_id()));
create policy clinics_admin on clinics for all using (actor_role() = 'admin') with check (actor_role() = 'admin');

create policy dietitians_self on dietitians for select using (actor_role() = 'admin' or id = actor_id());
create policy dietitians_admin on dietitians for all using (actor_role() = 'admin') with check (actor_role() = 'admin');

create policy patients_read on patients for select using (
  actor_role() = 'admin'
  or (actor_role() = 'dietitian' and dietitian_id = actor_id())
  or (actor_role() = 'patient' and id = actor_id()));
create policy patients_insert on patients for insert with check (
  actor_role() = 'admin' or (actor_role() = 'dietitian' and dietitian_id = actor_id()));
create policy patients_update on patients for update using (
  actor_role() = 'admin' or (actor_role() = 'dietitian' and dietitian_id = actor_id()) or (actor_role() = 'patient' and id = actor_id()))
  with check (actor_role() = 'admin' or (actor_role() = 'dietitian' and dietitian_id = actor_id()) or (actor_role() = 'patient' and id = actor_id()));

do $$ declare t text; begin
  foreach t in array array['plans','choices','cycles','checkins','requests','followups','study_assessments'] loop
    execute format('create policy %1$s_rw on %1$I for all using (can_see_patient(patient_id)) with check (can_see_patient(patient_id))', t);
  end loop;
end $$;

-- study assessments are entered by study staff only
create policy sa_staff_only on study_assessments as restrictive for insert with check (actor_role() in ('admin','dietitian'));
-- requests are decided only by dietitians
create function guard_request_decision() returns trigger language plpgsql set search_path = foodlg as $$
begin
  if new.status <> old.status and actor_role() not in ('dietitian','admin') then
    raise exception 'only a dietitian can decide a request';
  end if;
  if new.status <> old.status then new.decided_by := actor_id(); new.decided_at := now(); end if;
  return new;
end $$;
create trigger guard_requests before update on requests for each row execute function guard_request_decision();

create policy audit_read on audit_events for select using (actor_role() = 'admin' or actor_id = actor_id());

-- ---------- app role ----------
-- NOLOGIN: the connecting user enters it per transaction with SET LOCAL ROLE, so row-level security
-- applies even when the hosted provider's default user is allowed to bypass it.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'foodlg_app') then
    create role foodlg_app nologin nosuperuser nobypassrls;
  end if;
end $$;
do $$ begin execute format('grant foodlg_app to %I', current_user); exception when others then null; end $$;
grant usage on schema foodlg to foodlg_app;
grant select, insert, update on all tables in schema foodlg to foodlg_app;
grant usage on all sequences in schema foodlg to foodlg_app;
revoke update, delete on audit_events from foodlg_app;
revoke insert on audit_events from foodlg_app;   -- only triggers and logging functions write audit rows

-- ---------- sign-in: actor 'auth' may read credentials and redeem an invite, nothing else ----------
create policy dietitians_auth on dietitians for select using (actor_role() = 'auth');
create policy patients_auth_read on patients for select using (actor_role() = 'auth');
create policy patients_auth_redeem on patients for update using (actor_role() = 'auth' and status = 'invited') with check (actor_role() = 'auth');

create function log_auth(act text, who_role text, who uuid) returns void language plpgsql security definer set search_path = foodlg as $$
begin
  if actor_role() <> 'auth' then raise exception 'not allowed'; end if;
  insert into audit_events(actor_role, actor_id, action, entity, entity_id) values (who_role, who, act, 'session', who);
end $$;
revoke all on function log_auth(text, text, uuid) from public;
grant execute on function log_auth(text, text, uuid) to foodlg_app;

-- ---------- guard: what each role may change on a patient record ----------
create function guard_patient_update() returns trigger language plpgsql set search_path = foodlg as $$
begin
  if actor_role() = 'patient' then
    if (new.code, new.clinic_id, new.dietitian_id, new.status, new.consent_version, new.consent_at, new.passcode_hash, new.invite_token_hash)
       is distinct from (old.code, old.clinic_id, old.dietitian_id, old.status, old.consent_version, old.consent_at, old.passcode_hash, old.invite_token_hash) then
      raise exception 'patients may only change their reminder time';
    end if;
  elsif actor_role() = 'auth' then
    if (new.code, new.clinic_id, new.dietitian_id, new.reminder_time) is distinct from (old.code, old.clinic_id, old.dietitian_id, old.reminder_time) then
      raise exception 'sign-in may only redeem an invite';
    end if;
  elsif actor_role() = 'dietitian' then
    if (new.code, new.clinic_id, new.dietitian_id) is distinct from (old.code, old.clinic_id, old.dietitian_id) then
      raise exception 'patient code, clinic and dietitian cannot be changed';
    end if;
  end if;
  return new;
end $$;
create trigger guard_patients before update on patients for each row execute function guard_patient_update();

-- ---------- guard: check-ins and cycles belong to the acting patient's own active plan ----------
create function guard_checkin() returns trigger language plpgsql set search_path = foodlg as $$
declare c record;
begin
  select * into c from cycles where id = new.cycle_id;
  if c is null or c.patient_id <> new.patient_id then raise exception 'check-in does not match its cycle'; end if;
  if new.day < c.start_date or new.day > c.end_date then raise exception 'check-in day is outside the cycle'; end if;
  return new;
end $$;
create trigger guard_checkins before insert or update on checkins for each row execute function guard_checkin();

-- ---------- view events (for the workflow-burden metric) ----------
-- The app cannot write audit rows directly; this function records a view only of a patient the actor can see.
create function log_view(pid uuid) returns void language plpgsql security definer set search_path = foodlg as $$
begin
  if actor_role() not in ('dietitian','admin') or not can_see_patient(pid) then return; end if;
  insert into audit_events(actor_role, actor_id, action, entity, entity_id, rule_library_version)
  values (actor_role(), actor_id(), 'view_summary', 'patients', pid, nullif(current_setting('app.rule_version', true), ''));
end $$;
revoke all on function log_view(uuid) from public;
grant execute on function log_view(uuid) to foodlg_app;

create function log_export(tbl text, mode text) returns void language plpgsql security definer set search_path = foodlg as $$
begin
  if actor_role() <> 'admin' then raise exception 'export is for the study admin only'; end if;
  insert into audit_events(actor_role, actor_id, action, entity, rule_library_version)
  values ('admin', actor_id(), 'export:' || mode, tbl, nullif(current_setting('app.rule_version', true), ''));
end $$;
revoke all on function log_export(text, text) from public;
grant execute on function log_export(text, text) to foodlg_app;
