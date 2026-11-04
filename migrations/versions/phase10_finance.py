"""Add employee advances, expense claims, and cash entries.

Revision ID: phase10_finance
Revises: phase9_notifications
"""
from alembic import op
import sqlalchemy as sa


revision = "phase10_finance"
down_revision = "phase9_notifications"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "employee_advances",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("advance_number", sa.String(length=24), nullable=False),
        sa.Column("employee_id", sa.Integer(), nullable=False),
        sa.Column("amount", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column("reason", sa.String(length=500), nullable=False),
        sa.Column("issued_at", sa.DateTime(), nullable=False),
        sa.Column("issued_by_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("amount > 0", name="ck_employee_advances_amount_positive"),
        sa.ForeignKeyConstraint(["employee_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["issued_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("advance_number"),
    )
    op.create_index("ix_employee_advances_employee_id", "employee_advances", ["employee_id"])
    op.create_index("ix_employee_advances_issued_at", "employee_advances", ["issued_at"])

    op.create_table(
        "advance_returns",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("advance_id", sa.Integer(), nullable=False),
        sa.Column("amount", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column("note", sa.String(length=500), nullable=True),
        sa.Column("returned_at", sa.DateTime(), nullable=False),
        sa.Column("received_by_id", sa.Integer(), nullable=False),
        sa.CheckConstraint("amount > 0", name="ck_advance_returns_amount_positive"),
        sa.ForeignKeyConstraint(["advance_id"], ["employee_advances.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["received_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_advance_returns_advance_id", "advance_returns", ["advance_id"])
    op.create_index("ix_advance_returns_returned_at", "advance_returns", ["returned_at"])

    op.create_table(
        "expense_claims",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("claim_number", sa.String(length=24), nullable=False),
        sa.Column("employee_id", sa.Integer(), nullable=False),
        sa.Column("advance_id", sa.Integer(), nullable=True),
        sa.Column("category", sa.String(length=20), nullable=False),
        sa.Column("description", sa.String(length=500), nullable=False),
        sa.Column("receipt_reference", sa.String(length=120), nullable=True),
        sa.Column("incurred_on", sa.Date(), nullable=False),
        sa.Column("amount", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column("advance_offset", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column("reimbursement_paid", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column("reimbursement_method", sa.String(length=15), nullable=True),
        sa.Column("status", sa.String(length=12), nullable=False),
        sa.Column("submitted_at", sa.DateTime(), nullable=False),
        sa.Column("approved_at", sa.DateTime(), nullable=True),
        sa.Column("approved_by_id", sa.Integer(), nullable=True),
        sa.Column("rejection_reason", sa.String(length=500), nullable=True),
        sa.Column("paid_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "amount > 0 AND advance_offset >= 0 AND advance_offset <= amount AND reimbursement_paid >= 0",
            name="ck_expense_claims_amounts",
        ),
        sa.CheckConstraint(
            "category IN ('travel','meals','fuel','parts','accommodation','other')",
            name="ck_expense_claims_category",
        ),
        sa.CheckConstraint(
            "status IN ('submitted','approved','paid','rejected')",
            name="ck_expense_claims_status",
        ),
        sa.ForeignKeyConstraint(["advance_id"], ["employee_advances.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["approved_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["employee_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("claim_number"),
    )
    op.create_index("ix_expense_claims_advance_id", "expense_claims", ["advance_id"])
    op.create_index("ix_expense_claims_approved_at", "expense_claims", ["approved_at"])
    op.create_index("ix_expense_claims_employee_id", "expense_claims", ["employee_id"])
    op.create_index("ix_expense_claims_incurred_on", "expense_claims", ["incurred_on"])
    op.create_index("ix_expense_claims_status", "expense_claims", ["status"])
    op.create_index("ix_expense_claims_submitted_at", "expense_claims", ["submitted_at"])

    op.create_table(
        "cash_entries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("entry_number", sa.String(length=24), nullable=False),
        sa.Column("direction", sa.String(length=3), nullable=False),
        sa.Column("category", sa.String(length=10), nullable=False),
        sa.Column("description", sa.String(length=500), nullable=False),
        sa.Column("reference", sa.String(length=120), nullable=True),
        sa.Column("amount", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column("occurred_at", sa.DateTime(), nullable=False),
        sa.Column("recorded_by_id", sa.Integer(), nullable=False),
        sa.CheckConstraint("amount > 0", name="ck_cash_entries_amount_positive"),
        sa.CheckConstraint("category IN ('income','expense')", name="ck_cash_entries_category"),
        sa.CheckConstraint("direction IN ('in','out')", name="ck_cash_entries_direction"),
        sa.ForeignKeyConstraint(["recorded_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("entry_number"),
    )
    op.create_index("ix_cash_entries_occurred_at", "cash_entries", ["occurred_at"])


def downgrade():
    op.drop_index("ix_cash_entries_occurred_at", table_name="cash_entries")
    op.drop_table("cash_entries")
    op.drop_index("ix_expense_claims_submitted_at", table_name="expense_claims")
    op.drop_index("ix_expense_claims_status", table_name="expense_claims")
    op.drop_index("ix_expense_claims_incurred_on", table_name="expense_claims")
    op.drop_index("ix_expense_claims_employee_id", table_name="expense_claims")
    op.drop_index("ix_expense_claims_approved_at", table_name="expense_claims")
    op.drop_index("ix_expense_claims_advance_id", table_name="expense_claims")
    op.drop_table("expense_claims")
    op.drop_index("ix_advance_returns_returned_at", table_name="advance_returns")
    op.drop_index("ix_advance_returns_advance_id", table_name="advance_returns")
    op.drop_table("advance_returns")
    op.drop_index("ix_employee_advances_issued_at", table_name="employee_advances")
    op.drop_index("ix_employee_advances_employee_id", table_name="employee_advances")
    op.drop_table("employee_advances")
