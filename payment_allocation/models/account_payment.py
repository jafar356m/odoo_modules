from odoo import api, fields, models, _
from odoo.tools import float_compare
from odoo.exceptions import ValidationError


class AccountPayment(models.Model):
    _inherit = 'account.payment'

    allocation_line_ids = fields.One2many(
        'account.payment.allocation',
        'payment_id',
        string='Manual Allocations',
        copy=False,
    )

    @api.constrains('allocation_line_ids', 'amount', 'currency_id')
    def _check_allocation_total(self):
        for payment in self:
            if not payment.allocation_line_ids:
                continue
            total_alloc = sum(payment.allocation_line_ids.mapped('allocated_amount'))
            # Currency-aware comparison (Option A): total allocated must be <= payment amount
            precision = payment.currency_id.rounding or payment.company_id.currency_id.rounding or 0.01
            if float_compare(total_alloc, payment.amount, precision_rounding=precision) == 1:
                raise ValidationError(_(
                    'The sum of allocated amounts (%(alloc).2f) cannot exceed the payment amount (%(amount).2f).'
                ) % {'alloc': total_alloc, 'amount': payment.amount})

    def action_post(self):
        res = super().action_post()
        for payment in self:
            lines = payment.allocation_line_ids.filtered(lambda l: l.allocated_amount > 0)
            if not lines:
                continue
            # Only support same company currency for now to keep reconciliation precise
            if payment.currency_id != payment.company_id.currency_id:
                # Skip custom reconciliation in multi-currency; Odoo residuals will remain and can be matched later
                continue
            move = payment.move_id
            if not move:
                continue
            # Get payment move receivable/payable lines (accounts that are reconcilable and not reconciled)
            pay_lines = move.line_ids.filtered(lambda l: l.account_id.reconcile and not l.reconciled and l.partner_id == payment.partner_id)
            if not pay_lines:
                continue
            pay_line = pay_lines[0]
            for alloc in lines:
                invoice = alloc.move_id
                if not invoice or invoice.state != 'posted' or invoice.payment_state == 'paid':
                    continue
                inv_lines = invoice.line_ids.filtered(lambda l: l.account_id.reconcile and not l.reconciled and l.partner_id == payment.partner_id)
                if not inv_lines:
                    continue
                inv_line = inv_lines[0]
                # Compute amount in company currency
                amount_cc = alloc.allocated_amount  # same as company currency by constraint above
                # Determine debit/credit lines for partial reconcile
                if inv_line.balance > 0:
                    debit_line = inv_line
                    credit_line = pay_line
                else:
                    debit_line = pay_line
                    credit_line = inv_line
                # Prepare currency amounts to avoid None in residual computations
                company_currency = payment.company_id.currency_id
                reconcile_vals = {
                    'debit_move_id': debit_line.id,
                    'credit_move_id': credit_line.id,
                    'amount': amount_cc,
                    'company_currency_id': company_currency.id,
                }
                # Compute amount_currency for debit/credit lines
                debit_amt_cur = 0.0
                if debit_line.currency_id:
                    debit_amt_cur = company_currency._convert(amount_cc, debit_line.currency_id, payment.company_id, move.date)
                credit_amt_cur = 0.0
                if credit_line.currency_id:
                    credit_amt_cur = company_currency._convert(amount_cc, credit_line.currency_id, payment.company_id, move.date)
                reconcile_vals.update({
                    'debit_amount_currency': debit_amt_cur,
                    'credit_amount_currency': credit_amt_cur,
                })
                # Create a partial reconcile for the allocated amount
                self.env['account.partial.reconcile'].create(reconcile_vals)
                # Refresh to continue with updated residuals
                (inv_line | pay_line).invalidate_recordset(['amount_residual', 'reconciled'])
        return res
