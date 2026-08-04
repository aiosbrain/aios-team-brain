-- AIO-786: audited, expiring operator decisions for the durable finding ledger.
alter table codebase_findings
  add column if not exists decision_reason text,
  add column if not exists decision_owner_member_id uuid references members(id) on delete set null,
  add column if not exists decision_by_member_id uuid references members(id) on delete set null,
  add column if not exists decision_at timestamptz,
  add column if not exists decision_expires_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'codebase_findings_decision_metadata'
      and conrelid = 'codebase_findings'::regclass
  ) then
    alter table codebase_findings
      add constraint codebase_findings_decision_metadata check (
        (
          status = any (array['accepted', 'risk_accepted', 'false_positive']::text[])
          and decision_reason is not null
          and char_length(decision_reason) between 10 and 500
          and decision_at is not null
          and decision_expires_at > decision_at
        )
        or
        (
          status <> all (array['accepted', 'risk_accepted', 'false_positive']::text[])
          and decision_reason is null
          and decision_owner_member_id is null
          and decision_by_member_id is null
          and decision_at is null
          and decision_expires_at is null
        )
      );
  end if;
end;
$$;

alter table codebase_finding_events alter column metrics_id drop not null;

create index if not exists codebase_findings_decision_expiry_idx
  on codebase_findings (team_id, codebase_id, decision_expires_at)
  where status in ('accepted', 'risk_accepted', 'false_positive');

-- Re-project a complete absence through decided states as resolved. Decision
-- metadata is cleared from current state; append-only operator events remain.
create or replace function reconcile_codebase_findings(
  p_team_id uuid,
  p_codebase_id uuid,
  p_metrics_id uuid,
  p_health jsonb
) returns jsonb
language plpgsql
as $$
declare
  v_schema_version text := coalesce(p_health->>'schema_version', '');
  v_evidence_status text;
  v_head_sha text;
  v_observed_at timestamptz;
  v_latest_observed_at timestamptz;
  v_snapshot_is_stale boolean := false;
  v_finding jsonb;
  v_row codebase_findings%rowtype;
  v_previous_status text;
  v_event_type text;
  v_new_status text;
  v_detected integer := 0;
  v_observed integer := 0;
  v_resolved integer := 0;
  v_reopened integer := 0;
  v_stale integer := 0;
