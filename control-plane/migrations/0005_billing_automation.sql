-- LIC-04: vendor-only billing lifecycle and internal notification queue.
-- This schema belongs exclusively to the Control Plane database.

create extension if not exists pgcrypto with schema control_plane;

create table if not exists control_plane.billing_subscriptions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references control_plane.licensing_customers(id) on delete restrict,
  license_id uuid not null references control_plane.licensing_licenses(id) on delete restrict,
  provider text not null default 'MANUAL'
    check (provider in ('MANUAL', 'STRIPE', 'MERCADO_PAGO')),
  provider_subscription_id text,
  status text not null default 'ACTIVE'
    check (status in ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'EXPIRED')),
  billing_cycle text not null default 'ANNUAL'
    check (billing_cycle in ('MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'CUSTOM')),
  amount_cents bigint not null check (amount_cents >= 0),
  currency text not null default 'BRL' check (currency ~ '^[A-Z]{3}$'),
  next_billing_at timestamptz,
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  auto_renew boolean not null default true,
  billing_grace_days integer not null default 7 check (billing_grace_days between 0 and 90),
  nonpayment_policy text not null default 'ALLOW_NATURAL_EXPIRATION'
    check (nonpayment_policy in ('SUSPEND_AFTER_GRACE', 'ALLOW_NATURAL_EXPIRATION')),
  suspended_for_nonpayment_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (current_period_end > current_period_start),
  check ((status = 'SUSPENDED' and suspended_for_nonpayment_at is not null) or status <> 'SUSPENDED')
);
create unique index if not exists uq_billing_provider_subscription
  on control_plane.billing_subscriptions(provider, provider_subscription_id)
  where provider_subscription_id is not null;
create unique index if not exists uq_billing_active_subscription_per_license
  on control_plane.billing_subscriptions(license_id)
  where status in ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED');
create index if not exists idx_billing_subscriptions_due
  on control_plane.billing_subscriptions(next_billing_at)
  where auto_renew and status = 'ACTIVE';

create table if not exists control_plane.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references control_plane.billing_subscriptions(id) on delete restrict,
  license_id uuid not null references control_plane.licensing_licenses(id) on delete restrict,
  customer_id uuid not null references control_plane.licensing_customers(id) on delete restrict,
  provider text not null check (provider in ('MANUAL', 'STRIPE', 'MERCADO_PAGO')),
  provider_invoice_id text,
  amount_cents bigint not null check (amount_cents >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'OPEN'
    check (status in ('OPEN', 'PAID', 'OVERDUE', 'CANCELLED', 'REFUNDED')),
  due_at timestamptz not null,
  paid_at timestamptz,
  period_start timestamptz not null,
  period_end timestamptz not null,
  idempotency_key text not null check (length(idempotency_key) between 16 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end > period_start),
  check ((status = 'PAID' and paid_at is not null) or status <> 'PAID')
);
create unique index if not exists uq_billing_invoice_provider_id
  on control_plane.billing_invoices(provider, provider_invoice_id)
  where provider_invoice_id is not null;
create unique index if not exists uq_billing_invoice_request
  on control_plane.billing_invoices(subscription_id, idempotency_key);
create unique index if not exists uq_billing_invoice_period
  on control_plane.billing_invoices(subscription_id, period_start, period_end);
create index if not exists idx_billing_invoices_due_status
  on control_plane.billing_invoices(due_at, status);
create index if not exists idx_billing_invoices_customer_created
  on control_plane.billing_invoices(customer_id, created_at desc);

create table if not exists control_plane.billing_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references control_plane.billing_invoices(id) on delete restrict,
  provider text not null check (provider in ('MANUAL', 'STRIPE', 'MERCADO_PAGO')),
  provider_payment_id text not null,
  amount_cents bigint not null check (amount_cents >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null check (status in ('PENDING', 'CONFIRMED', 'FAILED', 'REFUNDED')),
  paid_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_payment_id),
  check ((status in ('CONFIRMED', 'REFUNDED') and paid_at is not null) or status not in ('CONFIRMED', 'REFUNDED'))
);
create unique index if not exists uq_billing_one_confirmed_payment_per_invoice
  on control_plane.billing_payments(invoice_id)
  where status in ('CONFIRMED', 'REFUNDED');
create index if not exists idx_billing_payments_invoice_created
  on control_plane.billing_payments(invoice_id, created_at desc);

