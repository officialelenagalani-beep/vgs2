import Link from "next/link";

/** Any address that does not exist. Neutral: it may be under any shop's pages or the VGS APP page. */
export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-ink px-6">
      <div className="text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-stone">404</p>
        <h1 className="mt-4 font-display text-4xl text-bone">Η σελίδα δεν βρέθηκε</h1>
        <p className="mt-3 text-stone">Ίσως μετακινήθηκε, ή ποτέ δεν υπήρξε.</p>
        <Link
          href="/"
          className="mt-8 inline-flex px-7 py-3.5 text-sm font-medium bg-white text-ink hover:bg-accent-dim transition-colors"
        >
          Επιστροφή στην αρχική
        </Link>
      </div>
    </main>
  );
}
