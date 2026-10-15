/**
 * Appointment e-mails -- subject, plain text and HTML.
 *
 * Pure functions: everything they need is passed in, nothing is read from
 * the database or the environment.
 *
 * SAFETY RULE: these e-mails are triggered by a public booking form, to an
 * address typed by whoever filled it in. So that the form can never be used
 * to deliver somebody's own text to a third party's inbox, the body repeats
 * NOTHING the customer typed -- no name, no notes. Every word comes from
 * the business's own records (its name, address, phone and the service it
 * defined) plus the date and time. All of it is HTML-escaped regardless.
 * No images, no tracking, no remote content.
 */

export type AppointmentEmailKind = "confirmation" | "cancellation" | "rescheduled" | "reminder";

export interface AppointmentEmailInput {
  kind: AppointmentEmailKind;
  businessName: string;
  serviceName: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM or HH:MM:SS */
  time: string;
  /** Only for kind = "rescheduled": the previous date, YYYY-MM-DD. */
  previousDate?: string | null;
  businessPhone?: string | null;
  businessAddress?: string | null;
  /** Optional e-mails (reminder) only: the customer's "e-mail settings" link. */
  preferencesUrl?: string | null;
}

export interface AppointmentEmail {
  subject: string;
  text: string;
  html: string;
}

const WEEKDAYS_EL = ["Κυριακή", "Δευτέρα", "Τρίτη", "Τετάρτη", "Πέμπτη", "Παρασκευή", "Σάββατο"];
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F]/g;

/** One line of plain text: control characters removed, whitespace collapsed, trimmed, capped. */
function line(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "2026-10-09" -> "Παρασκευή 09/10/2026". Falls back to the raw value if it is not a date. */
export function formatGreekDate(dateISO: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO);
  if (!m) return line(dateISO, 20);
  const weekday = WEEKDAYS_EL[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
  return `${weekday} ${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * The business name as an e-mail display name: nothing that could end the
 * name or smuggle in a second address.
 */
export function emailDisplayName(name: string): string {
  return line(name, 120).replace(/[<>"\\,;:@()[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** `Business Name <address>` -- or the bare address when the name has nothing usable in it. */
export function formatFromHeader(businessName: string, fromEmail: string): string {
  const display = emailDisplayName(businessName);
  return display ? `${display} <${fromEmail}>` : fromEmail;
}

const SENDER_EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;

/** A usable single e-mail address (no display name, no list). Used for the sender setting and for recipients. */
export function isPlainEmailAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && SENDER_EMAIL_RE.test(value);
}

export function buildAppointmentEmail(input: AppointmentEmailInput): AppointmentEmail {
  const business = line(input.businessName, 120) || "Το κατάστημα";
  const service = line(input.serviceName, 120) || "Ραντεβού";
  const when = `${formatGreekDate(input.date)}, ώρα ${line(input.time, 8).slice(0, 5)}`;
  const phone = line(input.businessPhone, 40) || null;
  const address = line(input.businessAddress, 200) || null;

  let subject: string;
  let headline: string;
  let body: string;
  switch (input.kind) {
    case "confirmation":
      subject = `Επιβεβαίωση ραντεβού · ${business}`;
      headline = "Το ραντεβού σας επιβεβαιώθηκε";
      body = "Σας περιμένουμε.";
      break;
    case "cancellation":
      subject = `Ακύρωση ραντεβού · ${business}`;
      headline = "Το ραντεβού σας ακυρώθηκε";
      body = "Αν θέλετε να κλείσετε νέο ραντεβού, επικοινωνήστε μαζί μας.";
      break;
    case "rescheduled":
      subject = `Αλλαγή ραντεβού · ${business}`;
      headline = "Το ραντεβού σας μετακινήθηκε";
      body = input.previousDate
        ? `Η προηγούμενη ημερομηνία ήταν ${formatGreekDate(input.previousDate)}.`
        : "Παρακαλούμε σημειώστε τη νέα ημερομηνία.";
      break;
    case "reminder":
      subject = `Υπενθύμιση ραντεβού · ${business}`;
      headline = "Υπενθύμιση για το ραντεβού σας";
      body = phone
        ? `Αν δεν μπορείτε να έρθετε, ενημερώστε μας στο ${phone}.`
        : "Αν δεν μπορείτε να έρθετε, παρακαλούμε ενημερώστε μας.";
      break;
  }

  const details: Array<[string, string]> = [
    ["Υπηρεσία", service],
    [input.kind === "cancellation" ? "Ήταν για" : "Πότε", when],
  ];
  if (address) details.push(["Διεύθυνση", address]);
  if (phone) details.push(["Τηλέφωνο", phone]);

  const why =
    "Λάβατε αυτό το μήνυμα επειδή αυτή η διεύθυνση δηλώθηκε σε κράτηση ραντεβού. " +
    "Αν δεν κάνατε εσείς την κράτηση, μπορείτε να το αγνοήσετε.";

  return renderEmail({ subject, business, headline, details, body, why, preferencesUrl: input.preferencesUrl ?? null });
}

/** A link we are willing to put in an e-mail: absolute https (or http://localhost while developing), no credentials. */
export function isSafeEmailLink(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;
  try {
    const u = new URL(value);
    if (u.username || u.password) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

interface RenderInput {
  subject: string;
  business: string;
  headline: string;
  details: Array<[string, string]>;
  body: string;
  /** One button, e.g. "Γράψτε κριτική" -> review page. Only a safe absolute link is ever rendered. */
  action?: { label: string; url: string } | null;
  why: string;
  /** "E-mail settings" link (optional e-mails only). */
  preferencesUrl?: string | null;
}

/** Body text as HTML: blank lines start a new paragraph, single line breaks are kept. */
function bodyHtml(body: string, sans: string): string {
  return body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="margin:18px 0 0;font-family:${sans};font-size:14px;line-height:1.6;color:#1a1a1a;">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`
    )
    .join("\n");
}

