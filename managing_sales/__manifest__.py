{
    'name': 'Sale Admin Customization',
    'version': '1.0',
    'summary': 'Adds Sale Admin user role with exclusive access to edit Manager Reference field in Sale Orders',
    'description': """
        This module introduces:
        - A new user group, Sale Admin, specifically for managing sales.
        - A new field, Manager Reference, on sale orders.
        - Only Sale Admins can edit the Manager Reference field, while other users can view it.
    """,
    'author': 'Your Name',
    'website': 'https://yourwebsite.com',
    'category': 'Sales',
    'depends': ['sale','sale_management','base', 'stock', 'account'],
    'data': [
        'security/security.xml',
        'security/ir.model.access.csv',
        'views/sale_order_inherit_view.xml',
        'views/res_config_settings_views.xml',

    ],
    'installable': True,
    'application': False,
    'license': 'LGPL-3',
}
