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
  try { ensureDataDir(); if (!fs.existsSync(CONFIG_FILE)) return { paypalLink: "", ownerIds: [] }; return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")); }
  catch { return { paypalLink: "", ownerIds: [] }; }
}
function saveConfig(c) { ensureDataDir(); fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), "utf-8"); }

const token = process.env.PAYMENT_BOT_TOKEN;
if (!token) { console.error("PAYMENT_BOT_TOKEN is not set."); process.exit(1); }
const BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "";
const isOwner = (id) => (BOT_OWNER_ID && id === BOT_OWNER_ID) || loadConfig().ownerIds.includes(id);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

const commands = [
  new SlashCommandBuilder().setName("setup").setDescription("Set your PayPal link (owner only).")
    .addStringOption((o) => o.setName("paypal_link").setDescription("Your PayPal.me link or email.").setRequired(true))
    .setDefaultMemberPermissions(0).setIntegrationTypes([0, 1]).setContexts([0, 1, 2]).toJSON(),
  new SlashCommandBuilder().setName("invoice").setDescription("Send a payment invoice to a user.")
    .addUserOption((o) => o.setName("user").setDescription("The user to invoice.").setRequired(true))
    .addStringOption((o) => o.setName("product").setDescription("Product or service name.").setRequired(true))
    .addNumberOption((o) => o.setName("amount").setDescription("Amount in USD.").setRequired(true).setMinValue(0.01))
    .addStringOption((o) => o.setName("note").setDescription("Optional note.").setRequired(false))
    .setIntegrationTypes([0, 1]).setContexts([0, 1, 2]).toJSON(),
  new SlashCommandBuilder().setName("subscription").setDescription("Create a recurring subscription invoice.")
    .addUserOption((o) => o.setName("user").setDescription("The subscriber.").setRequired(true))
    .addStringOption((o) => o.setName("product").setDescription("Subscription name.").setRequired(true))
    .addNumberOption((o) => o.setName("amount").setDescription("Amount per interval in USD.").setRequired(true).setMinValue(0.01))
    .addStringOption((o) => o.setName("interval").setDescription("Billing interval.").setRequired(true)
      .addChoices({ name: "Weekly", value: "Weekly" }, { name: "Monthly", value: "Monthly" }, { name: "Yearly", value: "Yearly" }))
    .addStringOption((o) => o.setName("note").setDescription("Optional note.").setRequired(false))
    .setIntegrationTypes([0, 1]).setContexts([0, 1, 2]).toJSON(),
  new SlashCommandBuilder().setName("debt").setDescription("Record an outstanding debt for a user.")
    .addUserOption((o) => o.setName("user").setDescription("The user who owes.").setRequired(true))
    .addStringOption((o) => o.setName("product").setDescription("What the debt is for.").setRequired(true))
    .addNumberOption((o) => o.setName("amount").setDescription("Total amount owed in USD.").setRequired(true).setMinValue(0.01))
    .addStringOption((o) => o.setName("due_date").setDescription("Due date (e.g. June 11, 2026).").setRequired(true))
    .addStringOption((o) => o.setName("note").setDescription("Optional note.").setRequired(false))
    .setIntegrationTypes([0, 1]).setContexts([0, 1, 2]).toJSON(),
  new SlashCommandBuilder().setName("paylater").setDescription("Accept a deposit now with the remainder due later.")
    .addUserOption((o) => o.setName("user").setDescription("The user paying.").setRequired(true))
    .addStringOption((o) => o.setName("product").setDescription("Product or service name.").setRequired(true))
    .addNumberOption((o) => o.setName("total").setDescription("Total price in USD.").setRequired(true).setMinValue(0.01))
    .addNumberOption((o) => o.setName("deposit").setDescription("Deposit due now in USD.").setRequired(true).setMinValue(0.01))
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
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) { await handleCommand(interaction); return; }
  if (interaction.isButton()) { await handleButton(interaction); return; }
  if (interaction.isModalSubmit()) { await handleModal(interaction); }
});

