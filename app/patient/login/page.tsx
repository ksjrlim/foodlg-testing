import { Top } from "@/components/Top";
import { AuthForm } from "@/components/AuthForm";
import { patientSignIn } from "@/lib/auth";

export default function PatientLogin() {
  return (
    <main className="shell narrow">
      <Top label="Patient" />
      <h1>Welcome back</h1>
      <p className="muted small">Your code is on the card your dietitian gave you, for example P-0001.</p>
      <AuthForm action={patientSignIn} submit="Continue" fields={[
        { name: "code", label: "Your code", autoComplete: "username" },
        { name: "passcode", label: "Your 6-digit passcode", type: "password", inputMode: "numeric", pattern: "\\d{6}", maxLength: 6, autoComplete: "current-password" }]} />
    </main>
  );
}
