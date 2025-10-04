{
    'name': 'Payment Allocation',
    'summary': 'Manual allocation of payments to multiple invoices/bills from the payment screen',
    'version': '17.0.1.0.0',
    'author': 'Your Company',
    'website': 'https://example.com',
    'category': 'Accounting',
    'license': 'LGPL-3',
    'depends': ['account'],
    'data': [
        'security/ir.model.access.csv',
        'views/account_payment_views.xml',
    ],
    'installable': True,
    'application': False,
}