begin
  if v_schema_version <> '2' then
    return jsonb_build_object(
      'detected', 0, 'observed', 0, 'resolved', 0, 'reopened', 0, 'stale', 0
    );
  end if;

  v_evidence_status := p_health->>'evidence_status';
  v_head_sha := p_health->>'head_sha';
  v_observed_at := (p_health->>'measured_at')::timestamptz;

  if not exists (
    select 1
    from code_metrics
    where id = p_metrics_id
      and team_id = p_team_id
      and codebase_id = p_codebase_id
      and head_sha = v_head_sha
      and codebase_health = p_health
  ) then
    raise exception 'finding reconciliation metrics identity mismatch';
  end if;

  -- Serialize lifecycle projection per codebase. Metrics writes happen before this
  -- function, so whichever reconciliation wins the lock can see every committed v2
  -- measurement and classify an out-of-order snapshot deterministically.
  perform pg_advisory_xact_lock(
    hashtextextended(p_team_id::text || ':' || p_codebase_id::text, 0)
  );
  select coalesce(
    max((codebase_health->>'measured_at')::timestamptz),
    v_observed_at
  )
  into v_latest_observed_at
  from code_metrics
  where team_id = p_team_id
    and codebase_id = p_codebase_id
    and codebase_health->>'schema_version' = '2';
  v_snapshot_is_stale := v_observed_at < v_latest_observed_at;

  for v_finding in
    select value from jsonb_array_elements(coalesce(p_health->'findings', '[]'::jsonb))
  loop
    select *
    into v_row
    from codebase_findings
    where team_id = p_team_id
      and codebase_id = p_codebase_id
      and fingerprint = v_finding->>'fingerprint'
    for update;

    if not found then
      v_new_status := case when v_snapshot_is_stale then 'stale_analysis' else 'open' end;
      v_event_type := case when v_snapshot_is_stale then 'stale_analysis' else 'detected' end;
      insert into codebase_findings (
        team_id, codebase_id, fingerprint, status, check_id, axis, kind, severity,
        evidence_status, remediation_tier, first_seen_sha, last_seen_sha,
        first_seen_at, last_seen_at, latest_metrics_id
      ) values (
        p_team_id,
        p_codebase_id,
        v_finding->>'fingerprint',
        v_new_status,
        v_finding->>'check_id',
        v_finding->>'axis',
        v_finding->>'kind',
        v_finding->>'severity',
        v_finding->>'evidence_status',
        (v_finding->>'remediation_tier')::integer,
        v_head_sha,
        v_head_sha,
        v_observed_at,
        v_observed_at,
        p_metrics_id
      )
      on conflict (team_id, codebase_id, fingerprint) do nothing
      returning * into v_row;

      if found then
        insert into codebase_finding_events (
          team_id, codebase_id, finding_id, metrics_id, event_type,
          from_status, to_status, head_sha, observed_at, details
        ) values (
          p_team_id, p_codebase_id, v_row.id, p_metrics_id, v_event_type,
          null, v_new_status, v_head_sha, v_observed_at,
          jsonb_build_object(
            'rubric_version', p_health->>'rubric_version',
            'profile_id', p_health->>'profile_id',
            'profile_version', p_health->>'profile_version',
            'evidence_status', v_evidence_status
          )
        )
        on conflict (finding_id, metrics_id, event_type) do nothing;
        if v_snapshot_is_stale then
          v_stale := v_stale + 1;
        else
          v_detected := v_detected + 1;
        end if;
        continue;
      end if;

      select *
      into v_row
      from codebase_findings
      where team_id = p_team_id
        and codebase_id = p_codebase_id
        and fingerprint = v_finding->>'fingerprint'
      for update;
    end if;

    if exists (
      select 1 from codebase_finding_events
      where finding_id = v_row.id and metrics_id = p_metrics_id
    ) then
      continue;
    end if;

    if v_snapshot_is_stale or v_observed_at < greatest(
      v_row.last_seen_at,
      coalesce(v_row.resolved_at, '-infinity'::timestamptz)
    ) then
      insert into codebase_finding_events (
        team_id, codebase_id, finding_id, metrics_id, event_type,
        from_status, to_status, head_sha, observed_at, details
      ) values (
        p_team_id, p_codebase_id, v_row.id, p_metrics_id, 'stale_analysis',
        v_row.status, v_row.status, v_head_sha, v_observed_at,
        jsonb_build_object(
          'rubric_version', p_health->>'rubric_version',
          'profile_id', p_health->>'profile_id',
          'profile_version', p_health->>'profile_version',
          'evidence_status', v_evidence_status
        )
      )
      on conflict (finding_id, metrics_id, event_type) do nothing;
      v_stale := v_stale + 1;
      continue;
    end if;

    v_previous_status := v_row.status;
    if v_previous_status in ('resolved', 'stale_analysis') then
      v_event_type := 'reopened';
      v_row.status := 'reopened';
      v_reopened := v_reopened + 1;
    else
      v_event_type := 'observed';
      v_observed := v_observed + 1;
    end if;

    update codebase_findings
    set status = v_row.status,
        check_id = v_finding->>'check_id',
        axis = v_finding->>'axis',
        kind = v_finding->>'kind',
        severity = v_finding->>'severity',
        evidence_status = v_finding->>'evidence_status',
        remediation_tier = (v_finding->>'remediation_tier')::integer,
        occurrence_count = occurrence_count + 1,
        last_seen_sha = v_head_sha,
        last_seen_at = v_observed_at,
        resolved_at = case when v_row.status = 'reopened' then null else resolved_at end,
        latest_metrics_id = p_metrics_id,
        updated_at = now()
    where id = v_row.id and team_id = p_team_id;

    insert into codebase_finding_events (
      team_id, codebase_id, finding_id, metrics_id, event_type,
      from_status, to_status, head_sha, observed_at, details
    ) values (
      p_team_id, p_codebase_id, v_row.id, p_metrics_id, v_event_type,
      v_previous_status, v_row.status, v_head_sha, v_observed_at,
      jsonb_build_object(
        'rubric_version', p_health->>'rubric_version',
        'profile_id', p_health->>'profile_id',
        'profile_version', p_health->>'profile_version',
        'evidence_status', v_evidence_status
      )
    )
    on conflict (finding_id, metrics_id, event_type) do nothing;
  end loop;

  if v_evidence_status = 'complete' and not v_snapshot_is_stale then
    for v_row in
      select *
      from codebase_findings f
      where f.team_id = p_team_id
        and f.codebase_id = p_codebase_id
        and (
          f.status in ('open', 'reopened')
          or (
            f.status in ('accepted', 'risk_accepted', 'false_positive')
            and f.decision_at <= v_observed_at
          )
        )
        and f.last_seen_at <= v_observed_at
        and not exists (
          select 1
          from jsonb_array_elements(coalesce(p_health->'findings', '[]'::jsonb)) current_finding
          where current_finding->>'fingerprint' = f.fingerprint
        )
      for update
    loop
      update codebase_findings
      set status = 'resolved',
          resolved_at = v_observed_at,
          decision_reason = null,
          decision_owner_member_id = null,
          decision_by_member_id = null,
          decision_at = null,
          decision_expires_at = null,
          latest_metrics_id = p_metrics_id,
          updated_at = now()
      where id = v_row.id and team_id = p_team_id;

      insert into codebase_finding_events (
        team_id, codebase_id, finding_id, metrics_id, event_type,
        from_status, to_status, head_sha, observed_at, details
      ) values (
        p_team_id, p_codebase_id, v_row.id, p_metrics_id, 'resolved',
        v_row.status, 'resolved', v_head_sha, v_observed_at,
        jsonb_build_object(
          'rubric_version', p_health->>'rubric_version',
          'profile_id', p_health->>'profile_id',
          'profile_version', p_health->>'profile_version',
          'evidence_status', v_evidence_status
        )
      )
      on conflict (finding_id, metrics_id, event_type) do nothing;
      v_resolved := v_resolved + 1;
    end loop;
  end if;

  return jsonb_build_object(
    'detected', v_detected,
    'observed', v_observed,
    'resolved', v_resolved,
    'reopened', v_reopened,
    'stale', v_stale
  );
