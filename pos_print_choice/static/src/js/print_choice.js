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
            this.print_mode = this.print_mode || null; // legacy: 'consolidate' | 'individual'
            this.print_mode_map = this.print_mode_map || {}; // per-product map: {product_id: 'consolidate'|'individual'}
        },
        export_as_JSON: function () {
            var json = OrderSuper.export_as_JSON.apply(this, arguments);
            json.print_mode = this.print_mode || false;
            json.print_mode_map = this.print_mode_map || {};
            return json;
        },
        init_from_JSON: function (json) {
            OrderSuper.init_from_JSON.apply(this, arguments);
            this.print_mode = json.print_mode || null;
            this.print_mode_map = json.print_mode_map || {};
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
     * Build consolidated and individual env lists based on per-product map or legacy mode
     */
    function buildEnvSets(pos, order) {
        var mode = order && order.print_mode; // legacy
        var mode_map = order && order.print_mode_map || {};
        var consolidated = [];
        var individual = [];

        function pushConsolidated(lines) {
            var infos = [];
            lines.forEach(function (l) { infos.push({ line: l, qty: l.get_quantity() }); });
            var pname = lines[0] && lines[0].get_product().display_name;
            consolidated.push(buildReceiptEnvForLines(pos, order, infos, _t('Consolidated: ') + (pname || '')));
        }
        function pushIndividual(line) {
            var abs_qty = Math.abs(line.get_quantity());
            var sign = line.get_quantity() >= 0 ? 1 : -1;
            var int_qty = Math.floor(abs_qty);
            var frac = abs_qty - int_qty;
            for (var i = 0; i < int_qty; i++) {
                var hdr = _t('Individual: ') + line.get_product().display_name + _t(' (1 unit)');
                individual.push(buildReceiptEnvForLines(pos, order, [{ line: line, qty: 1 * sign }], hdr));
            }
            if (frac > 0.000001) {
                var hdrf = _t('Individual: ') + line.get_product().display_name + ' (' + frac + ' )';
                individual.push(buildReceiptEnvForLines(pos, order, [{ line: line, qty: frac * sign }], hdrf));
            }
        }

        if (mode === 'consolidate') {
            var grouped = {};
            order.get_orderlines().forEach(function (line) {
                var pid = line.get_product().id;
                grouped[pid] = grouped[pid] || [];
                grouped[pid].push(line);
            });
            _.each(grouped, function (lines) { pushConsolidated(lines); });
        } else if (mode === 'individual') {
            order.get_orderlines().forEach(function (line) { pushIndividual(line); });
        } else if (!_.isEmpty(mode_map)) {
            var grouped2 = {};
            order.get_orderlines().forEach(function (line) {
                var pid = line.get_product().id;
                grouped2[pid] = grouped2[pid] || [];
                grouped2[pid].push(line);
            });
            _.each(grouped2, function (lines, pid) {
                var choice = mode_map[pid] || 'consolidate';
                if (choice === 'consolidate') {
                    pushConsolidated(lines);
                } else {
                    lines.forEach(function (l) { pushIndividual(l); });
                }
            });
        }

        return { consolidated: consolidated, individual: individual };
    }

    /*
     * Per-product choice popup: list products and let user choose mode per product
     */
    var PrintChoicePerProductPopup = PopupWidget.extend({
        template: 'PosPrintChoicePerProductPopup',
        show: function (options) {
            options = options || {};
            this._super(options);
            var self = this;
            // Preselect defaults
            _.each(this.options.items || [], function (it) {
                var def = (self.options.defaults && self.options.defaults[it.product_id]) || 'consolidate';
                self.$('input[name="choice-' + it.product_id + '"][value="' + def + '"]').prop('checked', true);
            });
            this.$('.button.confirm').off('click').on('click', function(){
                var selections = {};
                _.each(self.options.items || [], function (it) {
                    var val = self.$('input[name="choice-' + it.product_id + '"]:checked').val() || 'consolidate';
                    selections[it.product_id] = val;
                });
                self.gui.close_popup();
                if (self.options && self.options.confirm) {
                    self.options.confirm.call(self, selections);
                }
            });
        },
    });
    gui.define_popup({ name: 'pos_print_choice_per_product_popup', widget: PrintChoicePerProductPopup });

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

            // Build item list aggregated by product for per-product choice
            var byProduct = {};
            order.get_orderlines().forEach(function (line) {
                var pid = line.get_product().id;
                if (!byProduct[pid]) {
                    byProduct[pid] = { product_id: pid, name: line.get_product().display_name, qty: 0 };
                }
                byProduct[pid].qty += line.get_quantity();
            });
            var items = _.values(byProduct);

            // Show per-product popup
            this.gui.show_popup('pos_print_choice_per_product_popup', {
                title: _t('Choose print mode per product'),
                items: items,
                defaults: order.print_mode_map || {},
                confirm: function (selections) {
                    // store map and clear single-mode
                    order.print_mode_map = selections || {};
                    order.print_mode = null;
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
            if (order && (order.print_mode || (order.print_mode_map && !_.isEmpty(order.print_mode_map)))){
                var sets = buildEnvSets(this.pos, order);
                var envs = sets.consolidated.concat(sets.individual);

                var htmlCombined = '';
                for (var j = 0; j < envs.length; j++) {
                    htmlCombined += '<div class="ppc-card" margin-bottom:8px;">';
                    htmlCombined += QWeb.render('OrderReceipt', envs[j]);
                    htmlCombined += '</div>';
                }
                this.$('.pos-receipt-container').html(htmlCombined);
            }
        },
        print: function () {
            var self = this;
            var order = this.pos.get_order();
            var mode = order && order.print_mode; // legacy
            var mode_map = order && order.print_mode_map;

            if (!mode && (!mode_map || _.isEmpty(mode_map))) {
                return this._super.apply(this, arguments);
            }

            // Build env sets and always print all (both consolidated and individual based on selections)
            var sets = buildEnvSets(this.pos, order);
            var envs = sets.consolidated.concat(sets.individual);

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
