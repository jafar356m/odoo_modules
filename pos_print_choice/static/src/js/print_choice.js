odoo.define('pos_print_choice.print_choice', function (require) {
    "use strict";

    var core = require('web.core');
    var _t = core._t;

    var screens = require('point_of_sale.screens');
    var gui = require('point_of_sale.gui');
    var PopupWidget = require('point_of_sale.popups');
    var models = require('point_of_sale.models');
    var QWeb = core.qweb;

    /*
     * Extend Order to keep the selected print mode in the front-end storage
     */
    var OrderSuper = models.Order.prototype;
    models.Order = models.Order.extend({
        initialize: function () {
            OrderSuper.initialize.apply(this, arguments);
            this.print_mode = this.print_mode || null; // 'consolidate' | 'individual'
        },
        export_as_JSON: function () {
            var json = OrderSuper.export_as_JSON.apply(this, arguments);
            json.print_mode = this.print_mode || false;
            return json;
        },
        init_from_JSON: function (json) {
            OrderSuper.init_from_JSON.apply(this, arguments);
            this.print_mode = json.print_mode || null;
        },
    });

    /*
     * Custom larger, visual popup for choosing print mode
     */
    var PrintChoicePopup = PopupWidget.extend({
        template: 'PosPrintChoicePopup',
        show: function (options) {
            this._super(options);
            var self = this;
            this.$('.js-choice').off('click').on('click', function () {
                var mode = $(this).data('mode');
                self.gui.close_popup();
                if (self.options && self.options.confirm) {
                    self.options.confirm.call(self, mode);
                }
            });
        },
    });
    gui.define_popup({ name: 'pos_print_choice_popup', widget: PrintChoicePopup });

    /*
     * Ask user before validation how to print.
     */
    screens.PaymentScreenWidget.include({
        validate_order: function (force_validation) {
            var self = this;
            var order = this.pos.get_order();
            var _super_validate = this._super.bind(this);

            // First, ensure order is valid (this also shows default Odoo warnings)
            if (!this.order_is_valid(force_validation)) {
                return;
            }

            // Use custom visual popup
            this.gui.show_popup('pos_print_choice_popup', {
                title: _t('Choose print mode'),
                confirm: function (mode) {
                    order.print_mode = mode;
                    // Continue with normal validation flow
                    return _super_validate(force_validation);
                },
                cancel: function () {
                    // Do nothing, stay on the payment screen
                },
            });
        },
    });

    /*
     * Helper: build a receipt env using only provided orderlines
     */
    function buildReceiptEnvForLines(pos, order, lines, subHeaderText) {
        // Aggregate data similarly to Order.export_for_printing but limited to lines
        var receipt_lines = [];
        var subtotal_wo_tax = 0.0;
        var total_w_tax = 0.0;
        var tax_details = {};

        lines.forEach(function (lineInfo) {
            // lineInfo: {line: Orderline, qty: number}
            var line = lineInfo.line;
            var qty = lineInfo.qty;

            // Compute prices for this qty
            var price_unit = line.get_unit_price() * (1.0 - (line.get_discount() / 100.0));
            var taxes = line.get_applicable_taxes();
            var all = pos.compute_all(taxes, price_unit, qty, pos.currency.rounding);

            var exported = line.export_for_printing();
            // Override values to reflect the partial quantity
            var exported_line = _.extend({}, exported, {
                quantity: qty,
                price_with_tax: all.total_included,
                price_without_tax: all.total_excluded,
                price_display: (pos.config.iface_tax_included === 'total') ? all.total_included : all.total_excluded,
                price_display_one: (pos.config.iface_tax_included === 'total')
                    ? pos.compute_all(taxes, price_unit, 1.0, pos.currency.rounding).total_included
                    : pos.compute_all(taxes, price_unit, 1.0, pos.currency.rounding).total_excluded,
            });
            receipt_lines.push(exported_line);

            subtotal_wo_tax += all.total_excluded;
            total_w_tax += all.total_included;
            _.each(all.taxes, function (t) {
                tax_details[t.id] = (tax_details[t.id] || 0) + t.amount;
            });
        });

        // Payment lines for the sub-receipt: show a single line equal to this sub total
        var sub_total_paid = total_w_tax;
        var paymentlines = [{
            name: _t('Paid'),
            get_amount: function () { return sub_total_paid; },
        }];

        var receipt = {
            orderlines: receipt_lines,
            paymentlines: paymentlines,
            subtotal: subtotal_wo_tax,
            total_with_tax: total_w_tax,
            total_without_tax: subtotal_wo_tax,
            total_tax: total_w_tax - subtotal_wo_tax,
            total_paid: sub_total_paid,
            total_discount: 0, // not used in template in this path
            tax_details: _.map(_.pairs(tax_details), function (pair) { return { id: pair[0], amount: pair[1], name: pos.taxes_by_id[pair[0]] && pos.taxes_by_id[pair[0]].name || ''}; }),
            change: 0,
            name: order.get_name(),
            client: order.get_client() ? order.get_client().name : null,
            invoice_id: null,
            cashier: pos.get_cashier() ? pos.get_cashier().name : null,
            precision: {
                price: 2,
                money: 2,
                quantity: 3,
            },
            date: order.export_for_printing().date,
            company: order.export_for_printing().company,
            currency: pos.currency,
            header: pos.config.receipt_header || '',
            footer: pos.config.receipt_footer || '',
            sub_header: subHeaderText || '',
        };

        return {
            widget: pos.chrome, // widget reference like in default
            pos: pos,
            order: order,
            receipt: receipt,
            orderlines: receipt_lines,
            paymentlines: paymentlines,
        };
    }

    /*
     * Print multiple tickets according to order.print_mode
     */
    screens.ReceiptScreenWidget.include({
        show: function(){
            this._super.apply(this, arguments);
            var order = this.pos.get_order();
            if (order && order.print_mode){
                // Build a preview of all sub-receipts inside the receipt container
                var mode = order.print_mode;
                var envs = [];
                var self = this;

                if (mode === 'consolidate') {
                    var grouped = {};
                    order.get_orderlines().forEach(function (line) {
                        var pid = line.get_product().id;
                        grouped[pid] = grouped[pid] || [];
                        grouped[pid].push(line);
                    });
                    _.each(grouped, function (lines) {
                        var lineInfos = [];
                        lines.forEach(function (l) {
                            lineInfos.push({ line: l, qty: l.get_quantity() });
                        });
                        var pname = lines[0] && lines[0].get_product().display_name;
                        envs.push(buildReceiptEnvForLines(self.pos, order, lineInfos, _t('Consolidated: ') + (pname || '')));
                    });
                } else if (mode === 'individual') {
                    order.get_orderlines().forEach(function (line) {
                        var abs_qty = Math.abs(line.get_quantity());
                        var sign = line.get_quantity() >= 0 ? 1 : -1;
                        var int_qty = Math.floor(abs_qty);
                        var frac = abs_qty - int_qty;

                        for (var i = 0; i < int_qty; i++) {
                            var headerTxt = _t('Individual: ') + line.get_product().display_name + _t(' (1 unit)');
                            envs.push(buildReceiptEnvForLines(self.pos, order, [{ line: line, qty: 1 * sign }], headerTxt));
                        }
                        if (frac > 0.000001) {
                            var headerFrac = _t('Individual: ') + line.get_product().display_name + ' (' + frac + ' )';
                            envs.push(buildReceiptEnvForLines(self.pos, order, [{ line: line, qty: frac * sign }], headerFrac));
                        }
                    });
                }

                if (envs.length) {
                    var htmlCombined = '';
                    for (var j = 0; j < envs.length; j++) {
                        htmlCombined += QWeb.render('OrderReceipt', envs[j]);
                        if (j !== envs.length - 1) {
                            htmlCombined += '<div style="page-break-after: always;"></div>';
                        }
                    }
                    this.$('.pos-receipt-container').html(htmlCombined);
                }
            }
        },
        print: function () {
            var self = this;
            var order = this.pos.get_order();
            var mode = order && order.print_mode;

            if (!mode) {
                return this._super.apply(this, arguments);
            }

            // Collect all sub-receipt environments we want to print
            var envs = [];

            if (mode === 'consolidate') {
                // One ticket per product (all quantities of that product)
                var grouped = {};
                order.get_orderlines().forEach(function (line) {
                    var pid = line.get_product().id;
                    grouped[pid] = grouped[pid] || [];
                    grouped[pid].push(line);
                });

                _.each(grouped, function (lines) {
                    var lineInfos = [];
                    lines.forEach(function (l) {
                        lineInfos.push({ line: l, qty: l.get_quantity() });
                    });
                    var pname = lines[0] && lines[0].get_product().display_name;
                    envs.push(buildReceiptEnvForLines(self.pos, order, lineInfos, _t('Consolidated: ') + (pname || '')));
                });
            } else if (mode === 'individual') {
                // One ticket per unit of quantity (with a final fractional ticket if needed)
                order.get_orderlines().forEach(function (line) {
                    var abs_qty = Math.abs(line.get_quantity());
                    var sign = line.get_quantity() >= 0 ? 1 : -1;
                    var int_qty = Math.floor(abs_qty);
                    var frac = abs_qty - int_qty;

                    for (var i = 0; i < int_qty; i++) {
                        var headerTxt = _t('Individual: ') + line.get_product().display_name + _t(' (1 unit)');
                        envs.push(buildReceiptEnvForLines(self.pos, order, [{ line: line, qty: 1 * sign }], headerTxt));
                    }
                    if (frac > 0.000001) {
                        var headerFrac = _t('Individual: ') + line.get_product().display_name + ' (' + frac + ' )';
                        envs.push(buildReceiptEnvForLines(self.pos, order, [{ line: line, qty: frac * sign }], headerFrac));
                    }
                });
            }

            // If nothing to print, fallback
            if (!envs.length) {
                return this._super.apply(this, arguments);
            }

            if (!this.pos.proxy.printer) {
                // WEB PRINTING: render all sub-receipts into the container and call print once
                var htmlCombined = '';
                for (var j = 0; j < envs.length; j++) {
                    htmlCombined += QWeb.render('OrderReceipt', envs[j]);
                    if (j !== envs.length - 1) {
                        htmlCombined += '<div style="page-break-after: always;"></div>';
                    }
                }
                this.$('.pos-receipt-container').html(htmlCombined);
                this.print_web();
                order._printed = true;
                this.lock_screen(false);
                return;
            } else {
                // PROXY PRINTING: send each sub-receipt to the printer
                for (var k = 0; k < envs.length; k++) {
                    var receipt_html = QWeb.render('OrderReceipt', envs[k]);
                    this.pos.proxy.printer.print_receipt(receipt_html);
                }
                order._printed = true;
                this.lock_screen(false);
                return;
            }
        },
    });

});