end;
$$;

create or replace function decide_codebase_finding(
  p_team_id uuid,
  p_codebase_id uuid,
  p_finding_id uuid,
  p_actor_member_id uuid,
  p_owner_member_id uuid,
  p_decision_status text,
  p_reason text,
  p_expires_at timestamptz
) returns jsonb
language plpgsql
as $$
declare
  v_now timestamptz := now();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_finding codebase_findings%rowtype;
begin
  if p_decision_status not in ('accepted', 'risk_accepted', 'false_positive') then
    raise exception 'invalid finding decision status';
  end if;
  if char_length(v_reason) not between 10 and 500 then
    raise exception 'finding decision reason must be between 10 and 500 characters';
  end if;
  if p_expires_at <= v_now or p_expires_at > v_now + interval '366 days' then
    raise exception 'finding decision expiry must be in the next 366 days';
  end if;
  if not exists (
    select 1 from members
    where id = p_actor_member_id
      and team_id = p_team_id
      and status = 'active'
      and tier = 'team'
      and role in ('admin', 'lead')
  ) then
    raise exception 'finding decisions require an active team lead or admin';
  end if;
  if not exists (
    select 1 from members
    where id = p_owner_member_id
      and team_id = p_team_id
      and status = 'active'
      and tier = 'team'
  ) then
    raise exception 'finding decision owner must be an active team member';
  end if;

  select * into v_finding
  from codebase_findings
  where id = p_finding_id
    and team_id = p_team_id
    and codebase_id = p_codebase_id
  for update;
  if not found then
    raise exception 'finding not found';
  end if;
  if v_finding.status not in (
    'open', 'reopened', 'accepted', 'risk_accepted', 'false_positive'
  ) then
    raise exception 'finding status cannot receive an operator decision';
  end if;

  update codebase_findings
  set status = p_decision_status,
      decision_reason = v_reason,
      decision_owner_member_id = p_owner_member_id,
      decision_by_member_id = p_actor_member_id,
      decision_at = v_now,
      decision_expires_at = p_expires_at,
      updated_at = v_now
  where id = p_finding_id
    and team_id = p_team_id
    and codebase_id = p_codebase_id;

  insert into codebase_finding_events (
    team_id, codebase_id, finding_id, metrics_id, event_type,
    from_status, to_status, head_sha, observed_at, details
  ) values (
    p_team_id, p_codebase_id, p_finding_id, null, p_decision_status,
    v_finding.status, p_decision_status, v_finding.last_seen_sha, v_now,
    jsonb_build_object(
      'reason', v_reason,
      'owner_member_id', p_owner_member_id,
      'actor_member_id', p_actor_member_id,
      'expires_at', p_expires_at
    )
  );

  return jsonb_build_object('finding_id', p_finding_id, 'status', p_decision_status);
end;
$$;
