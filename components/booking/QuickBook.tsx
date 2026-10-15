"use client";

import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { useKeyedLoad, getJson } from "@/lib/use-keyed-load";
import { isoDate as localISODate } from "@/lib/analytics-ranges";
import { isPlainEmailAddress } from "@/lib/notifications/email-templates";
import { HONEYPOT_FIELD, HONEYPOT_STYLE } from "@/lib/honeypot";
import { paidPrice } from "@/lib/discounts";
import { barbersFor, dayLabel, euro, groupSlots, initial, longDay, nextDays, PHONE_RE, type TeamMember } from "@/lib/quick-book";
import type { Appointment, AvailabilityResponse } from "@/types/appointments";

/**
 * The booking app: service -> barber -> day & time -> details.
 *
 * Talks only to the public, per-shop endpoints (/api/v1/businesses/<slug>/…):
 *  - services: the catalog, plus which barbers do which service,
 *  - availability: free times for the day, for ONE barber when one is
 *    chosen (employeeId) or for anyone free,
 *  - appointments: the booking, with employee_id when a barber was chosen
 *    (the server checks again that this barber does the service and is free).
 *
 * Colours come from CSS variables set by the page (--qb-*), so the same app
 * sits on a light page (Independence site) or a dark one (Autopilot site).
 */

type Service = { id: string; name: string; duration: number; price: number };
type Category = { id: string; label: string; services: Service[] };
type AppliedDiscount = { code: string; description: string | null; final_price: number; discount: number; first_visit_only: boolean; once_per_customer: boolean };

export type QuickBookProps = {
  slug: string;
  shopName: string;
  /** Weekdays (0 = Sunday) the shop is closed. */
  closedWeekdays: number[];
  /** Plan features: discount-code field and the offers & news box. */
  discounts?: boolean;
  marketing?: boolean;
  /** Barbers' photos by name (src + where the face sits); initials otherwise. */
  barberPhotos?: Record<string, { src: string; position: string }>;
};

const ANY = "any";

// Theme tokens (set by the page).
const C = {
  card: "bg-[color:var(--qb-card)]",
  ink: "text-[color:var(--qb-ink)]",
  muted: "text-[color:var(--qb-muted)]",
  line: "border-[color:var(--qb-line)]",
  accentBg: "bg-[color:var(--qb-accent)] text-[color:var(--qb-on-accent)]",
  field:
    "w-full rounded-2xl border border-[color:var(--qb-line)] bg-[color:var(--qb-field)] px-4 py-3.5 text-[15px] text-[color:var(--qb-ink)] outline-none transition placeholder:text-[color:var(--qb-muted)] focus:border-[color:var(--qb-accent)] focus:ring-4 focus:ring-[color:var(--qb-ring)]",
};

const STEPS = ["Υπηρεσία", "Κουρέας", "Ημέρα & ώρα", "Στοιχεία"];