async function handleCommand(interaction) {
  const { commandName, user } = interaction;
  const cfg = loadConfig();
  const paypalLink = cfg.paypalLink || "Not configured — run /setup first.";

  if (commandName === "setup") {
    if (!isOwner(user.id)) { await interaction.reply({ content: "Only the bot owner can run `/setup`.", ephemeral: true }); return; }
    const link = interaction.options.getString("paypal_link", true).trim();
    saveConfig({ ...cfg, paypalLink: link });
    await interaction.reply({ content: `✅ PayPal link set to: **${link}**`, ephemeral: true });
    return;
  }

  if (commandName === "agreements") {
    if (!isOwner(user.id)) { await interaction.reply({ content: "Only the bot owner can view agreements.", ephemeral: true }); return; }
    const all = loadPayments().filter((p) => p.status === "signed");
    if (all.length === 0) { await interaction.reply({ content: "No agreements signed yet.", ephemeral: true }); return; }
    const recent = all.slice(-10).reverse();
    const lines = recent.map((p) => {
      const ts = p.signedAt ? new Date(p.signedAt).toLocaleString("en-US", { timeZone: "UTC" }) : "?";
      return `**[${p.type.toUpperCase()}]** ${p.product} — $${p.amount.toFixed(2)}\n> Signed by **${p.signedName}** (${p.targetUserTag}) at ${ts} UTC`;
    });
    await interaction.reply({ content: `**Last ${recent.length} Signed Agreement(s):**\n\n${lines.join("\n\n")}`, ephemeral: true });
    return;
  }

  if (commandName === "invoice") {
    const target = interaction.options.getUser("user", true);
    const product = interaction.options.getString("product", true).trim();
    const amount = interaction.options.getNumber("amount", true);
    const note = interaction.options.getString("note")?.trim() ?? null;
    const id = randomUUID().slice(0, 8);
    addPayment({ id, type: "invoice", createdBy: user.id, createdByTag: user.tag, targetUserId: target.id, targetUserTag: target.tag, product, amount, paypalLink, status: "pending", createdAt: new Date().toISOString() });
    const embed = new EmbedBuilder().setTitle("🧾 Payment Invoice").setColor(0x57f287)
      .addFields(
        { name: "Product / Service", value: product, inline: true },
        { name: "Amount Due", value: `**$${amount.toFixed(2)}**`, inline: true },
        { name: "Billed To", value: `${target}`, inline: true },
        { name: "PayPal", value: paypalLink, inline: false },
        ...(note ? [{ name: "Note", value: note, inline: false }] : []),
        { name: "Invoice ID", value: `\`${id}\``, inline: true },
      ).setFooter({ text: "Sign the no-chargeback agreement below before paying." }).setTimestamp();
    await interaction.reply({ content: `${target}`, embeds: [embed], components: [buildSignButton(id)] });
    return;
  }

  if (commandName === "subscription") {
    const target = interaction.options.getUser("user", true);
    const product = interaction.options.getString("product", true).trim();
    const amount = interaction.options.getNumber("amount", true);
    const interval = interaction.options.getString("interval", true);
    const note = interaction.options.getString("note")?.trim() ?? null;
    const id = randomUUID().slice(0, 8);
    addPayment({ id, type: "subscription", createdBy: user.id, createdByTag: user.tag, targetUserId: target.id, targetUserTag: target.tag, product, amount, paypalLink, interval, status: "pending", createdAt: new Date().toISOString() });
    const embed = new EmbedBuilder().setTitle("🔄 Subscription Invoice").setColor(0x9b59b6)
      .addFields(
        { name: "Plan", value: product, inline: true },
        { name: "Amount", value: `**$${amount.toFixed(2)} / ${interval}**`, inline: true },
        { name: "Subscriber", value: `${target}`, inline: true },
        { name: "PayPal", value: paypalLink, inline: false },
        ...(note ? [{ name: "Note", value: note, inline: false }] : []),
        { name: "Invoice ID", value: `\`${id}\``, inline: true },
      ).setFooter({ text: "Sign the agreement below to confirm your subscription." }).setTimestamp();
    await interaction.reply({ content: `${target}`, embeds: [embed], components: [buildSignButton(id)] });
    return;
  }

  if (commandName === "debt") {
    const target = interaction.options.getUser("user", true);
    const product = interaction.options.getString("product", true).trim();
    const amount = interaction.options.getNumber("amount", true);
    const dueDate = interaction.options.getString("due_date", true).trim();
    const note = interaction.options.getString("note")?.trim() ?? null;
    const id = randomUUID().slice(0, 8);
    addPayment({ id, type: "debt", createdBy: user.id, createdByTag: user.tag, targetUserId: target.id, targetUserTag: target.tag, product, amount, paypalLink, dueDate, status: "pending", createdAt: new Date().toISOString() });
    const embed = new EmbedBuilder().setTitle("⚠️ Outstanding Debt Notice").setColor(0xe74c3c)
      .addFields(
        { name: "Description", value: product, inline: true },
        { name: "Amount Owed", value: `**$${amount.toFixed(2)}**`, inline: true },
        { name: "Owed By", value: `${target}`, inline: true },
        { name: "Due Date", value: `**${dueDate}**`, inline: true },
        { name: "PayPal", value: paypalLink, inline: false },
        ...(note ? [{ name: "Note", value: note, inline: false }] : []),
        { name: "Reference ID", value: `\`${id}\``, inline: true },
      ).setFooter({ text: "Sign the acknowledgement below to confirm this debt." }).setTimestamp();
    await interaction.reply({ content: `${target}`, embeds: [embed], components: [buildSignButton(id)] });
    return;
  }

  if (commandName === "paylater") {
    const target = interaction.options.getUser("user", true);
    const product = interaction.options.getString("product", true).trim();
    const total = interaction.options.getNumber("total", true);
    const deposit = interaction.options.getNumber("deposit", true);
    const dueDate = interaction.options.getString("due_date", true).trim();
    const note = interaction.options.getString("note")?.trim() ?? null;
    if (deposit >= total) { await interaction.reply({ content: "Deposit must be less than the total.", ephemeral: true }); return; }
    const remaining = parseFloat((total - deposit).toFixed(2));
    const id = randomUUID().slice(0, 8);
    addPayment({ id, type: "paylater", createdBy: user.id, createdByTag: user.tag, targetUserId: target.id, targetUserTag: target.tag, product, amount: total, deposit, remaining, dueDate, paypalLink, status: "pending", createdAt: new Date().toISOString() });
    const embed = new EmbedBuilder().setTitle("💳 Pay Now, Pay Later").setColor(0xe67e22)
      .addFields(
        { name: "Product / Service", value: product, inline: true },
        { name: "Total Price", value: `**$${total.toFixed(2)}**`, inline: true },
        { name: "Billed To", value: `${target}`, inline: true },
        { name: "Due Now (Deposit)", value: `**$${deposit.toFixed(2)}**`, inline: true },
        { name: "Remaining Balance", value: `**$${remaining.toFixed(2)}**`, inline: true },
        { name: "Balance Due Date", value: `**${dueDate}**`, inline: true },
        { name: "PayPal", value: paypalLink, inline: false },
        ...(note ? [{ name: "Note", value: note, inline: false }] : []),
        { name: "Invoice ID", value: `\`${id}\``, inline: true },
      ).setFooter({ text: "Sign the agreement below — deposit is due immediately." }).setTimestamp();
    await interaction.reply({ content: `${target}`, embeds: [embed], components: [buildSignButton(id)] });
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
      embeds: [new EmbedBuilder().setTitle("🚫 Invoice Voided").setColor(0x95a5a6)
        .addFields(
          { name: "Invoice ID", value: `\`${invoiceId}\``, inline: true },
          { name: "Product", value: payment.product, inline: true },
          { name: "Amount", value: `$${payment.amount.toFixed(2)}`, inline: true },
          { name: "Reason", value: reason, inline: false },
        ).setTimestamp()],
      ephemeral: true,
    });
    try {
      const target = await client.users.fetch(payment.targetUserId);
      await target.send(`🚫 **Invoice Voided**\nInvoice \`${invoiceId}\` for **${payment.product}** ($${payment.amount.toFixed(2)}) has been voided.\n**Reason:** ${reason}`);
    } catch { /* DMs may be closed */ }
    return;
  }

  if (commandName === "status") {
    const invoiceId = interaction.options.getString("invoice_id", true).trim();
    const payment = getPayment(invoiceId);
    if (!payment) { await interaction.reply({ content: `No invoice found with ID \`${invoiceId}\`.`, ephemeral: true }); return; }
    const statusEmoji = { pending: "⏳", signed: "✅", voided: "🚫" };
    const statusColor = { pending: 0xfee75c, signed: 0x57f287, voided: 0x95a5a6 };
    const typeLabel = { invoice: "🧾 Invoice", subscription: "🔄 Subscription", debt: "⚠️ Debt", paylater: "💳 Pay Later" };
    const embed = new EmbedBuilder()
      .setTitle(`${typeLabel[payment.type] ?? payment.type} — Status`)
      .setColor(statusColor[payment.status] ?? 0x5865f2)
      .addFields(
        { name: "Invoice ID", value: `\`${invoiceId}\``, inline: true },
        { name: "Status", value: `${statusEmoji[payment.status] ?? "❓"} ${payment.status.toUpperCase()}`, inline: true },
        { name: "Product", value: payment.product, inline: true },
        { name: "Amount", value: `$${payment.amount.toFixed(2)}`, inline: true },
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
      `**[${p.type.toUpperCase()}]** \`${p.id}\` — ${p.product} — **$${p.amount.toFixed(2)}** ${statusEmoji[p.status] ?? ""} ${p.status}`
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
      const msg = `⏰ **Payment Reminder**\nYou have an outstanding invoice for **${payment.product}** — **$${payment.amount.toFixed(2)}**.\nInvoice ID: \`${invoiceId}\`\nPayPal: ${payment.paypalLink}${customMsg ? `\n\n${customMsg}` : ""}`;
      await target.send(msg);
      await interaction.reply({ content: `Reminder sent to **${target.tag}**.`, ephemeral: true });
    } catch {
      await interaction.reply({ content: `Could not DM <@${payment.targetUserId}> — they may have DMs disabled.`, ephemeral: true });
    }
    return;
  }

  if (commandName === "features") {
    const D = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
    const embed = new EmbedBuilder()
      .setTitle("TERMINAL CHECKOUT  ·  Payment & Billing Bot")
      .setColor(0x5865f2)
      .setDescription(
        "*Everything this bot can do — organized by category.*\n" +
        "*Commands marked* `owner` *are restricted to the bot owner.*\n\n" +
        `${D}\n` +
        "**💳  Invoices & Payments**\n" +
        "`/invoice` · · · · Send a standard PayPal invoice\n" +
        "`/subscription` · Create a recurring billing cycle\n" +
        "`/debt` · · · · · Record an outstanding debt + due date\n" +
        "`/paylater` · · · Deposit now — pay the rest later\n\n" +
        `${D}\n` +
        "**🔧  Invoice Management**  `owner`\n" +
        "`/void` · · · · · Cancel any pending invoice + DM the user\n" +
        "`/remind` · · · · Send a payment reminder to the user\n" +
        "`/history` · · · View all invoices for a specific user\n\n" +
        `${D}\n` +
        "**📋  Records & Agreements**\n" +
        "`/agreements` · · View the last 10 signed agreements  `owner`\n" +
        "`/status` · · · · Check any invoice's current status\n\n" +
        `${D}\n` +
        "**⚙️  Configuration**  `owner`\n" +
        "`/setup` · · · · · Set your PayPal link shown on all invoices\n\n" +
        `${D}\n` +
        "**ℹ️  Info**\n" +
        "`/features` · · · This menu"
      )
      .setFooter({ text: "Every invoice includes a legally binding sign-off with the client's full name." })
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
    return;
  }
}

