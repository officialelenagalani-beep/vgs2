import SectionDivider from "./SectionDivider";

type SectionHeadingProps = {
  eyebrow: string;
  title: string;
  description?: string;
  align?: "left" | "center";
};

export default function SectionHeading({
  eyebrow,
  title,
  description,
  align = "left",
}: SectionHeadingProps) {
  const isCenter = align === "center";
  return (
    <div className={isCenter ? "text-center" : "text-left"}>
      <span className="eyebrow">{eyebrow}</span>
      <h2
        className={`mt-4 font-display text-4xl sm:text-5xl leading-[1.1] text-bone ${
          isCenter ? "mx-auto" : ""
        }`}
      >
        {title}
      </h2>
      <div className="mt-5">
        <SectionDivider align={align} />
      </div>
      {description && (
        <p
          className={`mt-6 text-stone text-base sm:text-lg leading-relaxed max-w-xl ${
            isCenter ? "mx-auto" : ""
          }`}
        >
          {description}
        </p>
      )}
    </div>
  );
}
