# Payment Bot

A Discord bot for sending invoices, subscriptions, debt notices, and pay-later agreements — all with signed no-chargeback agreements.

## Setup

1. Copy `.env.example` to `.env` and fill in your values.
2. `npm install`
3. `npm start`
4. Run `/setup paypal_link:paypal.me/yourname` in Discord to set your PayPal link.

## Commands

| Command | Description |
|---------|-------------|
| `/setup paypal_link` | Set your PayPal link (owner only) |
| `/invoice @user product amount [note]` | Send a payment invoice |
| `/subscription @user product amount interval [note]` | Create a recurring subscription |
| `/debt @user product amount due_date [note]` | Record an outstanding debt |
| `/paylater @user product total deposit due_date [note]` | Accept deposit + remainder later |
| `/agreements` | View all signed agreements (owner only) |

## Agreement Flow

Every payment embed includes a **Sign Agreement** button. The invoiced user clicks it, reads the agreement, enters their full legal name and types **I AGREE** to sign. The creator is notified by DM when signed. All signed agreements are saved to `data/payments.json`.

## Environment Variables

- `PAYMENT_BOT_TOKEN` — Your Discord bot token
- `BOT_OWNER_ID` — Your Discord user ID (for owner-only commands)
