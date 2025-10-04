from odoo import api, fields, models, _
from odoo.exceptions import ValidationError


class AccountPaymentAllocation(models.Model):
    _name = 'account.payment.allocation'
    _description = 'Payment Allocation Line'
    _order = 'id'

    payment_id = fields.Many2one('account.payment', required=True, ondelete='cascade')
    move_id = fields.Many2one(
        'account.move',
        string='Invoice/Bill',
        domain="['&', ('state', '=', 'posted'), ('payment_state', 'in', ('not_paid', 'partial'))]",
        required=True,
    )
    partner_id = fields.Many2one(related='payment_id.partner_id', store=True, readonly=True)
    company_id = fields.Many2one(related='payment_id.company_id', store=True, readonly=True)
    currency_id = fields.Many2one(related='payment_id.currency_id', store=True, readonly=True)

    allocated_amount = fields.Monetary(currency_field='currency_id', required=True)

    invoice_residual = fields.Monetary(related='move_id.amount_residual', currency_field='currency_id', readonly=True)
    invoice_amount_total = fields.Monetary(related='move_id.amount_total', currency_field='currency_id', readonly=True)
    invoice_date = fields.Date(related='move_id.invoice_date', readonly=True)
    invoice_name = fields.Char(related='move_id.name', readonly=True)

    @api.constrains('allocated_amount')
    def _check_allocated_amount_positive(self):
        for rec in self:
            if rec.allocated_amount <= 0:
                raise ValidationError(_('Allocated amount must be strictly positive.'))

    @api.constrains('move_id')
    def _check_move_partner_company(self):
        for rec in self:
            if rec.move_id and rec.payment_id:
                if rec.move_id.partner_id != rec.payment_id.partner_id:
                    raise ValidationError(_('Allocation invoice/bill must belong to the same partner as the payment.'))
                if rec.move_id.company_id != rec.payment_id.company_id:
                    raise ValidationError(_('Allocation invoice/bill must belong to the same company as the payment.'))
