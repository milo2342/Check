# Titan Checkout — Stripe Discord Payment Bot

Railway-ready Node.js / discord.js + Stripe payment bot.

## Railway start

```bash
npm install
npm start
```

`npm start` runs `node index.js`.

## Environment variables

- `PAYMENT_BOT_TOKEN` — Discord bot token.
- `STRIPE_SECRET_KEY` — Stripe secret API key.
- `STRIPE_WEBHOOK_SECRET` — Stripe webhook signing secret.
- `STRIPE_SUCCESS_URL` — public success URL used by Stripe Checkout.
- `STRIPE_CANCEL_URL` — public cancel URL used by Stripe Checkout.
- `STRIPE_WEBHOOK_PORT` — optional port; Railway can provide `PORT` automatically.
- `BOT_OWNER_ID` — Discord user ID that can run owner-only payment management commands.

## Stripe Dashboard requirements

Set a valid public **Terms of Service URL** in Stripe Business/Public details. Checkout uses Stripe's own Terms of Service link when `consent_collection.terms_of_service` is required.

Stripe Tax is enabled in the Checkout Session. Stripe must have Stripe Tax activated/configured for the account. The bot does not create or invent tax rates.

Card Checkout requests 3D Secure using `request_three_d_secure=any`; the issuing bank/card network decides whether a challenge is required.

## Webhook events to enable

At minimum, configure the webhook endpoint for:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.expired`
- `payment_intent.payment_failed`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.updated`
- `charge.dispute.closed`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.deleted`

Webhook URL:

```text
https://YOUR-RAILWAY-DOMAIN/stripe/webhook
```

## Main commands

### Invoices

- `/invoice` — create an invoice with auto-generated invoice number, up to five line items, discount, note, email, quantity and optional customer DM.
- `/invoice-status` — status lookup.
- `/invoice-details` — full details.
- `/invoice-history` — customer's recent invoice history.
- `/invoice-resend` — create a fresh checkout and optionally DM it.
- `/invoice-cancel` — expire the active Checkout Session and void the invoice record.

### Payments

- `/payment-lookup`
- `/payment-history`
- `/balance`
- `/receipt`
- `/refund`
- `/remind`

### Subscriptions

- `/subscription` — weekly, monthly or yearly recurring Checkout.
- `/subscription-cancel` — cancel the Stripe subscription.

### Customers / records

- `/customer view`
- `/customer set`
- `/agreements`
- `/payment-log`

### General

- `/setup`
- `/features`

## Agreement flow

The Discord-side agreement modal records the customer's legal name and `I AGREE` confirmation. It states that the purchased item/service is delivered as soon as the payment is successfully confirmed, subject to the merchant's stated fulfilment terms.

Stripe Checkout separately requires the customer to actively accept the merchant's Terms of Service and displays the Dashboard-configured Terms URL.

## Payment status updates

The bot edits the original Discord payment message when Stripe reports a successful payment, refund, expiration or dispute. It can also send payment/dispute logs to a channel configured with `/payment-log`.

## Notes

Invoice numbers are generated automatically. Tax is handled by Stripe Tax. Customer DMs are optional on invoice/subscription/debt/pay-later creation.
