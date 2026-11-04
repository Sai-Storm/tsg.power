"""Add an idempotency reference to imported employee advances.

Revision ID: phase14_advance_import_reference
Revises: phase13_remove_password_reset
"""
from alembic import op
import sqlalchemy as sa


revision = "phase14_advance_import_reference"
down_revision = "phase13_remove_password_reset"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "employee_advances",
        sa.Column("external_reference", sa.String(length=100), nullable=True),
    )
    op.create_index(
        "ix_employee_advances_external_reference",
        "employee_advances",
        ["external_reference"],
        unique=True,
    )
    op.create_table(
        "accounting_import_references",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("scope", sa.String(length=80), nullable=False),
        sa.Column("reference", sa.String(length=120), nullable=False),
        sa.Column("imported_by_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["imported_by_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("scope", "reference", name="uq_accounting_import_scope_reference"),
    )


def downgrade():
    op.drop_table("accounting_import_references")
    op.drop_index("ix_employee_advances_external_reference", table_name="employee_advances")
    op.drop_column("employee_advances", "external_reference")