create table if not exists control_plane.billing_events (
  event_id uuid primary key default gen_random_uuid(),
  customer_id uuid references control_plane.licensing_customers(id) on delete restrict,
  license_id uuid references control_plane.licensing_licenses(id) on delete restrict,
  subscription_id uuid references control_plane.billing_subscriptions(id) on delete restrict,
  invoice_id uuid references control_plane.billing_invoices(id) on delete restrict,
  payment_id uuid references control_plane.billing_payments(id) on delete restrict,
  provider text,
  provider_event_id text,
  actor_type text not null check (actor_type in ('ADMIN', 'SYSTEM', 'PROVIDER')),
  actor_id text,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  request_id text,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_billing_event_provider_dedup
  on control_plane.billing_events(provider, provider_event_id, event_type)
  where provider_event_id is not null;
create index if not exists idx_billing_events_timeline
  on control_plane.billing_events(customer_id, created_at desc);
create index if not exists idx_billing_events_invoice
  on control_plane.billing_events(invoice_id, created_at desc);

create table if not exists control_plane.billing_provider_accounts_metadata (
  provider text primary key check (provider in ('MANUAL', 'STRIPE', 'MERCADO_PAGO')),
  account_reference text,
  status text not null default 'DISABLED' check (status in ('READY', 'DISABLED', 'NEEDS_CONFIGURATION')),
  test_mode boolean not null default true,
  last_checked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  updated_at timestamptz not null default now()
);
insert into control_plane.billing_provider_accounts_metadata(provider, status, test_mode, metadata)
values
  ('MANUAL', 'READY', true, '{"mode":"operator_confirmed"}'::jsonb),
  ('STRIPE', 'NEEDS_CONFIGURATION', true, '{"adapter":"not_configured"}'::jsonb),
  ('MERCADO_PAGO', 'NEEDS_CONFIGURATION', true, '{"adapter":"not_configured"}'::jsonb)
on conflict (provider) do nothing;

create table if not exists control_plane.billing_admin_operations (
  operation text not null check (operation in ('create_subscription', 'create_invoice', 'renew_without_billing')),
  idempotency_key text not null check (length(idempotency_key) between 16 and 200),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  subscription_id uuid references control_plane.billing_subscriptions(id) on delete restrict,
  invoice_id uuid references control_plane.billing_invoices(id) on delete restrict,
  license_id uuid references control_plane.licensing_licenses(id) on delete restrict,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (operation, idempotency_key)
);

create table if not exists control_plane.billing_webhook_receipts (
  provider text not null check (provider in ('STRIPE', 'MERCADO_PAGO')),
  provider_event_id text not null check (length(provider_event_id) between 1 and 200),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  processing_status text not null default 'PROCESSING'
    check (processing_status in ('PROCESSING', 'PROCESSED', 'REJECTED')),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (provider, provider_event_id)
);

create table if not exists control_plane.billing_notifications (
  id uuid primary key default gen_random_uuid(),
  notification_key text not null unique,
  event_type text not null,
  customer_id uuid references control_plane.licensing_customers(id) on delete restrict,
  license_id uuid references control_plane.licensing_licenses(id) on delete restrict,
  subscription_id uuid references control_plane.billing_subscriptions(id) on delete restrict,
  invoice_id uuid references control_plane.billing_invoices(id) on delete restrict,
  payment_id uuid references control_plane.billing_payments(id) on delete restrict,
  status text not null default 'PENDING' check (status in ('PENDING', 'ACKNOWLEDGED', 'SUPPRESSED')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz
);
create index if not exists idx_billing_notifications_pending
  on control_plane.billing_notifications(created_at) where status = 'PENDING';

create table if not exists control_plane.billing_reconciliation_findings (
  id uuid primary key default gen_random_uuid(),
  finding_key text not null unique,
  customer_id uuid references control_plane.licensing_customers(id) on delete restrict,
  license_id uuid references control_plane.licensing_licenses(id) on delete restrict,
  subscription_id uuid references control_plane.billing_subscriptions(id) on delete restrict,
  invoice_id uuid references control_plane.billing_invoices(id) on delete restrict,
  finding_type text not null,
  expected_state text,
  observed_state text,
  status text not null default 'OPEN' check (status in ('OPEN', 'RESOLVED')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists idx_billing_findings_open
  on control_plane.billing_reconciliation_findings(last_seen_at desc) where status = 'OPEN';

create table if not exists control_plane.billing_settings (
  singleton boolean primary key default true check (singleton),
  billing_grace_days integer not null default 7 check (billing_grace_days between 0 and 90),
  nonpayment_policy text not null default 'ALLOW_NATURAL_EXPIRATION'
    check (nonpayment_policy in ('SUSPEND_AFTER_GRACE', 'ALLOW_NATURAL_EXPIRATION')),
  invoice_lead_days integer not null default 30 check (invoice_lead_days between 0 and 90),
  updated_by text,
  updated_at timestamptz not null default now()
);
insert into control_plane.billing_settings(singleton) values (true) on conflict (singleton) do nothing;

create or replace function control_plane.create_billing_subscription(
  p_customer_id uuid,
  p_license_id uuid,
  p_provider text,
  p_billing_cycle text,
  p_amount_cents bigint,
  p_currency text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_auto_renew boolean,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_actor_id text,
  p_request_id text
)
returns setof control_plane.billing_subscriptions
language plpgsql
set search_path = control_plane, pg_catalog, pg_temp
as $$
declare
  v_operation control_plane.billing_admin_operations%rowtype;
  v_license control_plane.licensing_licenses%rowtype;
  v_settings control_plane.billing_settings%rowtype;
  v_subscription control_plane.billing_subscriptions%rowtype;
begin
  if p_request_id is null or length(p_request_id) > 200 or p_idempotency_key is null
     or length(p_idempotency_key) not between 16 and 200
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then raise exception 'invalid billing subscription request'; end if;
  perform set_config('clientix.request_id', p_request_id, true);
  if p_provider <> 'MANUAL' and not exists(
    select 1 from billing_provider_accounts_metadata where provider=p_provider and status='READY' and test_mode=true
  ) then raise exception 'billing provider is disabled or not in sandbox mode'; end if;
  select * into v_license from licensing_licenses where id = p_license_id for update;
  if not found or v_license.customer_id <> p_customer_id or v_license.status in ('DRAFT', 'REVOKED') then
    raise exception 'billing license is not eligible';
  end if;
  insert into billing_admin_operations(operation,idempotency_key,request_fingerprint)
  values ('create_subscription', p_idempotency_key, p_request_fingerprint) on conflict do nothing;
  select * into v_operation from billing_admin_operations
   where operation = 'create_subscription' and idempotency_key = p_idempotency_key for update;
  if v_operation.request_fingerprint <> p_request_fingerprint then raise exception 'idempotency key conflict'; end if;
  if v_operation.completed_at is not null then
    return query select * from billing_subscriptions where id = v_operation.subscription_id;
    return;
  end if;
  select * into v_settings from billing_settings where singleton;
  insert into billing_subscriptions(
    customer_id,license_id,provider,status,billing_cycle,amount_cents,currency,
    next_billing_at,current_period_start,current_period_end,auto_renew,billing_grace_days,nonpayment_policy
  ) values (
    p_customer_id,p_license_id,p_provider,'ACTIVE',p_billing_cycle,p_amount_cents,upper(p_currency),
    p_period_end,p_period_start,p_period_end,p_auto_renew,v_settings.billing_grace_days,v_settings.nonpayment_policy
  ) returning * into v_subscription;
  insert into billing_admin_operations(operation,idempotency_key,request_fingerprint,subscription_id,completed_at)
  values ('create_subscription',p_idempotency_key,p_request_fingerprint,v_subscription.id,now())
  on conflict (operation,idempotency_key) do update set subscription_id=excluded.subscription_id,completed_at=excluded.completed_at;
  insert into billing_events(customer_id,license_id,subscription_id,provider,actor_type,actor_id,event_type,metadata,request_id)
  values (p_customer_id,p_license_id,v_subscription.id,p_provider,'ADMIN',p_actor_id,'BILLING_SUBSCRIPTION_CREATED',
          jsonb_build_object('billing_cycle',p_billing_cycle,'currency',upper(p_currency),'amount_cents',p_amount_cents,'auto_renew',p_auto_renew),p_request_id);
  return next v_subscription;
end;
$$;

create or replace function control_plane.create_billing_invoice(
  p_subscription_id uuid,
  p_due_at timestamptz,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_actor_id text,
  p_actor_type text,
  p_request_id text
)
returns setof control_plane.billing_invoices
language plpgsql
set search_path = control_plane, pg_catalog, pg_temp
as $$
declare
  v_operation control_plane.billing_admin_operations%rowtype;
  v_subscription control_plane.billing_subscriptions%rowtype;
  v_invoice control_plane.billing_invoices%rowtype;
  v_period_end timestamptz;
begin
  if p_due_at is null or p_request_id is null or length(p_request_id) > 200
     or p_idempotency_key is null or length(p_idempotency_key) not between 16 and 200
     or p_request_fingerprint !~ '^[0-9a-f]{64}$'
     or p_actor_type not in ('ADMIN','SYSTEM') then raise exception 'invalid invoice request'; end if;
  perform set_config('clientix.request_id', p_request_id, true);
  select * into v_subscription from billing_subscriptions where id=p_subscription_id for update;
  if not found or v_subscription.status not in ('TRIAL','ACTIVE','PAST_DUE') then raise exception 'subscription is not invoiceable'; end if;
  insert into billing_admin_operations(operation,idempotency_key,request_fingerprint)
  values ('create_invoice',p_idempotency_key,p_request_fingerprint) on conflict do nothing;
  select * into v_operation from billing_admin_operations
   where operation='create_invoice' and idempotency_key=p_idempotency_key for update;
  if v_operation.request_fingerprint <> p_request_fingerprint then raise exception 'idempotency key conflict'; end if;
  if v_operation.completed_at is not null then
    return query select * from billing_invoices where id=v_operation.invoice_id;
    return;
  end if;
  v_period_end := case v_subscription.billing_cycle
    when 'MONTHLY' then v_subscription.current_period_end + interval '1 month'
    when 'QUARTERLY' then v_subscription.current_period_end + interval '3 months'
    when 'SEMIANNUAL' then v_subscription.current_period_end + interval '6 months'
    when 'ANNUAL' then v_subscription.current_period_end + interval '1 year'
    else coalesce(v_subscription.next_billing_at, p_due_at) + (v_subscription.current_period_end - v_subscription.current_period_start)
  end;
  if v_period_end <= v_subscription.current_period_end then raise exception 'invalid billing period'; end if;
  insert into billing_invoices(
    subscription_id,license_id,customer_id,provider,amount_cents,currency,status,due_at,period_start,period_end,idempotency_key
  ) values (
    v_subscription.id,v_subscription.license_id,v_subscription.customer_id,v_subscription.provider,
    v_subscription.amount_cents,v_subscription.currency,'OPEN',p_due_at,v_subscription.current_period_end,v_period_end,p_idempotency_key
  ) returning * into v_invoice;
  update billing_admin_operations set subscription_id=v_subscription.id,invoice_id=v_invoice.id,completed_at=now()
   where operation='create_invoice' and idempotency_key=p_idempotency_key;
  insert into billing_events(customer_id,license_id,subscription_id,invoice_id,provider,actor_type,actor_id,event_type,metadata,request_id)
  values (v_subscription.customer_id,v_subscription.license_id,v_subscription.id,v_invoice.id,v_subscription.provider,
          p_actor_type,p_actor_id,'INVOICE_CREATED',jsonb_build_object('amount_cents',v_invoice.amount_cents,'currency',v_invoice.currency,'due_at',v_invoice.due_at),p_request_id);
  return next v_invoice;
end;
$$;

create or replace function control_plane.confirm_billing_payment(
  p_invoice_id uuid,
  p_provider text,
  p_provider_payment_id text,
  p_provider_event_id text,
  p_amount_cents bigint,
  p_currency text,
  p_payload_sha256 text,
  p_actor_type text,
  p_actor_id text,
  p_reason text,
  p_request_id text
)
returns table(payment_id uuid,invoice_id uuid,subscription_id uuid,license_id uuid,expires_at timestamptz,duplicate boolean)
language plpgsql
set search_path = control_plane, pg_catalog, pg_temp
as $$
declare
  v_subscription_id uuid;
  v_subscription control_plane.billing_subscriptions%rowtype;
  v_invoice control_plane.billing_invoices%rowtype;
  v_license control_plane.licensing_licenses%rowtype;
  v_payment control_plane.billing_payments%rowtype;
  v_receipt control_plane.billing_webhook_receipts%rowtype;
  v_inserted text;
  v_new_expiration timestamptz;
  v_period interval;
  v_request_fingerprint text;
  v_payment_exists boolean:=false;
begin
  if p_request_id is null or length(p_request_id) > 200 or p_provider_payment_id is null
     or length(p_provider_payment_id) not between 1 and 200 or p_amount_cents < 0
     or upper(p_currency) !~ '^[A-Z]{3}$' or p_actor_type not in ('ADMIN','PROVIDER')
     or (p_provider_event_id is not null and (p_payload_sha256 is null or p_payload_sha256 !~ '^[0-9a-f]{64}$')) then
    raise exception 'invalid payment confirmation';
  end if;
  perform set_config('clientix.request_id', p_request_id, true);
  if p_provider <> 'MANUAL' and not exists(
    select 1 from billing_provider_accounts_metadata where provider=p_provider and status='READY' and test_mode=true
  ) then raise exception 'billing provider is disabled or not in sandbox mode'; end if;
  select i.subscription_id into v_subscription_id from billing_invoices as i where i.id=p_invoice_id;
  if not found then raise exception 'invoice not found'; end if;
  select * into v_subscription from billing_subscriptions where id=v_subscription_id for update;
  select * into v_invoice from billing_invoices where id=p_invoice_id for update;
  if v_invoice.provider <> p_provider or v_subscription.provider <> p_provider then raise exception 'provider mismatch'; end if;
  if v_invoice.amount_cents <> p_amount_cents or v_invoice.currency <> upper(p_currency) then raise exception 'payment amount or currency mismatch'; end if;

  if p_provider_event_id is not null then
    insert into billing_webhook_receipts(provider,provider_event_id,payload_sha256)
    values (p_provider,p_provider_event_id,p_payload_sha256) on conflict do nothing returning provider_event_id into v_inserted;
    if v_inserted is null then
      select * into v_receipt from billing_webhook_receipts where provider=p_provider and provider_event_id=p_provider_event_id for update;
      if v_receipt.payload_sha256 <> p_payload_sha256 then raise exception 'provider event replay payload mismatch'; end if;
      if v_receipt.processing_status='PROCESSED' then
        select * into v_payment from billing_payments where provider=p_provider and provider_payment_id=p_provider_payment_id;
        if not found then raise exception 'processed provider event has no payment'; end if;
        return query select v_payment.id,v_invoice.id,v_subscription.id,v_invoice.license_id,
          (select l.expires_at from licensing_licenses l where l.id=v_invoice.license_id),true;
        return;
      end if;
      raise exception 'provider event is already being processed';
    end if;
  end if;

  select * into v_payment from billing_payments where provider=p_provider and provider_payment_id=p_provider_payment_id;
  if found then
    v_payment_exists:=true;
    if v_payment.invoice_id<>v_invoice.id or v_payment.amount_cents<>p_amount_cents or v_payment.currency<>upper(p_currency) then
      raise exception 'payment idempotency conflict';
    end if;
    if v_payment.status in ('CONFIRMED','REFUNDED') then
      if p_provider_event_id is not null then
        update billing_webhook_receipts set processing_status='PROCESSED',processed_at=now()
         where provider=p_provider and provider_event_id=p_provider_event_id;
      end if;
      return query select v_payment.id,v_invoice.id,v_subscription.id,v_invoice.license_id,
        (select l.expires_at from licensing_licenses l where l.id=v_invoice.license_id),true;
      return;
    end if;
    if v_payment.status not in ('FAILED','PENDING') then raise exception 'payment cannot transition to confirmed'; end if;
  end if;
  if v_invoice.status not in ('OPEN','OVERDUE') then raise exception 'invoice cannot be paid in current state'; end if;
  select * into v_license from licensing_licenses where id=v_invoice.license_id for update;
  if not found or v_license.status in ('DRAFT','REVOKED') then raise exception 'license cannot be renewed from this payment'; end if;

  if v_payment_exists then
    update billing_payments set status='CONFIRMED',paid_at=now(),updated_at=now(),metadata=metadata||
      case when nullif(btrim(p_reason),'') is null then '{}'::jsonb else jsonb_build_object('operator_reason',left(btrim(p_reason),500)) end
      where id=v_payment.id returning * into v_payment;
  else
    insert into billing_payments(invoice_id,provider,provider_payment_id,amount_cents,currency,status,paid_at,metadata)
    values (v_invoice.id,p_provider,p_provider_payment_id,p_amount_cents,upper(p_currency),'CONFIRMED',now(),
            case when nullif(btrim(p_reason),'') is null then '{}'::jsonb else jsonb_build_object('operator_reason',left(btrim(p_reason),500)) end)
    returning * into v_payment;
  end if;
  update billing_invoices set status='PAID',paid_at=now(),updated_at=now() where id=v_invoice.id returning * into v_invoice;

  v_period := v_invoice.period_end-v_invoice.period_start;
  v_new_expiration := v_invoice.period_end;
  if v_new_expiration <= greatest(v_license.expires_at,now()) then
    v_new_expiration := case v_subscription.billing_cycle
      when 'MONTHLY' then greatest(v_license.expires_at,now()) + interval '1 month'
      when 'QUARTERLY' then greatest(v_license.expires_at,now()) + interval '3 months'
      when 'SEMIANNUAL' then greatest(v_license.expires_at,now()) + interval '6 months'
      when 'ANNUAL' then greatest(v_license.expires_at,now()) + interval '1 year'
      else greatest(v_license.expires_at,now()) + v_period
    end;
  end if;
  v_request_fingerprint := encode(control_plane.digest(convert_to(concat_ws('|',v_invoice.id::text,v_payment.id::text,p_amount_cents::text,upper(p_currency),v_new_expiration::text),'UTF8'),'sha256'),'hex');
  perform 1 from control_plane.renew_license(
    v_license.id,null,v_new_expiration,null,false,v_license.signing_key_id,
    coalesce(p_actor_id,'billing-provider'),'billing-payment:'||v_payment.id::text,v_request_fingerprint
  );

  update billing_subscriptions set status='ACTIVE',current_period_start=greatest(v_invoice.period_start,case when v_license.expires_at < now() then now() else v_invoice.period_start end),
    current_period_end=v_new_expiration,next_billing_at=v_new_expiration,updated_at=now()
   where id=v_subscription.id;
  if v_subscription.suspended_for_nonpayment_at is not null then
    update licensing_licenses set status='ACTIVE',updated_at=now() where id=v_license.id and status='SUSPENDED';
    insert into licensing_events(license_id,event_type,payload,actor,actor_type,actor_id,request_id,created_at)
    values (v_license.id,'LICENSE_REACTIVATED_AFTER_PAYMENT',jsonb_build_object('payment_id',v_payment.id),coalesce(p_actor_id,'billing-provider'),p_actor_type,p_actor_id,p_request_id,now());
    insert into billing_events(customer_id,license_id,subscription_id,invoice_id,payment_id,provider,provider_event_id,actor_type,actor_id,event_type,metadata,request_id)
    values (v_invoice.customer_id,v_license.id,v_subscription.id,v_invoice.id,v_payment.id,p_provider,p_provider_event_id,p_actor_type,p_actor_id,
      'LICENSE_REACTIVATED_AFTER_PAYMENT','{}'::jsonb,p_request_id);
    update billing_subscriptions set suspended_for_nonpayment_at=null where id=v_subscription.id;
  end if;
  insert into billing_events(customer_id,license_id,subscription_id,invoice_id,payment_id,provider,provider_event_id,actor_type,actor_id,event_type,metadata,request_id)
  values
    (v_invoice.customer_id,v_license.id,v_subscription.id,v_invoice.id,v_payment.id,p_provider,p_provider_event_id,p_actor_type,p_actor_id,'PAYMENT_CONFIRMED',jsonb_build_object('amount_cents',p_amount_cents,'currency',upper(p_currency)),p_request_id),
    (v_invoice.customer_id,v_license.id,v_subscription.id,v_invoice.id,v_payment.id,p_provider,p_provider_event_id,p_actor_type,p_actor_id,'LICENSE_RENEWED_FROM_PAYMENT',jsonb_build_object('expires_at',v_new_expiration),p_request_id);
  insert into billing_notifications(notification_key,event_type,customer_id,license_id,subscription_id,invoice_id,payment_id,metadata)
  values
    ('payment:'||v_payment.id::text||':confirmed','PAYMENT_CONFIRMED',v_invoice.customer_id,v_license.id,v_subscription.id,v_invoice.id,v_payment.id,'{}'::jsonb),
    ('payment:'||v_payment.id::text||':license-renewed','LICENSE_RENEWED',v_invoice.customer_id,v_license.id,v_subscription.id,v_invoice.id,v_payment.id,jsonb_build_object('expires_at',v_new_expiration))
  on conflict (notification_key) do nothing;
  if p_provider_event_id is not null then
    update billing_webhook_receipts set processing_status='PROCESSED',processed_at=now()
     where provider=p_provider and provider_event_id=p_provider_event_id;
  end if;
  return query select v_payment.id,v_invoice.id,v_subscription.id,v_license.id,v_new_expiration,false;
end;
$$;

create or replace function control_plane.record_billing_payment_failure(
  p_invoice_id uuid,p_provider text,p_provider_payment_id text,p_provider_event_id text,
  p_amount_cents bigint,p_currency text,p_payload_sha256 text,p_request_id text
)
returns table(payment_id uuid,invoice_id uuid,duplicate boolean)
language plpgsql set search_path=control_plane,pg_catalog,pg_temp as $$
declare v_subscription_id uuid; v_subscription billing_subscriptions%rowtype; v_invoice billing_invoices%rowtype;
  v_payment billing_payments%rowtype; v_receipt billing_webhook_receipts%rowtype; v_inserted text;
begin
  if p_request_id is null or length(p_request_id)>200 or p_provider_payment_id is null or length(p_provider_payment_id) not between 1 and 200
     or p_amount_cents<0 or upper(p_currency)!~'^[A-Z]{3}$' or p_provider_event_id is null
     or p_payload_sha256 is null or p_payload_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'invalid payment failure event'; end if;
  perform set_config('clientix.request_id',p_request_id,true);
  if p_provider <> 'MANUAL' and not exists(
    select 1 from billing_provider_accounts_metadata where provider=p_provider and status='READY' and test_mode=true
  ) then raise exception 'billing provider is disabled or not in sandbox mode'; end if;
  select subscription_id into v_subscription_id from billing_invoices where id=p_invoice_id;
  if not found then raise exception 'invoice not found'; end if;
  select * into v_subscription from billing_subscriptions where id=v_subscription_id for update;
  select * into v_invoice from billing_invoices where id=p_invoice_id for update;
  if v_subscription.provider<>p_provider or v_invoice.provider<>p_provider or v_invoice.amount_cents<>p_amount_cents or v_invoice.currency<>upper(p_currency) then
    raise exception 'provider or amount mismatch'; end if;
  if v_invoice.status not in ('OPEN','OVERDUE') or exists(select 1 from billing_payments where invoice_id=p_invoice_id and status in ('CONFIRMED','REFUNDED')) then
    raise exception 'invoice is not awaiting payment';
  end if;
  insert into billing_webhook_receipts(provider,provider_event_id,payload_sha256)
  values(p_provider,p_provider_event_id,p_payload_sha256) on conflict do nothing returning provider_event_id into v_inserted;
  if v_inserted is null then
    select * into v_receipt from billing_webhook_receipts where provider=p_provider and provider_event_id=p_provider_event_id for update;
    if v_receipt.payload_sha256<>p_payload_sha256 then raise exception 'provider event replay payload mismatch'; end if;
    if v_receipt.processing_status='PROCESSED' then
      select * into v_payment from billing_payments where provider=p_provider and provider_payment_id=p_provider_payment_id;
      return query select v_payment.id,p_invoice_id,true; return;
    end if;
    raise exception 'provider event is already being processed';
  end if;
  select * into v_payment from billing_payments where provider=p_provider and provider_payment_id=p_provider_payment_id;
  if found then
    if v_payment.invoice_id<>p_invoice_id or v_payment.amount_cents<>p_amount_cents or v_payment.currency<>upper(p_currency) then raise exception 'payment idempotency conflict'; end if;
    if v_payment.status='CONFIRMED' then
      update billing_webhook_receipts set processing_status='PROCESSED',processed_at=now() where provider=p_provider and provider_event_id=p_provider_event_id;
      return query select v_payment.id,p_invoice_id,true; return;
    end if;
    if v_payment.status not in ('PENDING','FAILED') then raise exception 'payment cannot transition to failed'; end if;
    update billing_payments set status='FAILED',updated_at=now() where id=v_payment.id returning * into v_payment;
  else
    insert into billing_payments(invoice_id,provider,provider_payment_id,amount_cents,currency,status,metadata)
    values(p_invoice_id,p_provider,p_provider_payment_id,p_amount_cents,upper(p_currency),'FAILED','{}'::jsonb) returning * into v_payment;
  end if;
  insert into billing_events(customer_id,license_id,subscription_id,invoice_id,payment_id,provider,provider_event_id,actor_type,event_type,metadata,request_id)
  values(v_invoice.customer_id,v_invoice.license_id,v_subscription.id,v_invoice.id,v_payment.id,p_provider,p_provider_event_id,'PROVIDER','PAYMENT_FAILED','{}'::jsonb,p_request_id);
  insert into billing_notifications(notification_key,event_type,customer_id,license_id,subscription_id,invoice_id,payment_id)
  values('payment:'||v_payment.id::text||':failed','PAYMENT_FAILED',v_invoice.customer_id,v_invoice.license_id,v_subscription.id,v_invoice.id,v_payment.id)
  on conflict(notification_key) do nothing;
  update billing_webhook_receipts set processing_status='PROCESSED',processed_at=now() where provider=p_provider and provider_event_id=p_provider_event_id;
  return query select v_payment.id,p_invoice_id,false;
end; $$;

create or replace function control_plane.cancel_billing_invoice(p_invoice_id uuid,p_reason text,p_actor_id text,p_request_id text)
returns setof control_plane.billing_invoices language plpgsql set search_path=control_plane,pg_catalog,pg_temp as $$
declare v_invoice billing_invoices%rowtype;
begin
  if nullif(btrim(p_reason),'') is null or length(p_reason)>500 then raise exception 'invoice cancellation reason required'; end if;
  perform set_config('clientix.request_id',p_request_id,true);
  select * into v_invoice from billing_invoices where id=p_invoice_id for update;
  if not found then raise exception 'invoice cannot be cancelled'; end if;
  if v_invoice.status='CANCELLED' then return next v_invoice; return; end if;
  if v_invoice.status not in ('OPEN','OVERDUE') then raise exception 'invoice cannot be cancelled'; end if;
  update billing_invoices set status='CANCELLED',updated_at=now() where id=p_invoice_id returning * into v_invoice;
  insert into billing_events(customer_id,license_id,subscription_id,invoice_id,provider,actor_type,actor_id,event_type,metadata,request_id)
  values(v_invoice.customer_id,v_invoice.license_id,v_invoice.subscription_id,v_invoice.id,v_invoice.provider,'ADMIN',p_actor_id,'INVOICE_CANCELLED',jsonb_build_object('reason',left(btrim(p_reason),500)),p_request_id);
  return next v_invoice;
end; $$;

create or replace function control_plane.refund_billing_payment(p_payment_id uuid,p_reason text,p_actor_id text,p_request_id text)
returns setof control_plane.billing_payments language plpgsql set search_path=control_plane,pg_catalog,pg_temp as $$
declare v_payment billing_payments%rowtype; v_invoice billing_invoices%rowtype;
begin
  if nullif(btrim(p_reason),'') is null then raise exception 'refund reason required'; end if;
  perform set_config('clientix.request_id',p_request_id,true);
  select * into v_payment from billing_payments where id=p_payment_id for update;
  if not found then raise exception 'payment cannot be refunded'; end if;
  if v_payment.status='REFUNDED' then return next v_payment; return; end if;
  if v_payment.status<>'CONFIRMED' then raise exception 'payment cannot be refunded'; end if;
  update billing_payments set status='REFUNDED',updated_at=now(),metadata=metadata||jsonb_build_object('refund_reason',left(btrim(p_reason),500)) where id=p_payment_id returning * into v_payment;
  update billing_invoices set status='REFUNDED',updated_at=now() where id=v_payment.invoice_id returning * into v_invoice;
  insert into billing_events(customer_id,license_id,subscription_id,invoice_id,payment_id,provider,actor_type,actor_id,event_type,metadata,request_id)
  values(v_invoice.customer_id,v_invoice.license_id,v_invoice.subscription_id,v_invoice.id,v_payment.id,v_payment.provider,'ADMIN',p_actor_id,'REFUND_RECORDED',jsonb_build_object('reason',left(btrim(p_reason),500)),p_request_id);
  return next v_payment;
end; $$;

create or replace function control_plane.set_billing_auto_renew(p_subscription_id uuid,p_auto_renew boolean,p_actor_id text,p_request_id text)
returns setof control_plane.billing_subscriptions language plpgsql set search_path=control_plane,pg_catalog,pg_temp as $$
declare v_subscription billing_subscriptions%rowtype;
begin
  perform set_config('clientix.request_id',p_request_id,true);
  if not p_auto_renew then
    select * into v_subscription from billing_subscriptions where id=p_subscription_id for update;
    if not found then raise exception 'subscription not found'; end if;
    if v_subscription.status='CANCELLED' and not v_subscription.auto_renew then return next v_subscription; return; end if;
    if v_subscription.auto_renew=false then return next v_subscription; return; end if;
  end if;
  if p_auto_renew then
    select * into v_subscription from billing_subscriptions where id=p_subscription_id for update;
    if not found then raise exception 'subscription not found'; end if;
    if v_subscription.auto_renew and v_subscription.status not in ('CANCELLED','EXPIRED') then return next v_subscription; return; end if;
  end if;
  update billing_subscriptions set auto_renew=p_auto_renew,updated_at=now() where id=p_subscription_id and status not in ('CANCELLED','EXPIRED') returning * into v_subscription;
  if not found then raise exception 'subscription not found or closed'; end if;
  if not p_auto_renew then update billing_subscriptions set status='CANCELLED',updated_at=now() where id=p_subscription_id returning * into v_subscription; end if;
  insert into billing_events(customer_id,license_id,subscription_id,provider,actor_type,actor_id,event_type,metadata,request_id)
  values(v_subscription.customer_id,v_subscription.license_id,v_subscription.id,v_subscription.provider,'ADMIN',p_actor_id,
    case when p_auto_renew then 'BILLING_AUTO_RENEW_ENABLED' else 'SUBSCRIPTION_CANCELLED' end,
    jsonb_build_object('auto_renew',p_auto_renew),p_request_id);
  return next v_subscription;
end; $$;

create or replace function control_plane.renew_license_without_billing(
  p_license_id uuid,
  p_duration_months integer,
  p_duration_days integer,
  p_new_expires_at timestamptz,
  p_renewal_basis text,
  p_new_maintenance_until timestamptz,
  p_has_new_maintenance boolean,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_actor_id text,
  p_request_id text
)
returns setof control_plane.licensing_licenses
language plpgsql
set search_path = control_plane, pg_catalog, pg_temp
as $$
declare
  v_operation control_plane.billing_admin_operations%rowtype;
  v_license control_plane.licensing_licenses%rowtype;
begin
  if nullif(btrim(p_reason), '') is null or length(p_reason) > 500
     or p_idempotency_key is null or length(p_idempotency_key) not between 16 and 200
     or p_request_fingerprint !~ '^[0-9a-f]{64}$'
     or nullif(btrim(p_actor_id), '') is null or nullif(btrim(p_request_id), '') is null
     or length(p_request_id) > 200
     or num_nonnulls(p_duration_months, p_duration_days, p_new_expires_at) <> 1
     or (p_renewal_basis is not null and p_renewal_basis not in ('previous_expiration', 'today')) then
    raise exception 'invalid no-charge renewal request';
  end if;
  perform set_config('clientix.request_id', p_request_id, true);
  select * into v_license from licensing_licenses where id=p_license_id for update;
  if not found or v_license.status in ('DRAFT','REVOKED') then raise exception 'license is not renewable'; end if;

  insert into billing_admin_operations(operation,idempotency_key,request_fingerprint,license_id)
  values('renew_without_billing',p_idempotency_key,p_request_fingerprint,p_license_id)
  on conflict do nothing;
  select * into v_operation from billing_admin_operations
   where operation='renew_without_billing' and idempotency_key=p_idempotency_key for update;
  if v_operation.license_id<>p_license_id or v_operation.request_fingerprint<>p_request_fingerprint then
    raise exception 'idempotency key already used for a different request';
  end if;
  if v_operation.completed_at is not null then
    return query select * from licensing_licenses where id=p_license_id;
    return;
  end if;
  if exists(select 1 from billing_subscriptions where license_id=p_license_id and status in ('TRIAL','ACTIVE','PAST_DUE','SUSPENDED')) then
    raise exception 'active billing subscription prevents no-charge renewal';
  end if;

  perform 1 from renew_license_with_request_id(
    p_license_id,p_duration_months,p_duration_days,p_new_expires_at,p_new_maintenance_until,p_has_new_maintenance,v_license.signing_key_id,
    p_actor_id,'lic04-nocharge:'||encode(control_plane.digest(convert_to(p_idempotency_key,'UTF8'),'sha256'),'hex'),p_request_fingerprint,p_request_id,p_renewal_basis
  );
  update billing_admin_operations set completed_at=now(),license_id=p_license_id
   where operation='renew_without_billing' and idempotency_key=p_idempotency_key;
  select * into v_license from licensing_licenses where id=p_license_id;
  insert into billing_events(customer_id,license_id,actor_type,actor_id,event_type,metadata,request_id)
  values(v_license.customer_id,v_license.id,'ADMIN',p_actor_id,'LICENSE_RENEWED_WITHOUT_BILLING',
    jsonb_build_object('reason',left(btrim(p_reason),500),'expires_at',v_license.expires_at),p_request_id);
  return next v_license;
end;
$$;

create or replace function control_plane.update_billing_settings(p_grace_days integer,p_policy text,p_invoice_lead_days integer,p_actor_id text,p_request_id text)
returns setof control_plane.billing_settings language plpgsql set search_path=control_plane,pg_catalog,pg_temp as $$
declare v_settings billing_settings%rowtype;
begin
  if p_grace_days not between 0 and 90 or p_policy not in ('SUSPEND_AFTER_GRACE','ALLOW_NATURAL_EXPIRATION') or p_invoice_lead_days not between 0 and 90 then
    raise exception 'invalid billing settings';
  end if;
  perform set_config('clientix.request_id',p_request_id,true);
  update billing_settings set billing_grace_days=p_grace_days,nonpayment_policy=p_policy,invoice_lead_days=p_invoice_lead_days,updated_by=p_actor_id,updated_at=now()
   where singleton returning * into v_settings;
  update billing_subscriptions set billing_grace_days=p_grace_days,nonpayment_policy=p_policy,updated_at=now()
   where status in ('TRIAL','ACTIVE','PAST_DUE');
  insert into billing_events(actor_type,actor_id,event_type,metadata,request_id)
  values('ADMIN',p_actor_id,'BILLING_POLICY_UPDATED',jsonb_build_object('billing_grace_days',p_grace_days,'nonpayment_policy',p_policy,'invoice_lead_days',p_invoice_lead_days),p_request_id);
  return next v_settings;
end; $$;

create or replace function control_plane.run_billing_maintenance(p_now timestamptz default now())
returns jsonb language plpgsql set search_path=control_plane,pg_catalog,pg_temp as $$
declare v_settings billing_settings%rowtype; v_sub billing_subscriptions%rowtype; v_invoice billing_invoices%rowtype;
  v_created integer:=0; v_overdue integer:=0; v_suspended integer:=0; v_notifications integer:=0; v_findings integer:=0; v_rows integer:=0;
  v_period_end timestamptz; v_summary jsonb;
begin
  select * into v_settings from billing_settings where singleton;
  for v_sub in select * from billing_subscriptions where auto_renew and status='ACTIVE'
    and next_billing_at <= p_now + make_interval(days=>v_settings.invoice_lead_days) order by next_billing_at for update skip locked loop
    v_period_end := case v_sub.billing_cycle
      when 'MONTHLY' then v_sub.current_period_end + interval '1 month'
      when 'QUARTERLY' then v_sub.current_period_end + interval '3 months'
      when 'SEMIANNUAL' then v_sub.current_period_end + interval '6 months'
      when 'ANNUAL' then v_sub.current_period_end + interval '1 year'
      else v_sub.current_period_end + (v_sub.current_period_end-v_sub.current_period_start)
    end;
    if not exists(select 1 from billing_invoices i where i.subscription_id=v_sub.id and i.period_start=v_sub.current_period_end and i.period_end=v_period_end) then
      insert into billing_invoices(subscription_id,license_id,customer_id,provider,amount_cents,currency,status,due_at,period_start,period_end,idempotency_key)
      values(v_sub.id,v_sub.license_id,v_sub.customer_id,v_sub.provider,v_sub.amount_cents,v_sub.currency,'OPEN',v_sub.next_billing_at,v_sub.current_period_end,v_period_end,'scheduled:'||v_sub.id::text||':'||to_char(v_sub.current_period_end at time zone 'UTC','YYYYMMDDHH24MISS'))
      returning * into v_invoice;
      insert into billing_events(customer_id,license_id,subscription_id,invoice_id,provider,actor_type,event_type,metadata)
      values(v_sub.customer_id,v_sub.license_id,v_sub.id,v_invoice.id,v_sub.provider,'SYSTEM','LICENSE_RENEWAL_SCHEDULED',jsonb_build_object('due_at',v_invoice.due_at,'period_end',v_period_end));
      v_created:=v_created+1;
    end if;
  end loop;

  with due as (
    insert into billing_notifications(notification_key,event_type,customer_id,license_id,subscription_id,invoice_id,metadata)
    select 'invoice:'||i.id::text||':due:'||d.days::text,'BILLING_DUE_'||d.days::text||'_DAYS',i.customer_id,i.license_id,i.subscription_id,i.id,jsonb_build_object('due_at',i.due_at)
      from billing_invoices i cross join (values (30),(15),(7),(1)) d(days)
     where i.status='OPEN' and i.due_at::date=(p_now + make_interval(days=>d.days))::date
    on conflict(notification_key) do nothing returning 1
  ) select count(*) into v_notifications from due;
  with marked as (
    update billing_invoices set status='OVERDUE',updated_at=p_now where status='OPEN' and due_at<=p_now returning *
  ) insert into billing_events(customer_id,license_id,subscription_id,invoice_id,provider,actor_type,event_type,metadata)
    select customer_id,license_id,subscription_id,id,provider,'SYSTEM','INVOICE_OVERDUE',jsonb_build_object('due_at',due_at) from marked;
  get diagnostics v_overdue = row_count;
  update billing_subscriptions s set status='PAST_DUE',updated_at=p_now
    where s.status='ACTIVE' and exists(select 1 from billing_invoices i where i.subscription_id=s.id and i.status='OVERDUE');
  insert into billing_events(customer_id,license_id,subscription_id,event_type,actor_type,metadata)
    select distinct s.customer_id,s.license_id,s.id,'BILLING_SUBSCRIPTION_PAST_DUE','SYSTEM',jsonb_build_object('billing_grace_days',s.billing_grace_days)
      from billing_subscriptions s where s.status='PAST_DUE' and exists(select 1 from billing_invoices i where i.subscription_id=s.id and i.status='OVERDUE')
      and not exists(select 1 from billing_events e where e.subscription_id=s.id and e.event_type='BILLING_SUBSCRIPTION_PAST_DUE' and e.created_at>=p_now-interval '1 day');
  insert into billing_notifications(notification_key,event_type,customer_id,license_id,subscription_id,invoice_id,metadata)
    select 'invoice:'||i.id::text||':overdue','BILLING_OVERDUE',i.customer_id,i.license_id,i.subscription_id,i.id,jsonb_build_object('due_at',i.due_at)
      from billing_invoices i where i.status='OVERDUE' on conflict(notification_key) do nothing;

  for v_sub in select * from billing_subscriptions s where s.status='PAST_DUE' and s.nonpayment_policy='SUSPEND_AFTER_GRACE'
    and exists(select 1 from billing_invoices i where i.subscription_id=s.id and i.status='OVERDUE' and i.due_at+make_interval(days=>s.billing_grace_days)<=p_now)
    for update skip locked loop
    update licensing_licenses set status='SUSPENDED',updated_at=p_now where id=v_sub.license_id and status in ('ACTIVE','EXPIRED');
    if found then
      update billing_subscriptions set status='SUSPENDED',suspended_for_nonpayment_at=p_now,updated_at=p_now where id=v_sub.id;
      insert into licensing_events(license_id,event_type,payload,actor,actor_type,actor_id,created_at)
      values(v_sub.license_id,'LICENSE_SUSPENDED_FOR_NONPAYMENT',jsonb_build_object('subscription_id',v_sub.id),'billing-worker','SYSTEM',null,p_now);
      insert into billing_events(customer_id,license_id,subscription_id,event_type,actor_type,metadata)
      values(v_sub.customer_id,v_sub.license_id,v_sub.id,'LICENSE_SUSPENDED_FOR_NONPAYMENT','SYSTEM',jsonb_build_object('grace_days',v_sub.billing_grace_days));
      v_suspended:=v_suspended+1;
    end if;
  end loop;

  v_summary:=jsonb_build_object('invoices_created',v_created,'invoices_overdue',v_overdue,'licenses_suspended',v_suspended,'notifications_created',v_notifications,'reconciliation_findings',v_findings);
  return v_summary;
end; $$;

create or replace function control_plane.reconcile_billing(p_request_id text default null)
returns jsonb language plpgsql set search_path=control_plane,pg_catalog,pg_temp as $$
declare v_count integer:=0; v_rows integer:=0;
begin
  if p_request_id is not null then perform set_config('clientix.request_id',p_request_id,true); end if;
  insert into billing_reconciliation_findings(finding_key,customer_id,license_id,subscription_id,invoice_id,finding_type,expected_state,observed_state)
  select 'paid-invoice-without-payment:'||i.id::text,i.customer_id,i.license_id,i.subscription_id,i.id,'PAID_INVOICE_WITHOUT_CONFIRMED_PAYMENT','CONFIRMED_PAYMENT','NONE'
    from billing_invoices i where i.status='PAID' and not exists(select 1 from billing_payments p where p.invoice_id=i.id and p.status in ('CONFIRMED','REFUNDED'))
  on conflict(finding_key) do update set status='OPEN',last_seen_at=now(),resolved_at=null;
  get diagnostics v_count=row_count;
  insert into billing_reconciliation_findings(finding_key,customer_id,license_id,subscription_id,invoice_id,finding_type,expected_state,observed_state)
  select 'confirmed-payment-unpaid-invoice:'||p.id::text,i.customer_id,i.license_id,i.subscription_id,i.id,'CONFIRMED_PAYMENT_UNPAID_INVOICE','PAID',i.status
    from billing_payments p join billing_invoices i on i.id=p.invoice_id where p.status='CONFIRMED' and i.status not in ('PAID','REFUNDED')
  on conflict(finding_key) do update set status='OPEN',last_seen_at=now(),resolved_at=null;
  get diagnostics v_rows=row_count;
  v_count:=v_count+v_rows;
  insert into billing_reconciliation_findings(finding_key,customer_id,license_id,subscription_id,finding_type,expected_state,observed_state)
  select 'billing-suspended-license-active-subscription:'||s.id::text,s.customer_id,s.license_id,s.id,'BILLING_LICENSE_STATE_DIVERGENCE','SUSPENDED','ACTIVE'
    from billing_subscriptions s join licensing_licenses l on l.id=s.license_id
    where s.suspended_for_nonpayment_at is not null and (s.status<>'SUSPENDED' or l.status<>'SUSPENDED')
  on conflict(finding_key) do update set status='OPEN',last_seen_at=now(),resolved_at=null;
  get diagnostics v_rows=row_count;
  v_count:=v_count+v_rows;
  update billing_reconciliation_findings f set status='RESOLVED',resolved_at=now()
   where f.status='OPEN' and f.finding_key not in (
    select 'paid-invoice-without-payment:'||i.id::text from billing_invoices i where i.status='PAID' and not exists(select 1 from billing_payments p where p.invoice_id=i.id and p.status in ('CONFIRMED','REFUNDED'))
    union all select 'confirmed-payment-unpaid-invoice:'||p.id::text from billing_payments p join billing_invoices i on i.id=p.invoice_id where p.status='CONFIRMED' and i.status not in ('PAID','REFUNDED')
    union all select 'billing-suspended-license-active-subscription:'||s.id::text from billing_subscriptions s join licensing_licenses l on l.id=s.license_id where s.suspended_for_nonpayment_at is not null and (s.status<>'SUSPENDED' or l.status<>'SUSPENDED')
   );
  return jsonb_build_object('open_findings',v_count);
end; $$;

-- Expose only the central billing role to the Control Plane application.
do $$ begin
  if exists(select 1 from pg_roles where rolname='clientix_control_plane') then
    execute 'grant select,insert,update on control_plane.billing_subscriptions,control_plane.billing_invoices,control_plane.billing_payments,control_plane.billing_events,control_plane.billing_provider_accounts_metadata,control_plane.billing_admin_operations,control_plane.billing_webhook_receipts,control_plane.billing_notifications,control_plane.billing_reconciliation_findings,control_plane.billing_settings to clientix_control_plane';
    execute 'grant execute on function control_plane.create_billing_subscription(uuid,uuid,text,text,bigint,text,timestamptz,timestamptz,boolean,text,text,text,text) to clientix_control_plane';
    execute 'grant execute on function control_plane.create_billing_invoice(uuid,timestamptz,text,text,text,text,text) to clientix_control_plane';
    execute 'grant execute on function control_plane.confirm_billing_payment(uuid,text,text,text,bigint,text,text,text,text,text,text) to clientix_control_plane';
    execute 'grant execute on function control_plane.record_billing_payment_failure(uuid,text,text,text,bigint,text,text,text) to clientix_control_plane';
    execute 'grant execute on function control_plane.cancel_billing_invoice(uuid,text,text,text) to clientix_control_plane';
    execute 'grant execute on function control_plane.refund_billing_payment(uuid,text,text,text) to clientix_control_plane';
    execute 'grant execute on function control_plane.set_billing_auto_renew(uuid,boolean,text,text) to clientix_control_plane';
    execute 'grant execute on function control_plane.update_billing_settings(integer,text,integer,text,text) to clientix_control_plane';
    execute 'grant execute on function control_plane.renew_license_without_billing(uuid,integer,integer,timestamptz,text,timestamptz,boolean,text,text,text,text,text) to clientix_control_plane';
    execute 'grant execute on function control_plane.run_billing_maintenance(timestamptz) to clientix_control_plane';
    execute 'grant execute on function control_plane.reconcile_billing(text) to clientix_control_plane';
    execute 'revoke update,delete,truncate on control_plane.billing_events from clientix_control_plane';
    execute 'revoke insert,update,delete,truncate on control_plane.billing_provider_accounts_metadata from clientix_control_plane';
  end if;
end; $$;

revoke execute on function control_plane.renew_license_without_billing(uuid,integer,integer,timestamptz,text,timestamptz,boolean,text,text,text,text,text) from public;
