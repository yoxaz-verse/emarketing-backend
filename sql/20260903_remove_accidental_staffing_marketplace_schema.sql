-- Cleanup for accidental staffing-marketplace schema applied to Opio Email.
-- Safe to rerun: every object removal uses IF EXISTS.
--
-- This intentionally keeps pgcrypto because Opio Email uses gen_random_uuid().

begin;

-- Remove accidental auth trigger first because it lives on auth.users.
drop trigger if exists on_auth_user_created on auth.users;

-- Drop accidental staffing-marketplace tables.
-- CASCADE removes dependent foreign keys, table triggers, policies, and constraints.
drop table if exists
  public.talent_recommendations,
  public.commission_records,
  public.reputation_events,
  public.placement_reviews,
  public.profile_reputation,
  public.placements,
  public.applications,
  public.staffing_roles,
  public.events,
  public.talent_profiles,
  public.exhibitors,
  public.agencies,
  public.contact_details,
  public.profiles
cascade;

-- Drop accidental functions.
drop function if exists public.refresh_reputation_after_placement_status() cascade;
drop function if exists public.refresh_reputation_after_review() cascade;
drop function if exists public.refresh_profile_reputation(uuid) cascade;
drop function if exists public.create_placement_from_acceptance() cascade;
drop function if exists public.create_exhibitor_reputation() cascade;
drop function if exists public.handle_new_user() cascade;
drop function if exists public.is_admin() cascade;
drop function if exists public.current_role() cascade;

-- Drop accidental enum types after all dependent tables/functions are gone.
drop type if exists public.review_visibility cascade;
drop type if exists public.reviewee_role cascade;
drop type if exists public.commission_type cascade;
drop type if exists public.application_status cascade;
drop type if exists public.verification_status cascade;
drop type if exists public.user_role cascade;

commit;

-- Verification: both result sets should return zero rows.
select table_schema, table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'profiles',
    'contact_details',
    'agencies',
    'exhibitors',
    'talent_profiles',
    'events',
    'staffing_roles',
    'applications',
    'placements',
    'profile_reputation',
    'placement_reviews',
    'reputation_events',
    'commission_records',
    'talent_recommendations'
  )
order by table_name;

select n.nspname as schema, t.typname as type_name
from pg_type t
join pg_namespace n on n.oid = t.typnamespace
where n.nspname = 'public'
  and t.typname in (
    'user_role',
    'verification_status',
    'application_status',
    'commission_type',
    'reviewee_role',
    'review_visibility'
  )
order by t.typname;
