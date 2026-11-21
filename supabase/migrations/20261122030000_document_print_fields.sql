-- ============================================================================
-- Fields for the TSG document layout (service invoice letterhead)
-- ============================================================================
-- The printed invoice / quotation / job order shows:
--   Customer Name, Machine/KVA/Sr, Work Order No., Attention, Address, PO.
--   * invoices.po_number     customer purchase-order reference (new)
--   * invoices.attention     person the invoice is addressed to (new; falls
--                            back to the customer's contact person)
--   * quotations.attention   same for quotations (new)
--   * machine_label          e.g. "400KVA (Perkins 2300) · Sr X123" built from
--                            the job's registered machine or equipment fields
--
-- Idempotent: safe to run more than once.

alter table public.invoices add column if not exists po_number text;
alter table public.invoices add column if not exists attention text;
alter table public.quotations add column if not exists attention text;

create or replace function public.format_machine_label(
  p_machine uuid, p_equipment_type text, p_equipment_model text, p_serial text
)
returns text
language sql
stable
set search_path = public
as $$
  select nullif(concat_ws(' · ',
    nullif(concat_ws(' ',
      case when m.capacity is not null
        then trim(trailing '.' from trim(trailing '0' from m.capacity::text)) || coalesce(m.capacity_unit, '')
      end,
      case when coalesce(m.brand, m.model) is not null
        then '(' || concat_ws(' ', m.brand, m.model) || ')'
      end
    ), ''),
    case when m.id is null then nullif(concat_ws(' ', p_equipment_type, p_equipment_model), '') end,
    case when coalesce(m.serial_no, p_serial) is not null then 'Sr ' || coalesce(m.serial_no, p_serial) end
  ), '')
  from (select 1) one
  left join public.machines m on m.id = p_machine and m.deleted_at is null;
$$;

grant execute on function public.format_machine_label(uuid, text, text, text) to authenticated;

-- Invoices -------------------------------------------------------------------
drop view if exists public.v_invoices;
create view public.v_invoices
with (security_invoker = true) as
select i.*,
  c.name as customer,
  i.date as issued,
  public.money(i.total) as amount,
  c.name as customer_name,
  c.billing_address as customer_address,
  coalesce(nullif(i.attention, ''), c.contact_person) as customer_contact,
  j.number as job_number,
  j.title as job_title,
  public.format_machine_label(j.machine_id, j.equipment_type, j.equipment_model, j.serial_number) as machine_label
from public.invoices i
left join public.customers c on c.id = i.customer_id
left join public.jobs j on j.id = i.job_id
where i.deleted_at is null;

grant select on public.v_invoices to authenticated;

-- Quotations -----------------------------------------------------------------
drop view if exists public.v_quotations;
create view public.v_quotations
with (security_invoker = true) as
select q.*,
  c.name as customer,
  public.money(q.total) as amount,
  c.name as customer_name,
  c.billing_address as customer_address,
  coalesce(nullif(q.attention, ''), c.contact_person) as customer_contact
from public.quotations q
left join public.customers c on c.id = q.customer_id
where q.deleted_at is null;

grant select on public.v_quotations to authenticated;

-- Jobs: add the machine label for the job order print -------------------------
create or replace view public.v_jobs
with (security_invoker = true) as
select j.*,
  c.name as customer_name,
  j.planned_end_date as due_date,
  coalesce(c.name || ' · ' || nullif(coalesce(j.equipment_type, j.title, ''), ''), j.title, '—') as customer_machine,
  coalesce(st.name, 'Unassigned') as assigned_to_name,
  coalesce(tl.name, 'Unassigned') as team_leader_name,
  public.format_machine_label(j.machine_id, j.equipment_type, j.equipment_model, j.serial_number) as machine_label,
  c.billing_address as customer_address,
  c.contact_person as customer_contact
from public.jobs j
left join public.customers c on c.id = j.customer_id
left join public.staff st on st.id = j.assigned_to
left join public.staff tl on tl.id = j.team_leader
where j.deleted_at is null;
