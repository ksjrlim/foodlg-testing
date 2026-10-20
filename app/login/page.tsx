import { Top } from "@/components/Top";
import { AuthForm } from "@/components/AuthForm";
import { dietitianSignIn } from "@/lib/auth";

export default function Login() {
  return (
    <main className="shell narrow">
      <Top label="Dietitian" />
      <h1>Sign in</h1>
      <AuthForm action={dietitianSignIn} submit="Sign in" fields={[
        { name: "email", label: "Email", type: "email", inputMode: "email", autoComplete: "username" },
        { name: "password", label: "Password", type: "password", autoComplete: "current-password" }]} />
    </main>
  );
}
