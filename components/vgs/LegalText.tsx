import { textParts, type CompanyKey } from "@/lib/vgs-legal";

const MISSING_LABEL: Record<CompanyKey, string> = {
  legalName: "επωνυμία",
  vatNumber: "ΑΦΜ",
  taxOffice: "ΔΟΥ",
  address: "διεύθυνση",
  email: "email",
  phone: "τηλέφωνο",
  courtsCity: "πόλη",
};

/**
 * One sentence of a legal text: company details filled in, links inside the
 * site made clickable. A detail not filled in yet is shown highlighted, so a
 * page cannot go live with a gap nobody noticed.
 */
export default function LegalText({ text, linkClass = "underline underline-offset-2" }: { text: string; linkClass?: string }) {
  return (
    <>
      {textParts(text).map((part, i) =>
        "missing" in part ? (
          <mark key={i} data-missing={part.missing} className="rounded bg-amber-200 px-1 text-black">
            [{MISSING_LABEL[part.missing]}: συμπληρώνεται]
          </mark>
        ) : "link" in part ? (
          <a key={i} href={part.href} className={linkClass}>
            {part.link}
          </a>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </>
  );
}
