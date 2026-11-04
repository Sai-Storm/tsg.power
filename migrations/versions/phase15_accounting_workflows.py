"""Add a centralized journal and approval workflows for advances and service reports.

Revision ID: phase15_accounting_workflows
Revises: phase14_advance_import_reference
"""
from alembic import op
import sqlalchemy as sa


revision = "phase15_accounting_workflows"
down_revision = "phase14_advance_import_reference"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("service_requests", sa.Column("report_approved_at", sa.DateTime(), nullable=True))
    op.add_column("service_requests", sa.Column("report_approved_by_id", sa.Integer(), nullable=True))
    op.add_column("service_requests", sa.Column("report_approval_note", sa.String(length=500), nullable=True))
    op.create_foreign_key(
        "fk_service_requests_report_approved_by", "service_requests", "users",
        ["report_approved_by_id"], ["id"], ondelete="RESTRICT",
    )
    op.add_column("payments", sa.Column("customer_advance_id", sa.Integer(), nullable=True))
    op.create_index("ix_payments_customer_advance_id", "payments", ["customer_advance_id"])

    op.create_table(
        "employee_advance_requests",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("employee_id", sa.Integer(), nullable=False),
        sa.Column("requested_amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("reason", sa.String(length=500), nullable=False),
        sa.Column("status", sa.String(length=12), nullable=False),
        sa.Column("requested_at", sa.DateTime(), nullable=False),
        sa.Column("approved_amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("approved_by_id", sa.Integer(), nullable=True),
        sa.Column("approved_at", sa.DateTime(), nullable=True),
        sa.Column("rejection_reason", sa.String(length=500), nullable=True),
        sa.Column("issued_advance_id", sa.Integer(), nullable=True),
        sa.CheckConstraint("requested_amount > 0", name="ck_advance_requests_amount_positive"),
        sa.CheckConstraint("approved_amount IS NULL OR approved_amount > 0",
                           name="ck_advance_requests_approved_positive"),
        sa.CheckConstraint("status IN ('requested','approved','rejected','issued')",
                           name="ck_advance_requests_status"),
        sa.ForeignKeyConstraint(["employee_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["approved_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["issued_advance_id"], ["employee_advances.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("issued_advance_id"),
    )
    op.create_index("ix_employee_advance_requests_employee_id", "employee_advance_requests", ["employee_id"])
    op.create_index("ix_employee_advance_requests_requested_at", "employee_advance_requests", ["requested_at"])
    op.create_index("ix_employee_advance_requests_status", "employee_advance_requests", ["status"])

    op.create_table(
        "customer_advances",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("advance_number", sa.String(length=24), nullable=False),
        sa.Column("customer_id", sa.Integer(), nullable=False),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("method", sa.String(length=15), nullable=False),
        sa.Column("reference", sa.String(length=100), nullable=True),
        sa.Column("received_at", sa.DateTime(), nullable=False),
        sa.Column("received_by_id", sa.Integer(), nullable=False),
        sa.Column("notes", sa.String(length=500), nullable=True),
        sa.CheckConstraint("amount > 0", name="ck_customer_advances_amount_positive"),
        sa.CheckConstraint("method IN ('cash','upi','bank_transfer','card','cheque','other')",
                           name="ck_customer_advances_method"),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["received_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("advance_number"),
        sa.UniqueConstraint("reference"),
    )
    op.create_index("ix_customer_advances_customer_id", "customer_advances", ["customer_id"])
    op.create_index("ix_customer_advances_received_at", "customer_advances", ["received_at"])
    op.create_foreign_key(
        "fk_payments_customer_advance", "payments", "customer_advances",
        ["customer_advance_id"], ["id"], ondelete="RESTRICT",
    )

    op.create_table(
        "financial_transactions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("transaction_type", sa.String(length=40), nullable=False),
        sa.Column("source_type", sa.String(length=40), nullable=False),
        sa.Column("source_id", sa.String(length=40), nullable=False),
        sa.Column("event_key", sa.String(length=40), nullable=False),
        sa.Column("occurred_at", sa.DateTime(), nullable=False),
        sa.Column("debit_account", sa.String(length=60), nullable=False),
        sa.Column("credit_account", sa.String(length=60), nullable=False),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("reference", sa.String(length=120), nullable=True),
        sa.Column("description", sa.String(length=500), nullable=False),
        sa.Column("actor_id", sa.Integer(), nullable=True),
        sa.Column("reverses_id", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("amount > 0", name="ck_financial_transactions_amount_positive"),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["reverses_id"], ["financial_transactions.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source_type", "source_id", "event_key", name="uq_financial_source_event"),
    )
    op.create_index("ix_financial_transactions_transaction_type", "financial_transactions", ["transaction_type"])
    op.create_index("ix_financial_transactions_occurred_at", "financial_transactions", ["occurred_at"])
    op.create_index("ix_financial_transactions_debit_account", "financial_transactions", ["debit_account"])
    op.create_index("ix_financial_transactions_credit_account", "financial_transactions", ["credit_account"])
    op.create_index("ix_financial_transactions_actor_id", "financial_transactions", ["actor_id"])

    bind = op.get_bind()
    dialect = bind.dialect.name

    def backfill(statement):
        if dialect == "mysql":
            op.execute(sa.text(statement))

    backfill("""
        INSERT INTO financial_transactions
        (transaction_type, source_type, source_id, event_key, occurred_at, debit_account, credit_account,
         amount, reference, description, actor_id, created_at)
        SELECT 'invoice_issued', 'invoice', CAST(id AS CHAR), 'issued', issued_at,
               'asset:accounts_receivable', 'income:service_revenue', total, invoice_number,
               CONCAT('Invoice ', invoice_number, ' issued'), issued_by_id, CURRENT_TIMESTAMP
        FROM invoices WHERE issued_at IS NOT NULL AND status <> 'draft' AND total > 0
    """)
    backfill("""
        INSERT INTO financial_transactions
        (transaction_type, source_type, source_id, event_key, occurred_at, debit_account, credit_account,
         amount, reference, description, actor_id, created_at)
        SELECT 'invoice_void', 'invoice', CAST(id AS CHAR), 'void_reversal', COALESCE(voided_at, issued_at),
               'income:service_revenue', 'asset:accounts_receivable', total, invoice_number,
               CONCAT('Historical void of invoice ', invoice_number), voided_by_id, CURRENT_TIMESTAMP
        FROM invoices WHERE status = 'void' AND issued_at IS NOT NULL AND total > 0
    """)
    backfill("""
        INSERT INTO financial_transactions
        (transaction_type, source_type, source_id, event_key, occurred_at, debit_account, credit_account,
         amount, reference, description, actor_id, created_at)
        SELECT CASE payment_type WHEN 'payment' THEN 'invoice_payment'
                    WHEN 'refund' THEN 'invoice_refund' ELSE 'invoice_adjustment' END,
               'payment', CAST(id AS CHAR), 'posted', paid_at,
               CASE WHEN payment_type = 'payment' AND method = 'cash' THEN 'asset:cash'
                    WHEN payment_type = 'payment' AND method = 'customer_credit' THEN 'liability:customer_deposits'
                    WHEN payment_type = 'payment' THEN 'asset:bank'
                    WHEN payment_type = 'refund' THEN 'income:service_returns'
                    ELSE 'expense:invoice_writeoff' END,
               CASE WHEN payment_type = 'payment' THEN 'asset:accounts_receivable'
                    WHEN payment_type = 'refund' AND method = 'cash' THEN 'asset:cash'
                    WHEN payment_type = 'refund' THEN 'asset:bank'
                    ELSE 'asset:accounts_receivable' END,
               amount, COALESCE(reference, number), CONCAT('Historical ', payment_type, ' ', number),
               received_by_id, CURRENT_TIMESTAMP
        FROM payments
    """)
    backfill("""
        INSERT INTO financial_transactions
        (transaction_type, source_type, source_id, event_key, occurred_at, debit_account, credit_account,
         amount, reference, description, actor_id, created_at)
        SELECT 'employee_advance_issued', 'employee_advance', CAST(id AS CHAR), 'issued', issued_at,
               'asset:employee_advances', 'asset:cash', amount, COALESCE(external_reference, advance_number),
               CONCAT('Historical employee advance ', advance_number), issued_by_id, CURRENT_TIMESTAMP
        FROM employee_advances WHERE amount > 0
    """)
    backfill("""
        INSERT INTO financial_transactions
        (transaction_type, source_type, source_id, event_key, occurred_at, debit_account, credit_account,
         amount, reference, description, actor_id, created_at)
        SELECT 'employee_advance_return', 'advance_return', CAST(id AS CHAR), 'returned', returned_at,
               'asset:cash', 'asset:employee_advances', amount, CAST(advance_id AS CHAR),
               'Historical employee advance return', received_by_id, CURRENT_TIMESTAMP
        FROM advance_returns WHERE amount > 0
    """)
    backfill("""
        INSERT INTO financial_transactions
        (transaction_type, source_type, source_id, event_key, occurred_at, debit_account, credit_account,
         amount, reference, description, actor_id, created_at)
        SELECT 'employee_claim_advance_offset', 'expense_claim', CAST(id AS CHAR), 'advance_offset',
               approved_at, 'expense:employee_claims', 'asset:employee_advances', advance_offset,
               claim_number, CONCAT('Historical claim advance offset ', claim_number), approved_by_id,
               CURRENT_TIMESTAMP
        FROM expense_claims
        WHERE status IN ('approved','paid') AND advance_offset > 0 AND approved_at IS NOT NULL
    """)
    backfill("""
        INSERT INTO financial_transactions
        (transaction_type, source_type, source_id, event_key, occurred_at, debit_account, credit_account,
         amount, reference, description, actor_id, created_at)
        SELECT 'employee_claim_approved', 'expense_claim', CAST(id AS CHAR), 'reimbursement_due',
               approved_at, 'expense:employee_claims', 'liability:employee_reimbursements',
               amount - advance_offset, claim_number, CONCAT('Historical approved claim ', claim_number),
               approved_by_id, CURRENT_TIMESTAMP
        FROM expense_claims
        WHERE status IN ('approved','paid') AND amount > advance_offset AND approved_at IS NOT NULL
    """)
    backfill("""
        INSERT INTO financial_transactions
        (transaction_type, source_type, source_id, event_key, occurred_at, debit_account, credit_account,
         amount, reference, description, actor_id, created_at)
        SELECT 'employee_claim_reimbursement', 'expense_claim', CAST(id AS CHAR), 'reimbursement_paid',
               paid_at, 'liability:employee_reimbursements',
               CASE WHEN reimbursement_method = 'cash' THEN 'asset:cash' ELSE 'asset:bank' END,
               reimbursement_paid, claim_number, CONCAT('Historical claim reimbursement ', claim_number),
               approved_by_id, CURRENT_TIMESTAMP
        FROM expense_claims WHERE status = 'paid' AND reimbursement_paid > 0 AND paid_at IS NOT NULL
    """)
    backfill("""
        INSERT INTO financial_transactions
        (transaction_type, source_type, source_id, event_key, occurred_at, debit_account, credit_account,
         amount, reference, description, actor_id, created_at)
        SELECT 'cash_entry', 'cash_entry', CAST(id AS CHAR), 'recorded', occurred_at,
               CASE WHEN category = 'income' OR category = 'opening' THEN 'asset:cash' ELSE 'expense:other' END,
               CASE WHEN category = 'income' THEN 'income:other'
                    WHEN category = 'opening' THEN 'equity:opening' ELSE 'asset:cash' END,
               amount, COALESCE(reference, entry_number), CONCAT('Historical cash entry ', entry_number),
               recorded_by_id, CURRENT_TIMESTAMP
        FROM cash_entries WHERE amount > 0
    """)

    op.execute(sa.text("""
        UPDATE service_requests s
        JOIN invoices i ON i.service_request_id = s.id
        SET s.report_approved_at = COALESCE(i.issued_at, i.created_at),
            s.report_approved_by_id = i.created_by_id,
            s.report_approval_note = 'Backfilled as approved because an invoice already exists.'
        WHERE s.status IN ('completed','closed') AND s.report_approved_at IS NULL
    """)) if dialect == "mysql" else None


def downgrade():
    op.drop_index("ix_financial_transactions_actor_id", table_name="financial_transactions")
    op.drop_index("ix_financial_transactions_credit_account", table_name="financial_transactions")
    op.drop_index("ix_financial_transactions_debit_account", table_name="financial_transactions")
    op.drop_index("ix_financial_transactions_occurred_at", table_name="financial_transactions")
    op.drop_index("ix_financial_transactions_transaction_type", table_name="financial_transactions")
    op.drop_table("financial_transactions")
    op.drop_index("ix_payments_customer_advance_id", table_name="payments")
    op.drop_constraint("fk_payments_customer_advance", "payments", type_="foreignkey")
    op.drop_column("payments", "customer_advance_id")
    op.drop_index("ix_customer_advances_received_at", table_name="customer_advances")
    op.drop_index("ix_customer_advances_customer_id", table_name="customer_advances")
    op.drop_table("customer_advances")
    op.drop_index("ix_employee_advance_requests_status", table_name="employee_advance_requests")
    op.drop_index("ix_employee_advance_requests_requested_at", table_name="employee_advance_requests")
    op.drop_index("ix_employee_advance_requests_employee_id", table_name="employee_advance_requests")
    op.drop_table("employee_advance_requests")
    op.drop_constraint("fk_service_requests_report_approved_by", "service_requests", type_="foreignkey")
    op.drop_column("service_requests", "report_approval_note")
    op.drop_column("service_requests", "report_approved_by_id")
    op.drop_column("service_requests", "report_approved_at")
