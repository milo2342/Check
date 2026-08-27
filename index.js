import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} from "discord.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import http from "http";
import Stripe from "stripe";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const PAYMENTS_FILE = path.join(DATA_DIR, "payments.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

function ensureDataDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

function loadPayments() {
  try { ensureDataDir(); if (!fs.existsSync(PAYMENTS_FILE)) return []; return JSON.parse(fs.readFileSync(PAYMENTS_FILE, "utf-8")); }
  catch { return []; }
}
function savePayments(p) { ensureDataDir(); fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(p, null, 2), "utf-8"); }
function addPayment(p) { const all = loadPayments(); all.push(p); savePayments(all); }
function updatePayment(id, changes) {
  const all = loadPayments(); const idx = all.findIndex((p) => p.id === id);
  if (idx !== -1) { all[idx] = { ...all[idx], ...changes }; savePayments(all); }
}
function getPayment(id) { return loadPayments().find((p) => p.id === id); }

function loadConfig() {
  try { ensureDataDir(); if (!fs.existsSync(CONFIG_FILE)) return { ownerIds: [] }; return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")); }
  catch { return { ownerIds: [] }; }
}
function saveConfig(c) { ensureDataDir(); fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), "utf-8"); }

const token = process.env.PAYMENT_BOT_TOKEN;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const STRIPE_SUCCESS_URL = process.env.STRIPE_SUCCESS_URL ?? "https://discord.com/app";
const STRIPE_CANCEL_URL = process.env.STRIPE_CANCEL_URL ?? "https://discord.com/app";
const STRIPE_PORT = Number(process.env.STRIPE_WEBHOOK_PORT ?? process.env.PORT ?? 4242);
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
if (!token) { console.error("PAYMENT_BOT_TOKEN is not set."); process.exit(1); }
const BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "";
const isOwner = (id) => (BOT_OWNER_ID && id === BOT_OWNER_ID) || loadConfig().ownerIds.includes(id);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

const commands = [
  new SlashCommandBuilder().setName("setup").setDescription("Check the Stripe payment configuration (owner only).")
    .setDefaultMemberPermissions(0).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]).toJSON(),
  new SlashCommandBuilder().setName("invoice").setDescription("Send a payment invoice to a user.")
    .addUserOption((o) => o.setName("user").setDescription("The user to invoice.").setRequired(true))
    .addStringOption((o) => o.setName("product").setDescription("Product or service name.").setRequired(true))
    .addNumberOption((o) => o.setName("amount").setDescription("Amount in GBP.").setRequired(true).setMinValue(0.01))
    .addStringOption((o) => o.setName("note").setDescription("Optional note.").setRequired(false))
    .setIntegrationTypes([0, 1]).setContexts([0, 1, 2]).toJSON(),
  new SlashCommandBuilder().setName("subscription").setDescription("Create a recurring subscription invoice.")
    .addUserOption((o) => o.setName("user").setDescription("The subscriber.").setRequired(true))
    .addStringOption((o) => o.setName("product").setDescription("Subscription name.").setRequired(true))
    .addNumberOption((o) => o.setName("amount").setDescription("Amount per interval in GBP.").setRequired(true).setMinValue(0.01))
    .addStringOption((o) => o.setName("interval").setDescription("Billing interval.").setRequired(true)
      .addChoices({ name: "Weekly", value: "Weekly" }, { name: "Monthly", value: "Monthly" }, { name: "Yearly", value: "Yearly" }))
    .addStringOption((o) => o.setName("note").setDescription("Optional note.").setRequired(false))
    .setIntegrationTypes([0, 1]).setContexts([0, 1, 2]).toJSON(),
  new SlashCommandBuilder().setName("debt").setDescription("Record an outstanding debt for a user.")
    .addUserOption((o) => o.setName("user").setDescription("The user who owes.").setRequired(true))
    .addStringOption((o) => o.setName("product").setDescription("What the debt is for.").setRequired(true))
    .addNumberOption((o) => o.setName("amount").setDescription("Total amount owed in GBP.").setRequired(true).setMinValue(0.01))
    .addStringOption((o) => o.setName("due_date").setDescription("Due date (e.g. June 11, 2026).").setRequired(true))
    .addStringOption((o) => o.setName("note").setDescription("Optional note.").setRequired(false))
    .setIntegrationTypes([0, 1]).setContexts([0, 1, 2]).toJSON(),
  new SlashCommandBuilder().setName("paylater").setDescription("Accept a deposit now with the remainder due later.")
    .addUserOption((o) => o.setName("user").setDescription("The user paying.").setRequired(true))
    .addStringOption((o) => o.setName("product").setDescription("Product or service name.").setRequired(true))
    .addNumberOption((o) => o.setName("total").setDescription("Total price in GBP.").setRequired(true).setMinValue(0.01))
    .addNumberOption((o) => o.setName("deposit").setDescription("Deposit due now in GBP.").setRequired(true).setMinValue(0.01))
    .addStringOption((o) => o.setName("due_date").setDescription("Date remaining balance is due.").setRequired(true))
    .addStringOption((o) => o.setName("note").setDescription("Optional note.").setRequired(false))
    .setIntegrationTypes([0, 1]).setContexts([0, 1, 2]).toJSON(),
  new SlashCommandBuilder().setName("agreements").setDescription("View all signed agreements (owner only).")
    .setDefaultMemberPermissions(0).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]).toJSON(),
  new SlashCommandBuilder().setName("void").setDescription("Cancel/void any pending invoice (owner only).")
    .addStringOption((o) => o.setName("invoice_id").setDescription("The Invoice ID to void.").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Optional reason for voiding.").setRequired(false))
    .setDefaultMemberPermissions(0).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]).toJSON(),
  new SlashCommandBuilder().setName("status").setDescription("Check the status of an invoice by ID.")
    .addStringOption((o) => o.setName("invoice_id").setDescription("The Invoice ID to look up.").setRequired(true))
    .setIntegrationTypes([0, 1]).setContexts([0, 1, 2]).toJSON(),
  new SlashCommandBuilder().setName("history").setDescription("View all invoices for a specific user (owner only).")
    .addUserOption((o) => o.setName("user").setDescription("The user to look up.").setRequired(true))
    .setDefaultMemberPermissions(0).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]).toJSON(),
  new SlashCommandBuilder().setName("remind").setDescription("Send a payment reminder DM for a pending invoice (owner only).")
    .addStringOption((o) => o.setName("invoice_id").setDescription("The Invoice ID to remind about.").setRequired(true))
    .addStringOption((o) => o.setName("message").setDescription("Optional custom message.").setRequired(false))
    .setDefaultMemberPermissions(0).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]).toJSON(),
  new SlashCommandBuilder().setName("features").setDescription("View everything this payment bot can do.")
    .setIntegrationTypes([0, 1]).setContexts([0, 1, 2]).toJSON(),
];

