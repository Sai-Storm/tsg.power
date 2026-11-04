"""Classify opening cash separately from income.

Revision ID: phase11_opening_balance
Revises: phase10_finance
"""
from alembic import op
import sqlalchemy as sa


revision = "phase11_opening_balance"
down_revision = "phase10_finance"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint("ck_cash_entries_category", "cash_entries", type_="check")
    op.create_check_constraint(
        "ck_cash_entries_category",
        "cash_entries",
        "category IN ('income','expense','opening')",
    )


def downgrade():
    bind = op.get_bind()
    opening_entries = bind.execute(
        sa.text("SELECT COUNT(*) FROM cash_entries WHERE category = 'opening'")
    ).scalar_one()
    if opening_entries:
        raise RuntimeError("Cannot remove opening-balance support while opening cash entries exist.")
    op.drop_constraint("ck_cash_entries_category", "cash_entries", type_="check")
    op.create_check_constraint(
        "ck_cash_entries_category",
        "cash_entries",
        "category IN ('income','expense')",
    )
