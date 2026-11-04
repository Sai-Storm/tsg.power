"""Historical migration for the discontinued email OTP password reset feature.

Revision ID: phase12_password_reset
Revises: phase11_opening_balance
"""
from alembic import op
import sqlalchemy as sa


revision = "phase12_password_reset"
down_revision = "phase11_opening_balance"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "password_reset_challenges",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("last_sent_at", sa.DateTime(), nullable=False),
        sa.Column("failed_attempts", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id"),
    )
    op.create_index(
        "ix_password_reset_challenges_expires_at",
        "password_reset_challenges",
        ["expires_at"],
    )


def downgrade():
    op.drop_index("ix_password_reset_challenges_expires_at", table_name="password_reset_challenges")
    op.drop_table("password_reset_challenges")