client.once(Events.ClientReady, async (readyClient) => {
  const clientId = readyClient.user.id;
  console.log(`Payment Bot logged in as ${readyClient.user.tag} (ID: ${clientId})`);
  console.log(`\nAdd to Server: https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=67584&scope=bot%20applications.commands`);
  console.log(`Add to Apps:   https://discord.com/api/oauth2/authorize?client_id=${clientId}&integration_type=1&scope=applications.commands\n`);
  const rest = new REST({ version: "10" }).setToken(token);
  try { await rest.put(Routes.applicationCommands(clientId), { body: commands }); console.log("Slash commands registered."); }
  catch (err) { console.error("Failed to register commands:", err); }
  startStripeWebhookServer();
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
      return;
    }

    if (interaction.isButton()) {
      await handleButton(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      await handleModal(interaction);
      return;
    }
  } catch (err) {
    console.error(err);

    try {
      if (interaction.deferred) {
        await interaction.editReply({
          content: "❌ An unexpected error occurred."
        });
      } else if (interaction.replied) {
        await interaction.followUp({
          content: "❌ An unexpected error occurred.",
          ephemeral: true
        });
      } else {
        await interaction.reply({
          content: "❌ An unexpected error occurred.",
          ephemeral: true
        });
      }
    } catch {}
  }
});

