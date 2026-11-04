"""Classify invoice refunds as receivable reinstatements, not earned-income reversals.

Revision ID: phase16_refund_classification
Revises: phase15_accounting_workflows
"""
from alembic import op
import sqlalchemy as sa


revision = "phase16_refund_classification"
down_revision = "phase15_accounting_workflows"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(sa.text("""
        INSERT INTO financial_transactions
        (transaction_type, source_type, source_id, event_key, occurred_at, debit_account, credit_account,
         amount, reference, description, actor_id, reverses_id, created_at)
        SELECT 'reversal', 'financial_transaction', CAST(original.id AS CHAR), 'refund_reclassification',
               original.occurred_at, original.credit_account, original.debit_account, original.amount,
               original.reference, CONCAT('Reclassify refund journal entry ', original.id),
               original.actor_id, original.id, CURRENT_TIMESTAMP
        FROM financial_transactions original
        WHERE original.transaction_type = 'invoice_refund'
          AND original.source_type = 'payment'
          AND original.debit_account = 'income:service_returns'
    """))
    op.execute(sa.text("""
        INSERT INTO financial_transactions
        (transaction_type, source_type, source_id, event_key, occurred_at, debit_account, credit_account,
         amount, reference, description, actor_id, created_at)
        SELECT 'invoice_refund_reclassified', 'payment', original.source_id, 'refund_reclassified',
               original.occurred_at, 'asset:accounts_receivable', original.credit_account, original.amount,
               original.reference, original.description, original.actor_id, CURRENT_TIMESTAMP
        FROM financial_transactions original
        WHERE original.transaction_type = 'invoice_refund'
          AND original.source_type = 'payment'
          AND original.debit_account = 'income:service_returns'
    """))


def downgrade():
    op.execute(sa.text("""
        INSERT INTO financial_transactions
        (transaction_type, source_type, source_id, event_key, occurred_at, debit_account, credit_account,
         amount, reference, description, actor_id, reverses_id, created_at)
        SELECT 'reversal', 'financial_transaction', CAST(entry.id AS CHAR), 'phase16_downgrade',
               entry.occurred_at, entry.credit_account, entry.debit_account, entry.amount,
               entry.reference, 'Reverse phase 16 refund reclassification', entry.actor_id, entry.id,
               CURRENT_TIMESTAMP
        FROM financial_transactions entry
        WHERE (entry.source_type = 'financial_transaction' AND entry.event_key = 'refund_reclassification')
           OR (entry.source_type = 'payment' AND entry.event_key = 'refund_reclassified')
    """))
