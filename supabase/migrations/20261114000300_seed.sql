-- Default settings. Safe to re-run.
insert into public.settings (key, label, value) values
  ('company_name', 'Company name', 'TSG Power Engineering Co., Ltd.'),
  ('company_phone', 'Company phone', ''),
  ('company_email', 'Company email', ''),
  ('company_address', 'Company address', ''),
  ('tax_rate', 'Tax rate', '18'),
  ('opening_cash_balance', 'Opening cash balance', '0'),
  ('quotation_prefix', 'Quotation prefix', 'QT-'),
  ('job_order_prefix', 'Job order prefix', 'TSG'),
  ('invoice_prefix', 'Invoice prefix', 'INV-'),
  ('expense_prefix', 'Expense voucher prefix', 'EV-'),
  ('machine_types', 'Machine types', E'Compressor\nGenerator\nChiller'),
  ('office_expense_types', 'Office expense types', E'Rent\nElectricity\nFuel\nStationery')
on conflict (key) do nothing;