async function handleCommand(interaction) {
  const { commandName, user } = interaction;
  const cfg = loadConfig();

  if (commandName === "setup") {
    if (!isOwner(user.id)) { await interaction.reply({ content: "Only the bot owner can run `/setup`.", ephemeral: true }); return; }
    const missing = [];
    if (!STRIPE_SECRET_KEY) missing.push("STRIPE_SECRET_KEY");
    if (!STRIPE_WEBHOOK_SECRET) missing.push("STRIPE_WEBHOOK_SECRET");
    await interaction.reply({
      content: missing.length ? `Stripe is not fully configured. Missing: ${missing.join(", ")}` : "Stripe is configured and ready for live Checkout payments.",
      ephemeral: true
    });
    return;
  }

  if (commandName === "agreements") {
    if (!isOwner(user.id)) { await interaction.reply({ content: "Only the bot owner can view agreements.", ephemeral: true }); return; }
    const all = loadPayments().filter((p) => p.status === "signed");
    if (all.length === 0) { await interaction.reply({ content: "No agreements signed yet.", ephemeral: true }); return; }
    const recent = all.slice(-10).reverse();
    const lines = recent.map((p) => {
      const ts = p.signedAt ? new Date(p.signedAt).toLocaleString("en-US", { timeZone: "UTC" }) : "?";
      return `**[${p.type.toUpperCase()}]** ${p.product} — £${p.amount.toFixed(2)}\n> Signed by **${p.signedName}** (${p.targetUserTag}) at ${ts} UTC`;
    });
    await interaction.reply({ content: `**Last ${recent.length} Signed Agreement(s):**\n\n${lines.join("\n\n")}`, ephemeral: true });
    return;
  }

  if (commandName === "invoice") {
    await interaction.deferReply();
    const target = interaction.options.getUser("user", true);
    const product = interaction.options.getString("product", true).trim();
    const amount = interaction.options.getNumber("amount", true);
    const note = interaction.options.getString("note")?.trim() ?? null;
    const id = randomUUID().slice(0, 8);
    const payment = { id, type: "invoice", createdBy: user.id, createdByTag: user.tag, targetUserId: target.id, targetUserTag: target.tag, product, amount, status: "pending", createdAt: new Date().toISOString(), note };
    const checkout = await createStripeCheckout(payment);
    payment.stripeCheckoutSessionId = checkout.id;
    payment.stripeUrl = checkout.url;
    addPayment(payment);
    const embed = buildPaymentEmbed(payment, "Custom Checkout Created");
    const sent = await interaction.editReply({ content: `${target}`, embeds: [embed], components: [buildPaymentButtons(id, checkout.url), buildSignButton(id)] });
    updatePayment(id, { discordChannelId: sent.channel.id, discordMessageId: sent.id });
    return;
  }

  if (commandName === "subscription") {
    await interaction.deferReply();
    const target = interaction.options.getUser("user", true);
    const product = interaction.options.getString("product", true).trim();
    const amount = interaction.options.getNumber("amount", true);
    const interval = interaction.options.getString("interval", true);
    const note = interaction.options.getString("note")?.trim() ?? null;
    const id = randomUUID().slice(0, 8);
    const payment = { id, type: "subscription", createdBy: user.id, createdByTag: user.tag, targetUserId: target.id, targetUserTag: target.tag, product, amount, interval, status: "pending", createdAt: new Date().toISOString(), note };
    const checkout = await createStripeCheckout(payment);
    payment.stripeCheckoutSessionId = checkout.id;
    payment.stripeUrl = checkout.url;
    addPayment(payment);
    const embed = buildPaymentEmbed(payment, "Subscription Checkout Created");
    const sent = await interaction.editReply({ content: `${target}`, embeds: [embed], components: [buildPaymentButtons(id, checkout.url), buildSignButton(id)] });
    updatePayment(id, { discordChannelId: sent.channel.id, discordMessageId: sent.id });
    return;
  }

  if (commandName === "debt") {
    await interaction.deferReply();
    const target = interaction.options.getUser("user", true);
    const product = interaction.options.getString("product", true).trim();
    const amount = interaction.options.getNumber("amount", true);
    const dueDate = interaction.options.getString("due_date", true).trim();
    const note = interaction.options.getString("note")?.trim() ?? null;
    const id = randomUUID().slice(0, 8);
    const payment = { id, type: "debt", createdBy: user.id, createdByTag: user.tag, targetUserId: target.id, targetUserTag: target.tag, product, amount, dueDate, status: "pending", createdAt: new Date().toISOString(), note };
    const checkout = await createStripeCheckout(payment);
    payment.stripeCheckoutSessionId = checkout.id;
    payment.stripeUrl = checkout.url;
    addPayment(payment);
    const embed = buildPaymentEmbed(payment, "Outstanding Debt Checkout");
    const sent = await interaction.editReply({ content: `${target}`, embeds: [embed], components: [buildPaymentButtons(id, checkout.url), buildSignButton(id)] });
    updatePayment(id, { discordChannelId: sent.channel.id, discordMessageId: sent.id });
    return;
  }

  if (commandName === "paylater") {
    await interaction.deferReply();
    const target = interaction.options.getUser("user", true);
    const product = interaction.options.getString("product", true).trim();
    const total = interaction.options.getNumber("total", true);
    const deposit = interaction.options.getNumber("deposit", true);
    const dueDate = interaction.options.getString("due_date", true).trim();
    const note = interaction.options.getString("note")?.trim() ?? null;
    if (deposit >= total) { await interaction.editReply({ content: "Deposit must be less than the total." }); return; }
    const remaining = parseFloat((total - deposit).toFixed(2));
    const id = randomUUID().slice(0, 8);
    const payment = { id, type: "paylater", createdBy: user.id, createdByTag: user.tag, targetUserId: target.id, targetUserTag: target.tag, product, amount: total, deposit, remaining, dueDate, status: "pending", createdAt: new Date().toISOString(), note };
    const checkout = await createStripeCheckout({ ...payment, checkoutAmount: deposit });
    payment.stripeCheckoutSessionId = checkout.id;
    payment.stripeUrl = checkout.url;
    addPayment(payment);
    const embed = buildPaymentEmbed(payment, "Pay Now / Pay Later");
    const sent = await interaction.editReply({ content: `${target}`, embeds: [embed], components: [buildPaymentButtons(id, checkout.url), buildSignButton(id)] });
    updatePayment(id, { discordChannelId: sent.channel.id, discordMessageId: sent.id });
    return;
  }

  if (commandName === "void") {
    if (!isOwner(user.id)) { await interaction.reply({ content: "Only the bot owner can void invoices.", ephemeral: true }); return; }
    const invoiceId = interaction.options.getString("invoice_id", true).trim();
    const reason = interaction.options.getString("reason")?.trim() ?? "No reason provided.";
    const payment = getPayment(invoiceId);
    if (!payment) { await interaction.reply({ content: `No invoice found with ID \`${invoiceId}\`.`, ephemeral: true }); return; }
    if (payment.status === "voided") { await interaction.reply({ content: `Invoice \`${invoiceId}\` is already voided.`, ephemeral: true }); return; }
    if (payment.status === "signed") { await interaction.reply({ content: `Invoice \`${invoiceId}\` has already been signed — it cannot be voided.`, ephemeral: true }); return; }
    updatePayment(invoiceId, { status: "voided" });
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle(" Invoice Voided").setColor(0x95a5a6)
        .addFields(
          { name: "Invoice ID", value: `\`${invoiceId}\``, inline: true },
          { name: "Product", value: payment.product, inline: true },
          { name: "Amount", value: `£${payment.amount.toFixed(2)}`, inline: true },
          { name: "Reason", value: reason, inline: false },
        ).setTimestamp()],
      ephemeral: true,
    });
    try {
      const target = await client.users.fetch(payment.targetUserId);
      await target.send(` **Invoice Voided**\nInvoice \`${invoiceId}\` for **${payment.product}** (£${payment.amount.toFixed(2)}) has been voided.\n**Reason:** ${reason}`);
    } catch { /* DMs may be closed */ }
    return;
  }

  if (commandName === "status") {
    const invoiceId = interaction.options.getString("invoice_id", true).trim();
    const payment = getPayment(invoiceId);
    if (!payment) { await interaction.reply({ content: `No invoice found with ID \`${invoiceId}\`.`, ephemeral: true }); return; }
    const statusEmoji = { pending: "", signed: "", paid: "", voided: "" };
    const statusColor = { pending: 0xfee75c, signed: 0x57f287, paid: 0x57f287, voided: 0x95a5a6 };
    const typeLabel = { invoice: " Invoice", subscription: " Subscription", debt: " Debt", paylater: " Pay Later" };
    const embed = new EmbedBuilder()
      .setTitle(`${typeLabel[payment.type] ?? payment.type} — Status`)
      .setColor(statusColor[payment.status] ?? 0x5865f2)
      .addFields(
        { name: "Invoice ID", value: `\`${invoiceId}\``, inline: true },
        { name: "Status", value: `${statusEmoji[payment.status] ?? "❓"} ${payment.status.toUpperCase()}`, inline: true },
        { name: "Product", value: payment.product, inline: true },
        { name: "Amount", value: `£${payment.amount.toFixed(2)}`, inline: true },
        { name: "Billed To", value: `<@${payment.targetUserId}>`, inline: true },
        { name: "Created", value: new Date(payment.createdAt).toLocaleString("en-US", { timeZone: "UTC" }) + " UTC", inline: false },
        ...(payment.status === "signed" && payment.signedName ? [{ name: "Signed By", value: `${payment.signedName} (${payment.targetUserTag})`, inline: true }, { name: "Signed At", value: new Date(payment.signedAt).toLocaleString("en-US", { timeZone: "UTC" }) + " UTC", inline: true }] : []),
      ).setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (commandName === "history") {
    if (!isOwner(user.id)) { await interaction.reply({ content: "Only the bot owner can view history.", ephemeral: true }); return; }
    const target = interaction.options.getUser("user", true);
    const all = loadPayments().filter((p) => p.targetUserId === target.id);
    if (all.length === 0) { await interaction.reply({ content: `No invoices found for ${target}.`, ephemeral: true }); return; }
    const statusEmoji = { pending: "⏳", signed: "✅", voided: "🚫" };
    const lines = all.slice(-15).reverse().map((p) =>
      `**[${p.type.toUpperCase()}]** \`${p.id}\` — ${p.product} — **£${p.amount.toFixed(2)}** ${statusEmoji[p.status] ?? ""} ${p.status}`
    );
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle(`📋 Invoice History — ${target.tag}`).setColor(0x5865f2)
        .setDescription(lines.join("\n")).setFooter({ text: `${all.length} total invoice(s)` }).setTimestamp()],
      ephemeral: true,
    });
    return;
  }

  if (commandName === "remind") {
    if (!isOwner(user.id)) { await interaction.reply({ content: "Only the bot owner can send reminders.", ephemeral: true }); return; }
    const invoiceId = interaction.options.getString("invoice_id", true).trim();
    const customMsg = interaction.options.getString("message")?.trim() ?? null;
    const payment = getPayment(invoiceId);
    if (!payment) { await interaction.reply({ content: `No invoice found with ID \`${invoiceId}\`.`, ephemeral: true }); return; }
    if (payment.status === "signed") { await interaction.reply({ content: `Invoice \`${invoiceId}\` is already signed.`, ephemeral: true }); return; }
    if (payment.status === "voided") { await interaction.reply({ content: `Invoice \`${invoiceId}\` is voided.`, ephemeral: true }); return; }
    try {
      const target = await client.users.fetch(payment.targetUserId);
      const amountDue = payment.type === "paylater" ? payment.remaining : payment.amount;
      const checkout = await createStripeCheckout({ ...payment, checkoutAmount: amountDue, reminder: true });
      const msg = `⏰ **Payment Reminder**\nYou have an outstanding balance for **${payment.product}** — **£${amountDue.toFixed(2)}**.\nInvoice ID: \`${invoiceId}\`\nStripe Checkout: ${checkout.url}${customMsg ? `\n\n${customMsg}` : ""}`;
      await target.send(msg);
      await interaction.reply({ content: `Reminder sent to **${target.tag}**.`, ephemeral: true });
    } catch {
      await interaction.reply({ content: `Could not DM <@${payment.targetUserId}> — they may have DMs disabled.`, ephemeral: true });
    }
    return;
  }

  if (commandName === "features") {
    const pages = buildFeaturesPages();
    const row = buildFeaturesNav(1, pages.length);
    await interaction.reply({ embeds: [pages[0]], components: [row] });
    return;
  }
}