export default function QuickBook({ slug, shopName, closedWeekdays, discounts = false, marketing = false, barberPhotos = {} }: QuickBookProps) {
  const base = `/api/v1/businesses/${encodeURIComponent(slug)}`;
  const preselected = useSearchParams().get("service");

  // ── Catalog & team ────────────────────────────────────────────────────
  const [categories, setCategories] = useState<Category[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [teamByService, setTeamByService] = useState<Record<string, string[]>>({});
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "error">("loading");

  // ── Choices ───────────────────────────────────────────────────────────
  const [step, setStep] = useState(1);
  const [dir, setDir] = useState(1);
  const [service, setService] = useState<Service | null>(null);
  const [barber, setBarber] = useState<string | null>(null); // ANY or an employee id
  const [date, setDate] = useState<Date | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [slotsVersion, setSlotsVersion] = useState(0);

  // ── Details ───────────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [optIn, setOptIn] = useState(false);
  const [trap, setTrap] = useState("");
  const [errors, setErrors] = useState<{ name?: string; phone?: string; email?: string }>({});
  const [codeInput, setCodeInput] = useState("");
  const [discount, setDiscount] = useState<AppliedDiscount | null>(null);
  const [codeError, setCodeError] = useState("");
  const [checkingCode, setCheckingCode] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [done, setDone] = useState<Appointment | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${base}/services`);
        const json = await res.json();
        if (cancelled) return;
        if (!json.success) throw new Error("catalog");
        const cats = (json.data.categories ?? []) as Category[];
        setCategories(cats);
        setTeam((json.data.team ?? []) as TeamMember[]);
        setTeamByService((json.data.team_by_service ?? {}) as Record<string, string[]>);
        setEmailEnabled(json.data.booking?.email_confirmation === true);
        setCatalogState("ready");
        if (preselected) {
          const found = cats.flatMap((c) => c.services).find((s) => s.id === preselected);
          if (found) setService(found);
        }
      } catch {
        if (!cancelled) setCatalogState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const barbers = useMemo(() => barbersFor(service?.id, team, teamByService), [service, team, teamByService]);
  const days = useMemo(() => nextDays(21), []);
  const isOpen = (d: Date) => !closedWeekdays.includes(d.getDay());
  const chosenBarber = barber && barber !== ANY ? team.find((m) => m.id === barber) ?? null : null;

  // ── Free times ────────────────────────────────────────────────────────
  const dateISO = date ? localISODate(date) : "";
  const slotsUrl =
    step >= 3 && service && dateISO
      ? `${base}/availability?date=${dateISO}&service=${encodeURIComponent(service.id)}${chosenBarber ? `&employeeId=${chosenBarber.id}` : ""}`
      : null;
  const slots = useKeyedLoad(slotsUrl ? `${slotsUrl}#${slotsVersion}` : null, () =>
    getJson<{ success: boolean; data?: AvailabilityResponse; error?: string }>(slotsUrl!)
  );
  const free = slots.data?.success ? slots.data.data?.available_slots ?? [] : [];
  const parts = groupSlots(free);

  // ── Navigation ────────────────────────────────────────────────────────
  function go(to: number) {
    setDir(to > step ? 1 : -1);
    setStep(to);
  }

  function pickService(s: Service) {
    if (service?.id !== s.id) {
      setBarber(null);
      setTime(null);
      setDiscount(null);
      setCodeError("");
    }
    setService(s);
    const who = barbersFor(s.id, team, teamByService);
    // One barber (or none listed): nothing to choose, straight to the times.
    if (who.length <= 1) {
      setBarber(who[0]?.id ?? ANY);
      enterTimes();
      return;
    }
    setDir(1);
    setStep(2);
  }

  function pickBarber(id: string) {
    if (barber !== id) setTime(null);
    setBarber(id);
    enterTimes();
  }

  function enterTimes() {
    if (!date) setDate(days.find(isOpen) ?? days[0]);
    setDir(1);
    setStep(3);
  }

  function pickTime(t: string) {
    setTime(t);
    setDir(1);
    setStep(4);
  }

  function back() {
    if (step === 3 && barbers.length <= 1) go(1);
    else go(Math.max(1, step - 1));
  }

  function restart() {
    setDone(null);
    setService(null);
    setBarber(null);
    setTime(null);
    setDiscount(null);
    setCodeInput("");
    setSubmitError("");
    setSlotsVersion((v) => v + 1);
    setDir(-1);
    setStep(1);
  }

  async function applyCode() {
    const code = codeInput.trim();
    if (!code || !service) return;
    setCheckingCode(true);
    setCodeError("");
    try {
      const res = await fetch(`${base}/discount-codes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, service: service.id }),
      });
      const json = await res.json();
      if (json.success) setDiscount(json.data as AppliedDiscount);
      else {
        setDiscount(null);
        setCodeError(json.error ?? "Ο κωδικός δεν ισχύει.");
      }
    } catch {
      setCodeError("Σφάλμα σύνδεσης. Δοκίμασε ξανά.");
    } finally {
      setCheckingCode(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (name.trim().length < 2) next.name = "Γράψε το ονοματεπώνυμό σου.";
    if (!PHONE_RE.test(phone.trim())) next.phone = "Γράψε ένα έγκυρο κινητό.";
    const mail = emailEnabled ? email.trim() : "";
    if (mail && !isPlainEmailAddress(mail)) next.email = "Το email δεν φαίνεται σωστό. Διόρθωσέ το ή άφησέ το κενό.";
    setErrors(next);
    if (Object.keys(next).length > 0 || !service || !time) return;

    setSubmitting(true);
    setSubmitError("");
    try {
      const res = await fetch(`${base}/appointments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_name: name.trim(),
          customer_phone: phone.trim(),
          ...(mail ? { customer_email: mail } : {}),
          ...(mail && optIn ? { marketing_opt_in: true } : {}),
          ...(trap ? { [HONEYPOT_FIELD]: trap } : {}),
          ...(discount ? { discount_code: discount.code } : {}),
          ...(chosenBarber ? { employee_id: chosenBarber.id } : {}),
          service: service.id,
          appointment_date: dateISO,
          appointment_time: time,
          source: "website",
        }),
      });
      const json = await res.json();
      if (json.success) {
        setDone(json.data as Appointment);
      } else if (json.field === "discount_code") {
        setDiscount(null);
        setCodeError(json.error ?? "Ο κωδικός δεν ισχύει.");
      } else if (res.status === 409 || /διαθέσιμ/.test(String(json.error ?? ""))) {
        // Someone took the time in the meantime: back to the times, refreshed.
        setTime(null);
        setSlotsVersion((v) => v + 1);
        setSubmitError("Η ώρα αυτή μόλις κλείστηκε. Διάλεξε μια άλλη.");
        go(3);
      } else {
        setSubmitError(json.error ?? "Κάτι πήγε στραβά. Δοκίμασε ξανά.");
      }
    } catch {
      setSubmitError("Σφάλμα σύνδεσης. Δοκίμασε ξανά.");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Confirmation ──────────────────────────────────────────────────────
  if (done && service && date && time) {
    const who = chosenBarber?.name ?? team.find((m) => m.id === done.employee_id)?.name ?? null;
    return (
      <div
        className={`qb-up rounded-[32px] border ${C.line} ${C.card} p-7 text-center sm:p-12`}
      >
        <svg viewBox="0 0 64 64" className="mx-auto h-20 w-20" aria-hidden="true">
          <circle className="qb-draw" cx="32" cy="32" r="29" fill="none" stroke="var(--qb-accent)" strokeWidth="3" pathLength={1} />
          <path className="qb-draw" style={{ animationDelay: "550ms" }} d="M20 33l8 8 16-17" fill="none" stroke="var(--qb-accent)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
        </svg>
        <h2 className={`mt-6 text-[30px] font-semibold leading-tight tracking-tight sm:text-[38px] ${C.ink}`}>Το ραντεβού κλείστηκε!</h2>
        <p className={`mt-2 ${C.muted}`}>Σε περιμένουμε στο {shopName}.</p>
        <dl className={`mx-auto mt-8 max-w-md divide-y rounded-3xl border text-left text-[15px] ${C.line} divide-[color:var(--qb-line)]`}>
          {[
            ["Υπηρεσία", service.name],
            ...(who ? [["Κουρέας", who]] : []),
            ["Ημέρα", longDay(date)],
            ["Ώρα", time],
            ["Κόστος", euro(paidPrice({ service_price: done.service_price ?? service.price, discount_amount: done.discount_amount }))],
          ].map(([k, v], i) => (
            <div key={k} style={{ animationDelay: `${700 + i * 70}ms` }}
              className="qb-up flex justify-between gap-4 px-5 py-3.5">
              <dt className={C.muted}>{k}</dt>
              <dd className={`text-right font-medium ${C.ink}`}>{v}</dd>
            </div>
          ))}
        </dl>
        <button type="button" onClick={restart} className={`mt-8 rounded-full px-7 py-3.5 text-[15px] font-semibold transition hover:opacity-90 ${C.accentBg}`}>
          Νέο ραντεβού
        </button>
      </div>
    );
  }

  // ── The steps ─────────────────────────────────────────────────────────
  const progress = ((step - 1) / (STEPS.length - 1)) * 100;
  return (
    <div className={`w-full min-w-0 max-w-full overflow-hidden rounded-[32px] border ${C.line} ${C.card}`}>
      {/* Step rail */}
      <div className={`border-b ${C.line} px-5 pb-4 pt-5 sm:px-8`}>
        <div className="flex items-center justify-between gap-3">
          <button type="button" onClick={back} disabled={step === 1}
            className={`-ml-2 rounded-full px-3 py-1.5 text-sm font-medium transition disabled:pointer-events-none disabled:opacity-0 ${C.muted} hover:text-[color:var(--qb-ink)]`}>
            ← Πίσω
          </button>
          <p className={`text-sm ${C.muted}`} aria-live="polite">
            Βήμα <span className={`font-semibold ${C.ink}`}>{step}</span> από {STEPS.length} · {STEPS[step - 1]}
          </p>
        </div>
        <div className="relative mt-4 h-1.5 overflow-hidden rounded-full bg-[color:var(--qb-line)]">
          <div className="absolute inset-y-0 left-0 rounded-full bg-[color:var(--qb-accent)] transition-[width] duration-700 ease-out"
            style={{ width: `${Math.max(progress, 6)}%` }} />
        </div>
        <ol className="mt-3 hidden grid-cols-4 text-xs sm:grid">
          {STEPS.map((label, i) => (
            <li key={label} className={`${i + 1 <= step ? C.ink : C.muted} ${i === 0 ? "" : i === 3 ? "text-right" : "text-center"}`}>{label}</li>
          ))}
        </ol>
      </div>

      <div className="relative min-h-[420px] px-5 py-7 sm:px-8 sm:py-9">
        {/* Each step slides in from the side it comes from. No exit animation:
            the next step appears at once (waiting for the old one to leave
            could leave the panel empty on some phones/browsers). */}
        <div key={step} className={dir > 0 ? "qb-in-right" : "qb-in-left"}>
            {step === 1 && (
              <StepServices state={catalogState} categories={categories} selected={service?.id ?? null} onPick={pickService} />
            )}
            {step === 2 && service && (
              <StepBarbers service={service} barbers={barbers} selected={barber} onPick={pickBarber} photos={barberPhotos} />
            )}
            {step === 3 && service && (
              <section aria-labelledby="qb-when">
                <Heading id="qb-when" title="Πότε σε βολεύει;" sub={chosenBarber ? `Ελεύθερες ώρες με τον ${chosenBarber.name}.` : "Ελεύθερες ώρες με όποιον κουρέα είναι διαθέσιμος."} />
                <div className="-mx-5 mt-6 overflow-x-auto px-5 pb-2 [scrollbar-width:none] sm:-mx-8 sm:px-8">
                  <div className="flex snap-x gap-2.5">
                    {days.map((d) => {
                      const open = isOpen(d);
                      const active = date?.toDateString() === d.toDateString();
                      return (
                        <button key={d.toISOString()} type="button" disabled={!open} aria-pressed={active}
                          aria-label={`${longDay(d)}${open ? "" : " (κλειστά)"}`}
                          onClick={() => { if (!active) { setDate(d); setTime(null); } }}
                          className={`relative w-[68px] shrink-0 snap-start rounded-2xl border px-2 py-3 text-center transition ${C.line} disabled:opacity-35 ${active ? "" : "hover:-translate-y-0.5 hover:border-[color:var(--qb-accent)]"}`}>
                          {active && <span className="qb-pop absolute inset-0 rounded-2xl bg-[color:var(--qb-accent)]" />}
                          <span className={`relative block text-[11px] font-medium uppercase tracking-wide ${active ? "text-[color:var(--qb-on-accent)]" : C.muted}`}>{dayLabel(d)}</span>
                          <span className={`relative mt-1 block text-[22px] font-semibold leading-none ${active ? "text-[color:var(--qb-on-accent)]" : C.ink}`}>{d.getDate()}</span>
                          <span className={`relative mt-1 block text-[11px] ${active ? "text-[color:var(--qb-on-accent)] opacity-80" : C.muted}`}>{d.toLocaleDateString("el-GR", { month: "short" }).replace(".", "")}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {submitError && <p role="alert" className="mt-5 rounded-2xl bg-[color:var(--qb-ring)] px-4 py-3 text-sm text-[color:var(--qb-ink)]">{submitError}</p>}

                <div className="mt-7 min-h-[180px]" aria-live="polite">
                  {slots.loading ? (
                    <div className="grid grid-cols-4 gap-2.5 sm:grid-cols-6">
                      {Array.from({ length: 12 }, (_, i) => (
                        <div key={i} className="h-12 animate-pulse rounded-2xl bg-[color:var(--qb-line)]" style={{ animationDelay: `${i * 60}ms` }} />
                      ))}
                    </div>
                  ) : slots.error || (slots.data && !slots.data.success) ? (
                    <p className={C.muted}>Δεν φόρτωσαν οι ώρες. Δοκίμασε ξανά σε λίγο.</p>
                  ) : parts.length === 0 ? (
                    <div className={`rounded-3xl border border-dashed ${C.line} px-6 py-10 text-center`}>
                      <p className={`font-medium ${C.ink}`}>Δεν υπάρχουν ελεύθερες ώρες αυτή τη μέρα.</p>
                      <p className={`mt-1 text-sm ${C.muted}`}>
                        Διάλεξε άλλη μέρα{chosenBarber && barbers.length > 1 ? " ή άλλον κουρέα" : ""}.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-6">
                      {parts.map((part) => (
                        <div key={part.key}>
                          <p className={`mb-2.5 text-xs font-semibold uppercase tracking-[0.14em] ${C.muted}`}>{part.label}</p>
                          <div className="grid grid-cols-4 gap-2.5 sm:grid-cols-6">
                            {part.slots.map((s, si) => (
                              <button key={s} type="button" onClick={() => pickTime(s)} aria-pressed={time === s}
                                style={{ animationDelay: `${si * 25}ms` }}
                                className={`qb-up h-12 active:scale-95 rounded-2xl border text-[15px] font-semibold tabular-nums transition ${time === s ? `${C.accentBg} border-transparent` : `${C.line} ${C.ink} hover:border-[color:var(--qb-accent)] hover:bg-[color:var(--qb-ring)]`}`}>
                                {s}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            )}
            {step === 4 && service && date && time && (
              <form onSubmit={submit} noValidate aria-labelledby="qb-details">
                <Heading id="qb-details" title="Τελευταίο βήμα" sub="Τα στοιχεία σου, για να σε περιμένουμε." />

                <div className={`mt-6 flex flex-wrap gap-2 text-sm`}>
                  <Chip onClick={() => go(1)}>{service.name} · {euro(discount ? discount.final_price : service.price)}</Chip>
                  {barbers.length > 1 && <Chip onClick={() => go(2)}>{chosenBarber ? chosenBarber.name : "Όποιος είναι διαθέσιμος"}</Chip>}
                  <Chip onClick={() => go(3)}>{longDay(date)} · {time}</Chip>
                </div>

                <div style={HONEYPOT_STYLE} aria-hidden="true">
                  <label htmlFor={HONEYPOT_FIELD}>Αφήστε κενό</label>
                  <input id={HONEYPOT_FIELD} name={HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} />
                </div>

                <div className="mt-6 grid gap-4 sm:grid-cols-2">
                  <Field label="Ονοματεπώνυμο" error={errors.name} id="qb-name">
                    <input id="qb-name" className={C.field} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="π.χ. Γιάννης Π." aria-invalid={Boolean(errors.name)} />
                  </Field>
                  <Field label="Κινητό" error={errors.phone} id="qb-phone">
                    <input id="qb-phone" className={C.field} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" placeholder="69…" aria-invalid={Boolean(errors.phone)} />
                  </Field>
                  {emailEnabled && (
                    <Field label="Email (προαιρετικά, για επιβεβαίωση)" error={errors.email} id="qb-email" wide>
                      <input id="qb-email" type="email" className={C.field} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="name@example.com" aria-invalid={Boolean(errors.email)} />
                    </Field>
                  )}
                  {emailEnabled && marketing && email.trim() && (
                    <label className={`flex items-start gap-3 text-sm sm:col-span-2 ${C.muted}`}>
                      <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[color:var(--qb-accent)]" />
                      Θέλω να μαθαίνω για προσφορές και νέα του καταστήματος.
                    </label>
                  )}
                  {discounts && (
                    <div className="sm:col-span-2">
                      <label htmlFor="qb-code" className={`mb-1.5 block text-sm font-medium ${C.ink}`}>Κωδικός έκπτωσης</label>
                      {discount ? (
                        <div className={`flex items-center justify-between rounded-2xl border ${C.line} px-4 py-3 text-sm`}>
                          <span className={C.ink}><b>{discount.code}</b> · −{euro(discount.discount)}</span>
                          <button type="button" className={C.muted} onClick={() => { setDiscount(null); setCodeInput(""); }}>Αφαίρεση</button>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <input id="qb-code" className={C.field} value={codeInput} onChange={(e) => setCodeInput(e.target.value)} placeholder="Αν έχεις" />
                          <button type="button" onClick={applyCode} disabled={checkingCode || !codeInput.trim()}
                            className={`shrink-0 rounded-2xl border px-5 text-sm font-semibold transition disabled:opacity-40 ${C.line} ${C.ink}`}>
                            {checkingCode ? "…" : "Εφαρμογή"}
                          </button>
                        </div>
                      )}
                      {codeError && <p className="mt-1.5 text-sm text-red-500">{codeError}</p>}
                    </div>
                  )}
                </div>

                <p className={`mt-5 text-xs leading-relaxed ${C.muted}`}>
                  Τα στοιχεία σου τα χρησιμοποιεί το κατάστημα μόνο για το ραντεβού σου.{" "}
                  <a href={`/b/${encodeURIComponent(slug)}/privacy`} target="_blank" rel="noopener" className="underline underline-offset-2">Πώς τα χειρίζεται</a>
                </p>

                {submitError && <p role="alert" className="mt-4 text-sm text-red-500">{submitError}</p>}

                <button type="submit" disabled={submitting}
                  className={`group mt-6 flex w-full items-center justify-center gap-2 rounded-full py-4 text-[16px] font-semibold transition hover:opacity-95 disabled:opacity-60 ${C.accentBg}`}>
                  {submitting ? "Κλείνουμε το ραντεβού…" : <>Κλείσε το ραντεβού <span aria-hidden="true" className="transition-transform group-hover:translate-x-1">→</span></>}
                </button>
              </form>
            )}
          </div>
      </div>
    </div>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────

function Heading({ id, title, sub }: { id: string; title: string; sub?: string }) {
  return (
    <div>
      <h2 id={id} className={`text-[26px] font-semibold leading-tight tracking-tight sm:text-[32px] ${C.ink}`}>{title}</h2>
      {sub && <p className={`mt-1.5 text-[15px] ${C.muted}`}>{sub}</p>}
    </div>
  );
}

function Chip({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded-full border px-3.5 py-1.5 transition hover:border-[color:var(--qb-accent)] ${C.line} ${C.ink}`}>
      {children} <span aria-hidden="true" className={C.muted}>✎</span>
    </button>
  );
}

function Field({ label, error, id, wide, children }: { label: string; error?: string; id: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <label htmlFor={id} className={`mb-1.5 block text-sm font-medium ${C.ink}`}>{label}</label>
      {children}
      {error && <p className="mt-1.5 text-sm text-red-500">{error}</p>}
    </div>
  );
}

function StepServices({ state, categories, selected, onPick }: {
  state: "loading" | "ready" | "error"; categories: Category[]; selected: string | null; onPick: (s: Service) => void;
}) {
  return (
    <section aria-labelledby="qb-what">
      <Heading id="qb-what" title="Τι θα κάνουμε σήμερα;" sub="Διάλεξε υπηρεσία." />
      {state === "loading" && (
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => <div key={i} className="h-[86px] animate-pulse rounded-3xl bg-[color:var(--qb-line)]" />)}
        </div>
      )}
      {state === "error" && <p className={`mt-6 ${C.muted}`}>Δεν φόρτωσαν οι υπηρεσίες. Ανανέωσε τη σελίδα.</p>}
      {state === "ready" && categories.map((cat, ci) => (
        <div key={cat.id} className="mt-7 first-of-type:mt-6">
          {categories.length > 1 && <p className={`mb-3 text-xs font-semibold uppercase tracking-[0.14em] ${C.muted}`}>{cat.label}</p>}
          <ul className="grid gap-3 sm:grid-cols-2">
            {cat.services.map((s, si) => {
              const active = selected === s.id;
              return (
                <li key={s.id} className="qb-up" style={{ animationDelay: `${ci * 80 + si * 50}ms` }}>
                  <button type="button" onClick={() => onPick(s)} aria-pressed={active}
                    className={`group relative flex w-full items-center justify-between gap-4 overflow-hidden rounded-3xl border px-5 py-5 text-left transition duration-300 hover:-translate-y-0.5 hover:border-[color:var(--qb-accent)] hover:shadow-[0_18px_40px_-24px_var(--qb-shadow)] ${active ? "border-[color:var(--qb-accent)]" : C.line}`}>
                    <span className="absolute inset-y-0 left-0 w-1 origin-top scale-y-0 bg-[color:var(--qb-accent)] transition-transform duration-300 group-hover:scale-y-100" aria-hidden="true" />
                    <span>
                      <span className={`block text-[17px] font-semibold ${C.ink}`}>{s.name}</span>
                      <span className={`mt-0.5 block text-sm ${C.muted}`}>{s.duration} λεπτά</span>
                    </span>
                    <span className="flex items-center gap-3">
                      <span className={`text-[18px] font-semibold tabular-nums ${C.ink}`}>{euro(s.price)}</span>
                      <span aria-hidden="true" className={`flex h-9 w-9 items-center justify-center rounded-full border transition duration-300 group-hover:translate-x-0.5 group-hover:border-transparent group-hover:bg-[color:var(--qb-accent)] group-hover:text-[color:var(--qb-on-accent)] ${C.line} ${C.ink}`}>→</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

function StepBarbers({ service, barbers, selected, onPick, photos }: {
  service: Service; barbers: TeamMember[]; selected: string | null; onPick: (id: string) => void;
  photos: Record<string, { src: string; position: string }>;
}) {
  const options = [{ id: ANY, name: "Όποιος είναι διαθέσιμος" }, ...barbers];
  return (
    <section aria-labelledby="qb-who">
      <Heading id="qb-who" title="Με ποιον κουρέα;" sub={`Για «${service.name}».`} />
      <ul className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {options.map((b, i) => {
          const any = b.id === ANY;
          const active = selected === b.id;
          return (
            <li key={b.id} style={{ animationDelay: `${i * 60}ms` }}
              className={`qb-up ${any ? "col-span-2 sm:col-span-1" : ""}`}>
              <button type="button" onClick={() => onPick(b.id)} aria-pressed={active}
                className={`group flex h-full w-full flex-col items-center gap-3 rounded-3xl border px-4 py-6 text-center transition duration-300 hover:-translate-y-1 hover:border-[color:var(--qb-accent)] hover:shadow-[0_22px_44px_-26px_var(--qb-shadow)] ${active ? "border-[color:var(--qb-accent)]" : C.line}`}>
                <span className="relative flex h-24 w-24 items-center justify-center">
                  <span aria-hidden="true" className="qb-ring absolute inset-0 rounded-full opacity-60 transition-opacity duration-300 group-hover:opacity-100"
                    style={{ "--qb-hue": `${(i * 57) % 360}deg` } as CSSProperties} />
                  <span className={`relative flex h-[86px] w-[86px] items-center justify-center overflow-hidden rounded-full text-[28px] font-semibold ${C.card} ${C.ink}`}>
                    {!any && photos[b.name] ? (
                      <Image src={photos[b.name].src} alt="" fill sizes="86px" className="object-cover transition-transform duration-500 group-hover:scale-110"
                        style={{ objectPosition: photos[b.name].position }} />
                    ) : any ? "✦" : initial(b.name)}
                  </span>
                </span>
                <span className={`text-[16px] font-semibold leading-snug ${C.ink}`}>{b.name}</span>
                <span className={`text-xs ${C.muted}`}>{any ? "Η πιο γρήγορη διαθέσιμη ώρα" : "Δες τις ώρες του"}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
