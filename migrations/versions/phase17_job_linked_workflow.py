"""Support standalone quotations and job-linked employee finance records.

Revision ID: phase17_job_workflow
Revises: phase16_refund_classification
"""
from alembic import op
import sqlalchemy as sa


revision = "phase17_job_workflow"
down_revision = "phase16_refund_classification"
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column(
        "service_estimates", "service_request_id",
        existing_type=sa.Integer(), nullable=True,
    )
    op.add_column("service_estimates", sa.Column("quotation_number", sa.String(length=24), nullable=True))
    op.add_column("service_estimates", sa.Column("customer_id", sa.Integer(), nullable=True))
    op.add_column("service_estimates", sa.Column("generator_id", sa.Integer(), nullable=True))
    op.add_column("service_estimates", sa.Column("service_type_id", sa.Integer(), nullable=True))
    op.add_column("service_estimates", sa.Column("priority_id", sa.Integer(), nullable=True))
    op.add_column("service_estimates", sa.Column("complaint", sa.Text(), nullable=True))
    op.add_column("service_estimates", sa.Column("location", sa.String(length=255), nullable=True))
    op.create_foreign_key("fk_estimates_customer", "service_estimates", "customers",
                          ["customer_id"], ["id"], ondelete="RESTRICT")
    op.create_foreign_key("fk_estimates_generator", "service_estimates", "generators",
                          ["generator_id"], ["id"], ondelete="RESTRICT")
    op.create_foreign_key("fk_estimates_service_type", "service_estimates", "service_types",
                          ["service_type_id"], ["id"], ondelete="RESTRICT")
    op.create_foreign_key("fk_estimates_priority", "service_estimates", "priorities",
                          ["priority_id"], ["id"], ondelete="RESTRICT")
    op.create_index("ix_service_estimates_customer_id", "service_estimates", ["customer_id"])
    op.create_index("ix_service_estimates_generator_id", "service_estimates", ["generator_id"])
    op.create_unique_constraint("uq_service_estimates_quotation_number", "service_estimates", ["quotation_number"])
    op.add_column("service_requests", sa.Column("source_quotation_number", sa.String(length=24), nullable=True))
    op.create_unique_constraint("uq_service_requests_source_quotation", "service_requests",
                                ["source_quotation_number"])
    op.add_column("service_requests", sa.Column("report_submitted_by_id", sa.Integer(), nullable=True))
    op.create_foreign_key("fk_service_requests_report_submitted_by", "service_requests", "users",
                          ["report_submitted_by_id"], ["id"], ondelete="RESTRICT")

    for table in ("employee_advance_requests", "employee_advances", "expense_claims"):
        op.add_column(table, sa.Column("service_request_id", sa.Integer(), nullable=True))
        op.create_foreign_key(
            f"fk_{table}_service_request", table, "service_requests",
            ["service_request_id"], ["id"], ondelete="RESTRICT",
        )
        op.create_index(f"ix_{table}_service_request_id", table, ["service_request_id"])


def downgrade():
    for table in ("expense_claims", "employee_advances", "employee_advance_requests"):
        op.drop_index(f"ix_{table}_service_request_id", table_name=table)
        op.drop_constraint(f"fk_{table}_service_request", table, type_="foreignkey")
        op.drop_column(table, "service_request_id")

    op.drop_constraint("uq_service_requests_source_quotation", "service_requests", type_="unique")
    op.drop_constraint("fk_service_requests_report_submitted_by", "service_requests", type_="foreignkey")
    op.drop_column("service_requests", "report_submitted_by_id")
    op.drop_column("service_requests", "source_quotation_number")
    op.drop_constraint("uq_service_estimates_quotation_number", "service_estimates", type_="unique")
    op.drop_index("ix_service_estimates_generator_id", table_name="service_estimates")
    op.drop_index("ix_service_estimates_customer_id", table_name="service_estimates")
    op.drop_constraint("fk_estimates_priority", "service_estimates", type_="foreignkey")
    op.drop_constraint("fk_estimates_service_type", "service_estimates", type_="foreignkey")
    op.drop_constraint("fk_estimates_generator", "service_estimates", type_="foreignkey")
    op.drop_constraint("fk_estimates_customer", "service_estimates", type_="foreignkey")
    for column in ("location", "complaint", "priority_id", "service_type_id", "generator_id", "customer_id",
                   "quotation_number"):
        op.drop_column("service_estimates", column)
    op.alter_column(
        "service_estimates", "service_request_id",
        existing_type=sa.Integer(), nullable=False,
    )