function buildPaymentButtons(paymentId, checkoutUrl) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("Pay with Stripe").setStyle(ButtonStyle.Link).setURL(checkoutUrl),
  );
}

function buildPaymentEmbed(payment, title) {
  const amountForCheckout = payment.checkoutAmount ?? (payment.type === "paylater" ? payment.deposit : payment.amount);
  const fields = [
    { name: "Sales Agent", value: `<@${payment.createdBy}>`, inline: true },
    { name: payment.type === "subscription" ? "Subscriber" : "Customer", value: `<@${payment.targetUserId}>`, inline: true },
    { name: payment.type === "paylater" ? "Deposit Due Now" : "Amount Due", value: `**£${amountForCheckout.toFixed(2)}${payment.type === "subscription" ? ` / ${payment.interval}` : ""}**`, inline: true },
    { name: "Description", value: payment.product, inline: true },
  ];
  if (payment.type === "debt") fields.push({ name: "Due Date", value: `**${payment.dueDate}**`, inline: true });
  if (payment.type === "paylater") {
    fields.push({ name: "Remaining Balance", value: `**£${payment.remaining.toFixed(2)}**`, inline: true });
    fields.push({ name: "Balance Due Date", value: `**${payment.dueDate}**`, inline: true });
  }
  fields.push(
    { name: "Stripe Checkout", value: `[Pay securely with Stripe](${payment.stripeUrl})`, inline: false },
    ...(payment.note ? [{ name: "Note", value: payment.note, inline: false }] : []),
    { name: "Invoice ID", value: `\`${payment.id}\``, inline: true },
    { name: "Payment Status", value: payment.status.toUpperCase(), inline: true },
  );
  return new EmbedBuilder().setTitle(title).setColor(0x635bff).addFields(fields).setFooter({ text: `Checkout created by ${payment.createdByTag} | Stripe ID: ${payment.stripeCheckoutSessionId ?? "pending"} | Sign the agreement below before paying.` }).setTimestamp();
}