/** The shared plain-text + HTML layout of every e-mail. Everything is escaped; links only if isSafeEmailLink(). */
function renderEmail(input: RenderInput): AppointmentEmail {
  const action = input.action && isSafeEmailLink(input.action.url) ? input.action : null;
  const preferencesUrl = isSafeEmailLink(input.preferencesUrl) ? input.preferencesUrl : null;

  const text = [
    input.business,
    "",
    /[.!;?…]$/.test(input.headline) ? input.headline : `${input.headline}.`,
    "",
    ...input.details.map(([label, value]) => `${label}: ${value}`),
    ...(input.details.length ? [""] : []),
    input.body,
    ...(action ? ["", `${action.label}: ${action.url}`] : []),
    "",
    "- - -",
    input.why,
    ...(preferencesUrl ? [`Ρυθμίσεις email: ${preferencesUrl}`] : []),
    "",
  ].join("\n");

  const sans = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const rows = input.details
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 16px 6px 0;font-family:${sans};font-size:14px;color:#6b6b6b;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>` +
        `<td style="padding:6px 0;font-family:${sans};font-size:14px;color:#1a1a1a;">${escapeHtml(value)}</td></tr>`
    )
    .join("");
  const button = action
    ? `<p style="margin:22px 0 0;"><a href="${escapeHtml(action.url)}" style="display:inline-block;background:#1a1a1a;color:#ffffff;font-family:${sans};font-size:14px;text-decoration:none;padding:12px 22px;">${escapeHtml(action.label)}</a></p>`
    : "";
  const prefs = preferencesUrl
    ? `<p style="margin:10px 0 0;font-family:${sans};font-size:12px;line-height:1.6;color:#8a8a8a;"><a href="${escapeHtml(preferencesUrl)}" style="color:#8a8a8a;">Ρυθμίσεις email</a> — επιλέξτε ποια μηνύματα θέλετε να λαμβάνετε.</p>`
    : "";

  const html = `<!doctype html>
<html lang="el">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f2;">
<tr><td align="center" style="padding:28px 14px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border:1px solid #e3e3df;">
<tr><td style="padding:28px 28px 8px;">
<p style="margin:0 0 18px;font-family:${sans};font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#6b6b6b;">${escapeHtml(input.business)}</p>
<p style="margin:0 0 18px;font-family:${sans};font-size:20px;line-height:1.35;color:#1a1a1a;">${escapeHtml(input.headline)}</p>
${rows ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0">${rows}</table>` : ""}
${bodyHtml(input.body, sans)}
${button}
</td></tr>
<tr><td style="padding:20px 28px 26px;">
<p style="margin:0;font-family:${sans};font-size:12px;line-height:1.6;color:#8a8a8a;">${escapeHtml(input.why)}</p>
${prefs}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;

  return { subject: input.subject, text, html };
}

