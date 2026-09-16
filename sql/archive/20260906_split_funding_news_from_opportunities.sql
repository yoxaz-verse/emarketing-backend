alter table if exists industry_intelligence_opportunities
  add column if not exists intelligence_type text not null default 'opportunity';

do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'industry_intelligence_opportunities'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ~ '\m(category|intelligence_type)\M'
  loop
    execute format('alter table industry_intelligence_opportunities drop constraint if exists %I', constraint_row.conname);
  end loop;
exception
  when undefined_table then null;
end $$;

alter table if exists industry_intelligence_opportunities
  drop constraint if exists industry_intelligence_opportunities_category_check;

alter table if exists industry_intelligence_opportunities
  add constraint industry_intelligence_opportunities_category_check
  check (category in (
    'seed_funding',
    'funding_news',
    'grant',
    'accelerator',
    'pitch_event',
    'demo_day',
    'investor_call',
    'ecosystem_program'
  ));

alter table if exists industry_intelligence_opportunities
  drop constraint if exists industry_intelligence_opportunities_intelligence_type_check;

alter table if exists industry_intelligence_opportunities
  add constraint industry_intelligence_opportunities_intelligence_type_check
  check (intelligence_type in ('opportunity', 'funding_news'));

update industry_intelligence_opportunities
set
  intelligence_type = 'funding_news',
  category = 'funding_news',
  useful_for_funding = false,
  useful_for_content = true,
  updated_at = now()
where intelligence_type = 'opportunity'
  and (
    lower(coalesce(title, '') || ' ' || coalesce(summary, '')) like any (array[
      '%raises%',
      '%raised%',
      '% funding round%',
      '% fundraise%',
      '% market cap%',
      '% ipo%',
      '% listing%',
      '% stake sale%',
      '% esop%',
      '% valuation%',
      '%acquires%',
      '%acquired%'
    ])
  )
  and not (
    lower(coalesce(title, '') || ' ' || coalesce(summary, '')) like any (array[
      '%apply%',
      '%applications open%',
      '%deadline%',
      '%grant%',
      '%scheme%',
      '%subsidy%',
      '%accelerator%',
      '%incubator%',
      '%cohort%',
      '%pitch%',
      '%demo day%',
      '%challenge%',
      '%call for startups%',
      '%request for proposal%',
      '%rfp%',
      '%fellowship%'
    ])
  );

create index if not exists idx_industry_intelligence_opportunities_type
  on industry_intelligence_opportunities (intelligence_type, created_at desc);
