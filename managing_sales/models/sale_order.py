from odoo import models, fields, api
from odoo import models, api, exceptions, _
from odoo.exceptions import AccessError, ValidationError


class SaleOrder(models.Model):
    _inherit = 'sale.order'

    manager_reference = fields.Char(string="Manager Reference")
    can_edit_manager_reference = fields.Boolean(
        string="Can Edit Manager Reference",
        compute="_compute_can_edit_manager_reference",
        store=False
    )
    auto_workflow = fields.Boolean(string="Auto Workflow", help="Enable to automate workflow")


    @api.depends('manager_reference')
    def _compute_can_edit_manager_reference(self):
        for record in self:
            record.can_edit_manager_reference = self.env.user.has_group('managing_sales.group_sale_admin')

    def action_confirm(self):

        sale_order_limit = float(self.env['ir.config_parameter'].sudo().get_param('sale_order_limit', default=0.0))

        # Check if the order amount exceeds the limit
        if sale_order_limit > 0 and self.amount_total > sale_order_limit:
            raise ValidationError(_(
                "The total amount of the sale order exceeds the allowed limit of %.2f. Please adjust the order."
                % sale_order_limit
            ))

        if not self.env.user.has_group('managing_sales.group_sale_admin'):
            raise exceptions.AccessError(
                _("You do not have the necessary permissions to confirm a sale order. Only Sale Admins can confirm sales.")
            )
        # Call the original method
        res = super(SaleOrder, self).action_confirm()

        # Trigger auto workflow if enabled
        if self.auto_workflow:
            self._process_auto_workflow()
        return res

    def _process_auto_workflow(self):
        """Automate the workflow for delivery, invoice, and payment."""
        for order in self:
            # Group sale order lines by product and UoM for identical products
            product_groups = {}
            for line in order.order_line:
                product_key = (line.product_id.id, line.product_uom.id)
                if product_key not in product_groups:
                    product_groups[product_key] = self.env['sale.order.line']
                product_groups[product_key] |= line

            # Create deliveries for each unique product group
            for product_key, lines in product_groups.items():
                # Split lines into multiple deliveries if needed
                while lines:
                    batch_lines = self._get_batch_lines(lines)
                    picking = self._create_delivery(batch_lines)
                    picking.action_confirm()

                    # Mark quantities as done
                    picking.move_ids_without_package.write(
                        {'quantity': picking.move_ids_without_package.product_uom_qty}
                    )
                    picking.button_validate()
                    lines -= batch_lines

            # Create and validate invoice using the default Odoo method
            if order.invoice_status == 'to invoice':
                invoice = order._create_invoices()
                invoice.action_post()

            # Register payment
            payment_vals = {
                'journal_id': self.env['account.journal'].search([('type', '=', 'bank')], limit=1).id,
                'amount': invoice.amount_total,
                'partner_id': invoice.partner_id.id,
                'payment_type': 'inbound',
                'payment_method_id': self.env.ref('account.account_payment_method_manual_in').id,
            }
            payment = self.env['account.payment'].create(payment_vals)
            payment.action_post()

    def _get_batch_lines(self, lines):
        """
        Helper method to get a batch of lines for a single delivery.
        Adjust this logic to control batch size or other criteria.
        """
        # For simplicity, include all lines in the same batch for identical products
        # You can split based on quantity, location, etc., if needed
        return lines

    def _create_delivery(self, lines):
        """Create a stock picking for the given lines."""
        picking = self.env['stock.picking'].create({
            'partner_id': self.partner_id.id,
            'location_id': self.warehouse_id.lot_stock_id.id,
            'location_dest_id': self.partner_id.property_stock_customer.id,
            'picking_type_id': self.warehouse_id.out_type_id.id,
            'origin': self.name,
        })
        for line in lines:
            self.env['stock.move'].create({
                'name': line.name,
                'product_id': line.product_id.id,
                'product_uom_qty': line.product_uom_qty,
                'product_uom': line.product_uom.id,
                'picking_id': picking.id,
                'location_id': self.warehouse_id.lot_stock_id.id,
                'location_dest_id': self.partner_id.property_stock_customer.id,
            })
        return picking




class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    sale_order_limit = fields.Float(
        string="Sale Order Limit",
        config_parameter="sale.sale_order_limit"
    )

    @api.model
    def get_values(self):
        """Retrieve the current value from ir.config_parameter."""
        res = super(ResConfigSettings, self).get_values()
        sale_order_limit = float(self.env['ir.config_parameter'].sudo().get_param('sale_order_limit', default=0.0))
        res.update({'sale_order_limit': sale_order_limit})
        return res

    def set_values(self):
        """Save the value to ir.config_parameter."""
        super(ResConfigSettings, self).set_values()
        self.env['ir.config_parameter'].sudo().set_param('sale_order_limit', self.sale_order_limit)