const OPTIONAL_WHY =
  "Λάβατε αυτό το μήνυμα επειδή έχετε κλείσει ραντεβού μαζί μας στο παρελθόν.";

/** "How was your visit?" -- sent after a completed appointment, with the review link. */
export function buildReviewRequestEmail(input: {
  businessName: string;
  serviceName: string;
  /** YYYY-MM-DD of the visit */
  date: string;
  reviewUrl: string;
  preferencesUrl: string | null;
}): AppointmentEmail {
  const business = line(input.businessName, 120) || "Το κατάστημα";
  const service = line(input.serviceName, 120) || "Ραντεβού";
  return renderEmail({
    subject: `Πώς ήταν η επίσκεψή σας; · ${business}`,
    business,
    headline: "Πώς ήταν η επίσκεψή σας;",
    details: [
      ["Υπηρεσία", service],
      ["Ημερομηνία", formatGreekDate(input.date)],
    ],
    body: "Θα χαρούμε να μας πείτε τη γνώμη σας — παίρνει λιγότερο από ένα λεπτό. Ο σύνδεσμος ισχύει 30 ημέρες.",
    action: { label: "Γράψτε κριτική", url: input.reviewUrl },
    why: OPTIONAL_WHY,
    preferencesUrl: input.preferencesUrl,
  });
}

/** "Time for your next visit?" -- sent when a regular customer is past their usual interval. */
export function buildRebookingEmail(input: {
  businessName: string;
  serviceName: string;
  /** YYYY-MM-DD of the last visit */
  lastVisitDate: string;
  bookingUrl: string;
  preferencesUrl: string | null;
}): AppointmentEmail {
  const business = line(input.businessName, 120) || "Το κατάστημα";
  const service = line(input.serviceName, 120) || "Ραντεβού";
  return renderEmail({
    subject: `Ώρα για το επόμενο ραντεβού; · ${business}`,
    business,
    headline: "Ώρα για το επόμενο ραντεβού;",
    details: [
      ["Τελευταία επίσκεψη", formatGreekDate(input.lastVisitDate)],
      ["Υπηρεσία", service],
    ],
    body: "Κλείστε την επόμενη επίσκεψή σας online, στην ώρα που σας βολεύει.",
    action: { label: "Κλείστε ραντεβού", url: input.bookingUrl },
    why: OPTIONAL_WHY,
    preferencesUrl: input.preferencesUrl,
  });
}

const MARKETING_WHY =
  "Λάβατε αυτό το μήνυμα επειδή δεχτήκατε να λαμβάνετε νέα και προσφορές από το κατάστημα. Μπορείτε να το σταματήσετε όποτε θέλετε από τις ρυθμίσεις email.";

/**
 * A campaign e-mail (offers, news). Subject and text are already personalized
 * (lib/campaigns.ts personalize()). Always carries the "Ρυθμίσεις email" link
 * when one exists -- that is how the customer stops these e-mails.
 */
export function buildCampaignEmail(input: {
  businessName: string;
  subject: string;
  body: string;
  bookingUrl: string | null;
  preferencesUrl: string | null;
}): AppointmentEmail {
  const business = line(input.businessName, 120) || "Το κατάστημα";
  const subject = line(input.subject, 120) || business;
  const body = typeof input.body === "string" ? input.body.replace(/\r\n?/g, "\n").slice(0, 2400) : "";
  return renderEmail({
    subject,
    business,
    headline: subject,
    details: [],
    body,
    action: input.bookingUrl ? { label: "Κλείστε ραντεβού", url: input.bookingUrl } : null,
    why: MARKETING_WHY,
    preferencesUrl: input.preferencesUrl,
  });
}