async function createStripeCheckout(payment) {
  if (!stripe) throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY in the environment.");
  const checkoutAmount = Number(payment.checkoutAmount ?? (payment.type === "paylater" ? payment.deposit : payment.amount));
  if (!Number.isFinite(checkoutAmount) || checkoutAmount <= 0) throw new Error("Invalid checkout amount.");

  const sessionConfig = {
    mode: payment.type === "subscription" ? "subscription" : "payment",
    success_url: `${STRIPE_SUCCESS_URL}?invoice_id=${encodeURIComponent(payment.id)}&status=success`,
    cancel_url: `${STRIPE_CANCEL_URL}?invoice_id=${encodeURIComponent(payment.id)}&status=cancelled`,
    client_reference_id: payment.id,
    metadata: {
      invoice_id: payment.id,
      invoice_type: payment.type,
      target_user_id: payment.targetUserId,
      product: payment.product,
    },
    line_items: [{
      quantity: 1,
      price_data: payment.type === "subscription"
        ? {
            currency: "gbp",
            unit_amount: Math.round(checkoutAmount * 100),
            product_data: { name: payment.product },
            recurring: { interval: payment.interval?.toLowerCase() === "weekly" ? "week" : payment.interval?.toLowerCase() === "yearly" ? "year" : "month" },
          }
        : {
            currency: "gbp",
            unit_amount: Math.round(checkoutAmount * 100),
            product_data: { name: payment.product },
          },
    }],
  };

  return await stripe.checkout.sessions.create(sessionConfig);
}

function startStripeWebhookServer() {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    console.warn("Stripe webhook server not started: configure STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.");
    return;
  }

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/stripe/webhook") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const rawBody = Buffer.concat(chunks);
        const signature = req.headers["stripe-signature"];
        const event = stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
        await handleStripeEvent(event);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true }));
      } catch (err) {
        console.error("Stripe webhook error:", err);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid webhook" }));
      }
    });
  });

  server.listen(STRIPE_PORT, "0.0.0.0", () => {
    console.log(`Stripe webhook server listening on 0.0.0.0:${STRIPE_PORT}`);
  });
}

async function handleStripeEvent(event) {
  if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) return;
  const session = event.data.object;
  const invoiceId = session.client_reference_id || session.metadata?.invoice_id;
  if (!invoiceId) return;
  const payment = getPayment(invoiceId);
  if (!payment) return;
  const isActuallyPaid = event.type === "checkout.session.async_payment_succeeded" || session.payment_status === "paid" || payment.type === "subscription";
  if (!isActuallyPaid || payment.status === "paid" || payment.status === "signed") return;

  const paidAt = new Date().toISOString();
  const newStatus = payment.type === "subscription" ? "paid" : "paid";
  updatePayment(invoiceId, {
    status: newStatus,
    paidAt,
    stripePaymentIntentId: session.payment_intent ?? null,
    stripeCustomerId: session.customer ?? null,
    stripeSubscriptionId: session.subscription ?? null,
  });

  const updated = getPayment(invoiceId);
  if (updated?.discordChannelId && updated?.discordMessageId) {
    const channel = await client.channels.fetch(updated.discordChannelId).catch(() => null);
    if (channel?.isTextBased()) {
      const message = await channel.messages.fetch(updated.discordMessageId).catch(() => null);
      if (message) {
        const embed = buildPaymentEmbed(updated, payment.type === "subscription" ? "Subscription Payment Received" : "Payment Received");
        const paidEmbed = EmbedBuilder.from(embed).setColor(0x57f287).setFooter({ text: `PAID via Stripe | Invoice ID: ${invoiceId}` });
        await message.edit({ embeds: [paidEmbed] }).catch(() => null);
      }
    }
  }

  try {
    const creator = await client.users.fetch(payment.createdBy);
    await creator.send(`Stripe payment received for invoice \`${invoiceId}\` — **£${(payment.checkoutAmount ?? (payment.type === "paylater" ? payment.deposit : payment.amount)).toFixed(2)}** for **${payment.product}**.`);
  } catch {}
}