function buildSignButton(paymentId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sign_${paymentId}`).setLabel("Sign Agreement").setStyle(ButtonStyle.Success).setEmoji("✍️")
  );
}

async function handleButton(interaction) {
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
      { name: "Amount", value: `$${payment.amount.toFixed(2)}`, inline: true },
      { name: "Signed At", value: `${ts} UTC`, inline: false },
      { name: "Invoice ID", value: `\`${paymentId}\``, inline: true },
    ).setFooter({ text: "Please complete your payment via PayPal." }).setTimestamp();

  await interaction.reply({ embeds: [confirmEmbed], ephemeral: true });

  try {
    const creator = await client.users.fetch(payment.createdBy);
    await creator.send(
      `📝 **Agreement Signed**\n**Invoice ID:** \`${paymentId}\`\n**Product:** ${payment.product}\n` +
      `**Amount:** $${payment.amount.toFixed(2)}\n**Signed by:** ${legalName} (${interaction.user.tag})\n**Signed at:** ${ts} UTC`
    );
  } catch { /* DMs may be closed */ }
}

function buildAgreementText(p) {
  switch (p.type) {
    case "invoice":
      return `PAYMENT AGREEMENT\n\nI agree to pay $${p.amount.toFixed(2)} for "${p.product}" via PayPal.\n\nI understand and agree that:\n• Payment is due immediately upon signing.\n• I waive all rights to initiate a chargeback or dispute.\n• Initiating a chargeback will be considered fraud and may result in legal action.\n\nThis agreement is binding upon signature.`;
    case "subscription":
      return `SUBSCRIPTION AGREEMENT\n\nI agree to pay $${p.amount.toFixed(2)} ${p.interval?.toLowerCase()} for "${p.product}" via PayPal.\n\nI understand and agree that:\n• Payments recur ${p.interval?.toLowerCase()} until cancelled.\n• I will not initiate chargebacks or disputes.\n• Cancellations must be communicated in advance.\n\nThis agreement is binding upon signature.`;
    case "debt":
      return `DEBT ACKNOWLEDGEMENT\n\nI acknowledge that I owe $${p.amount.toFixed(2)} for "${p.product}".\n\nI agree that:\n• The full amount is due by ${p.dueDate}.\n• Payment will be made via PayPal.\n• Failure to pay by the due date may result in further action.\n\nThis acknowledgement is binding upon signature.`;
    case "paylater":
      return `PAY NOW / PAY LATER AGREEMENT\n\nI agree to pay for "${p.product}" (Total: $${p.amount.toFixed(2)}) as follows:\n\n• Deposit due now: $${p.deposit?.toFixed(2)}\n• Remaining balance: $${p.remaining?.toFixed(2)}\n• Remaining balance due by: ${p.dueDate}\n\nI agree that:\n• The deposit is non-refundable.\n• I will pay the remaining balance by the due date.\n• No chargebacks will be initiated.\n\nThis agreement is binding upon signature.`;
  }
}

client.login(token);
