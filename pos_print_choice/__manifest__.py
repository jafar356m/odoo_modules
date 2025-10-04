# -*- coding: utf-8 -*-
{
    'name': 'POS Print Choice (Consolidate / Individual)',
    'summary': 'Popup on Validate to choose consolidated or individual printing of receipts in POS',
    'version': '13.0.1.0.0',
    'category': 'Point of Sale',
    'author': 'Your Company',
    'website': 'https://example.com',
    'license': 'LGPL-3',
    'depends': ['point_of_sale'],
    'data': [
        'views/assets.xml',
    ],
    'qweb': [
        'static/src/xml/print_choice.xml',
        'static/src/xml/print_choice_popup.xml',
        'static/src/xml/print_choice_per_product_popup.xml',
    ],
    'installable': True,
    'application': False,
}