function buildSignButton(paymentId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sign_${paymentId}`).setLabel("Sign Agreement").setStyle(ButtonStyle.Success).setEmoji("✍️")
  );
}

function buildFeaturesNav(page, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`features_prev_${page}`)
      .setLabel("◀ Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 1),

    new ButtonBuilder()
      .setCustomId(`features_page_${page}`)
      .setLabel(`Page ${page} / ${total}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),

    new ButtonBuilder()
      .setCustomId(`features_next_${page}`)
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === total),
  );
}

function buildFeaturesPages() {
  const D = "─────────────────────────────────";

  const p1 = new EmbedBuilder()
    .setTitle("Titan Development  ·  Services and what we can do")
    .setColor("#000000")
    .setImage("https://cdn.discordapp.com/attachments/1525015180134580318/1525593844597526600/Banner.png")
    .setDescription(
      `*Everything Titan Development Can offer — organized by category.*\n*Commands marked* \`owner\` *are restricted.*\n\n${D}\n**  Moderation**\n\`/ban\` · Ban with reason & purge\n\`/kick\` · Kick a member\n\`/mute\` · Timeout a member\n\`/unmute\` · Remove a timeout\n\`/warn\` · Formal warning + DM\n\`/purge\` · Bulk delete messages\n\`/ban-check\` · Check ban status\n\`/whois\` · Deep security lookup\n\`/global-ban\` · Ban across all servers  \`owner\`\n\`/global-unban\` · Unban across all servers  \`owner\`\n\n${D}\n**  Community**\n\`/giveaway\` · Timed giveaway + winners\n\`/poll\` · Multi-option polls with live results\n\`/announce\` · Formatted announcements + role ping\n\`/verification\` · Member verification system\n\`/invite\` · Server invite embed\n\`/suggestion\` · Suggestions + vote buttons\n\`/confession\` · Anonymous confessions\n\`/serverlog\` · Full audit log system\n\n${D}\n**  Server Management**\n\`/lock\` \`/unlock\` · Lock or unlock a channel\n\`/slowmode\` · Set channel slowmode\n\`/nick\` · Change a member's nickname\n\`/embed\` · Create & send custom embeds\n\`/steal-emoji\` · Add emoji from URL or other servers\n\`/create-roles\` · Bulk create roles\n\`/create-channels\` · Bulk create channels\n\`/add-role\` · Assign a role\n\`/mass-move-roles\` · Move members between roles\n\`/move-channels\` · Reorganise channels\n\`/dev-setup\` · One-command full server setup\n\`/announcement-rebrand\` · Rebrand announcements\n\`/say\` · Send a message as the bot\n\n${D}\n** Info & Utilities**\n\`/ping\` · Bot latency check\n\`/server-info\` · Detailed server stats\n\`/role-info\` · Role breakdown & permissions\n\`/avatar\` · Full-size avatar\n\`/userinfo\` · Profile breakdown\n\`/developer\` · Developer info\n\`/features\` · This menu  \`owner\``
    )
    .setFooter({ text: "Page 1 / 4  ·  Titan Development" });

  const p2 = new EmbedBuilder()
    .setTitle("Titan Development  ·  FiveM RP Commands")
    .setColor("#000000")
    .setImage("https://cdn.discordapp.com/attachments/1525015180134580318/1525593844597526600/Banner.png")
    .setDescription(
      "*All FiveM commands include interactive buttons —*\n" +
      "*staff can claim, respond & resolve right from Discord.*\n\n" +
      `${D}\n` +
      "**  Staff & Administration**\n" +
      "`/rules` · Post server rules\n" +
      "`/warn` · Warning → Acknowledged\n" +
      "`/report` · Report → Claim ╱ Resolve ╱ Dismiss\n" +
      "`/loa` · Leave of Absence → Approve ╱ Deny\n" +
      "`/staff-duty` · Duty toggle → On ╱ Off\n" +
      "`/whitelist` · Requirements & apply info\n\n" +
      `${D}\n` +
      "**  Roster Management**\n" +
      "`/onboard` · Add member to Employee DB & Roster\n" +
      "`/move` · Promote or demote — swaps roster slot\n" +
      "`/mark-loa` · Mark member as LOA\n" +
      "`/mark-off-loa` · Return member from LOA → Active\n" +
      "`/update-status` · Set status (Active, Suspended, LOA…)\n" +
      "`/terminate` · Terminate — keeps in DB, removes from Roster\n" +
      "`/resign` · Resignation — keeps in DB, removes from Roster\n" +
      "`/strike` · Toggle a strike on a member\n" +
      "`/roster-note` · Add a note to Employee DB\n" +
      "`/set-permission` · Manage which roles can use roster commands\n\n" +
      `${D}\n` +
      "**  Emergency & Dispatch**\n" +
      "`/dispatch` · Dispatch call → Responding ╱ Code 4\n" +
      "`/911` · Emergency → Responding ╱ Clear\n" +
      "`/wanted` · Wanted notice → Detained ╱ Cleared\n" +
      "`/suggestion` · Suggestion → Approve ╱ Deny\n\n" +
      `${D}\n` +
      "**  Possible Additions**\n" +
      "`mdt` · Mobile Data Terminal\n" +
      "`blotter` · Police blotter log\n" +
      "`fine` · RP fines\n" +
      "`duty-roster` · Live on-duty list\n" +
      "`incident` · Incident reports\n" +
      "`application` · Role applications"
    )
    .setFooter({ text: "Page 2 / 4  · Titan Development" });

  const p3 = new EmbedBuilder()
    .setTitle("Titan Development  ·  Troll & Future Commands")
    .setColor("#000000")
    .setImage("https://cdn.discordapp.com/attachments/1525015180134580318/1525593844597526600/Banner.png")
    .setDescription(
      "*Troll commands are exclusive to your server only.*\n" +
      "*Future commands can be built on request.*\n\n" +
      `${D}\n` +
      "**  Troll Commands**\n" +
      "`/roast` · Personal roasts\n" +
      "`/ship` · Compatibility scores\n" +
      "`/8ball` · Brutally honest 8-ball\n" +
      "`/rizz` · Rizz assessment\n" +
      "`/vibe-check` · Vibe analysis\n" +
      "`/wyr` · Dark Would You Rather\n" +
      "`/sus` · Sus-O-Meter\n" +
      "`/sentence` · Put someone on trial\n" +
      "`/truth-or-dare` · No soft options\n" +
      "`/rps` · RPS + savage commentary\n" +
      "`/how-gay` · Gay-O-Meter (joke)\n" +
      "`/ratio` · Live ratio attempt\n" +
      "`/confession` · Anonymous confessions\n\n" +
      `${D}\n` +
      "**  Could Be Built Next**\n" +
      "`ticket` · Ticket system + transcripts\n" +
      "`welcome` · Custom welcome messages\n" +
      "`autorole` · Auto-assign on join\n" +
      "`reminder` · Timed reminders\n" +
      "`rank` · XP & leveling\n" +
      "`economy` · Full economy system\n" +
      "`birthday` · Birthday tracking\n" +
      "`starboard` · Pin popular messages\n" +
      "`infractions` · Mod history per member\n" +
      "`afk` · AFK status tracking"
    )
    .setFooter({ text: "Page 3 / 4  ·  Titan Development" });

  const p4 = new EmbedBuilder()
    .setTitle("Titan Development  ·  Pricing")
    .setColor("#000000")
    .setImage("https://cdn.discordapp.com/attachments/1525015180134580318/1525593844597526600/Banner.png")
    .setDescription(
      "*Everything Teo can build — all prices in GBP.*\n" +
      "*Bundle for the best value.*\n\n" +
      "── Services ──────────────────────────\n" +
      "  **Custom Discord Bot** · · · · · **£15**\n" +
      "　　Setup & hosting, commands separate\n\n" +
      "  **Ticket System** · · · · · · · · **£10**\n" +
      "　　Threads, transcripts & controls\n\n" +
      "  **Verification** · · · · · · · · · **£10**\n" +
      "　　Buttons, modals & auto-roles\n\n" +
      " **Roster & Staff** · · · · · · · **£25**\n" +
      "　　Roster mgmt, logs & automation\n\n" +
      "  **Leaderboards** · · · · · · · · **£10**\n" +
      "　　Activity or custom rankings\n\n" +
      "── More Services ─────────────────────\n" +
      "  **Economy System** · · · · · · · **£30**\n" +
      "　　Banking, jobs, shops & taxes\n\n" +
      "  **Website / Store** · · · · · · **£50**\n" +
      "　　Designed, built & hosted\n\n" +
      " **Notifications** · · · · · · · **£10**\n" +
      "　　Event-driven auto-alerts\n\n" +
      "  **UI Frameworks** · · · · · · · **£15**\n" +
      " **Dashboards & component libs\n\n" +
      "  **Custom Commands** · · · · **$5–£15 ea**\n" +
      "　　Simple $5 · Complex $15\n\n" +
      "─────────────────────────────────────\n" +
      "  **ALL FEATURES BUNDLE  ·  £145**\n" +
      "　　*Save $30 — everything above in one package.*"
    )
    .setFooter({ text: "Page 4 / 4  ·  Titan Development" });

  return [p1, p2, p3, p4];
}

