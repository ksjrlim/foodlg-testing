import Link from "next/link";
import { Top } from "@/components/Top";

export default function Home() {
  return (
    <main className="shell narrow">
      <Top label="Validation MVP" />
      <h1>Support for the drink change you agreed with your dietitian</h1>
      <p className="muted">This is a test version with synthetic data. Do not enter real personal or health information.</p>
      <div className="stack">
        <Link className="btn primary" href="/patient/login">I'm a patient</Link>
        <Link className="btn ghost" href="/login">I'm a dietitian</Link>
      </div>
    </main>
  );
}