async function handleButton(interaction) {
  if (
  interaction.customId.startsWith("features_prev_") ||
  interaction.customId.startsWith("features_next_")
) {
  const pages = buildFeaturesPages();

  let page;

  if (interaction.customId.startsWith("features_prev_")) {
    page = parseInt(
      interaction.customId.replace("features_prev_", "")
    ) - 1;
  } else {
    page = parseInt(
      interaction.customId.replace("features_next_", "")
    ) + 1;
  }

  if (page < 1) page = 1;
  if (page > pages.length) page = pages.length;

  await interaction.update({
    embeds: [pages[page - 1]],
    components: [buildFeaturesNav(page, pages.length)],
  });

  return;
}

  if (!interaction.customId.startsWith("sign_")) return;
  const paymentId = interaction.customId.slice(5);
  const payment = getPayment(paymentId);
  if (!payment) { await interaction.reply({ content: "This invoice could not be found.", ephemeral: true }); return; }
  if (payment.status === "signed") { await interaction.reply({ content: "This agreement has already been signed.", ephemeral: true }); return; }
  if (interaction.user.id !== payment.targetUserId) { await interaction.reply({ content: "Only the invoiced user can sign this agreement.", ephemeral: true }); return; }

  const modal = new ModalBuilder().setCustomId(`modal_sign_${paymentId}`).setTitle("Sign Payment Agreement");
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("agreement_preview").setLabel("Agreement (read carefully)")
        .setStyle(TextInputStyle.Paragraph).setValue(buildAgreementText(payment)).setRequired(false)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("legal_name").setLabel("Your Full Legal Name")
        .setStyle(TextInputStyle.Short).setPlaceholder("e.g. John Smith").setRequired(true).setMaxLength(100)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("confirmation").setLabel("Type  I AGREE  to sign")
        .setStyle(TextInputStyle.Short).setPlaceholder("I AGREE").setRequired(true).setMaxLength(10)
    ),
  );
  await interaction.showModal(modal);
}

async function handleModal(interaction) {
  if (!interaction.customId.startsWith("modal_sign_")) return;
  const paymentId = interaction.customId.slice(11);
  const payment = getPayment(paymentId);
  if (!payment) { await interaction.reply({ content: "Invoice not found.", ephemeral: true }); return; }
  if (payment.status === "signed") { await interaction.reply({ content: "Already signed.", ephemeral: true }); return; }

  const legalName = interaction.fields.getTextInputValue("legal_name").trim();
  const confirmation = interaction.fields.getTextInputValue("confirmation").trim().toUpperCase();
  if (confirmation !== "I AGREE") {
    await interaction.reply({ content: `You must type **I AGREE** exactly. You typed: \`${interaction.fields.getTextInputValue("confirmation").trim()}\``, ephemeral: true });
    return;
  }

  const signedAt = new Date().toISOString();
  updatePayment(paymentId, { status: "signed", signedName: legalName, signedAt });
  const ts = new Date(signedAt).toLocaleString("en-US", { timeZone: "UTC" });

  const confirmEmbed = new EmbedBuilder().setTitle("✅ Agreement Signed").setColor(0x57f287)
    .addFields(
      { name: "Signed By", value: `${legalName} (${interaction.user.tag})`, inline: true },
      { name: "Product", value: payment.product, inline: true },
      { name: "Amount", value: `£${payment.amount.toFixed(2)}`, inline: true },
      { name: "Signed At", value: `${ts} UTC`, inline: false },
      { name: "Invoice ID", value: `\`${paymentId}\``, inline: true },
    ).setFooter({ text: "Please complete your payment via Stripe Checkout." }).setTimestamp();

  await interaction.reply({ embeds: [confirmEmbed], ephemeral: true });

  try {
    const creator = await client.users.fetch(payment.createdBy);
    await creator.send(
      ` # Agreement Signed\n**Invoice ID:** \`${paymentId}\`\n**Product:** ${payment.product}\n` +
      `**Amount:** £${payment.amount.toFixed(2)}\n**Signed by:** ${legalName} (${interaction.user.tag})\n**Signed at:** ${ts} UTC`
    );
  } catch { /* DMs may be closed */ }
}

function buildAgreementText(p) {
  switch (p.type) {
    case "invoice":
      return `PAYMENT AGREEMENT\n\nI agree to pay £${p.amount.toFixed(2)} for "${p.product}" via Stripe Checkout.\n\nI understand and agree that:\n• Payment is due immediately upon signing.\n• I waive all rights to initiate a chargeback or dispute.\n• Initiating a chargeback will be considered fraud and may result in legal action.\n\nThis agreement is binding upon signature.`;
    case "subscription":
      return `SUBSCRIPTION AGREEMENT\n\nI agree to pay £${p.amount.toFixed(2)} ${p.interval?.toLowerCase()} for "${p.product}" via Stripe Checkout.\n\nI understand and agree that:\n• Payments recur ${p.interval?.toLowerCase()} until cancelled.\n• I will not initiate chargebacks or disputes.\n• Cancellations must be communicated in advance.\n\nThis agreement is binding upon signature.`;
    case "debt":
      return `DEBT ACKNOWLEDGEMENT\n\nI acknowledge that I owe £${p.amount.toFixed(2)} for "${p.product}".\n\nI agree that:\n• The full amount is due by ${p.dueDate}.\n• Payment will be made via Stripe Checkout.\n• Failure to pay by the due date may result in further action.\n\nThis acknowledgement is binding upon signature.`;
    case "paylater":
      return `PAY NOW / PAY LATER AGREEMENT\n\nI agree to pay for "${p.product}" (Total: £${p.amount.toFixed(2)}) as follows:\n\n• Deposit due now: £${p.deposit?.toFixed(2)}\n• Remaining balance: £${p.remaining?.toFixed(2)}\n• Remaining balance due by: ${p.dueDate}\n\nI agree that:\n• The deposit is non-refundable.\n• I will pay the remaining balance by the due date.\n• No chargebacks will be initiated.\n\nThis agreement is binding upon signature.`;
  }
}

client.on(Events.Error, (err) => {
  console.error("[Discord Error]", err.message);
});

process.on("unhandledRejection", (err) => {
  console.error("[Unhandled Rejection]", err);
});

client.login(token);
