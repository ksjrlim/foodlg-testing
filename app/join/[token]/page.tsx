import { Top } from "@/components/Top";
import { AuthForm } from "@/components/AuthForm";
import { redeemInvite } from "@/lib/auth";

export default async function Join({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="shell narrow">
      <Top label="Patient" />
      <h1>Join FoodLG</h1>
      <div className="card small">
        <h3>Before you start</h3>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>FoodLG helps you try the drink change you agreed with your dietitian.</li>
          <li>We store only a code, not your name. Your answers are shared with your dietitian.</li>
          <li>It does not watch your health in real time. For anything urgent, contact your clinic.</li>
          <li>You can stop at any time by telling your dietitian.</li>
        </ul>
        <p className="muted">Test version: synthetic data only.</p>
      </div>
      <AuthForm action={redeemInvite} submit="Join" hidden={{ token }} fields={[
        { name: "passcode", label: "Choose a 6-digit passcode", type: "password", inputMode: "numeric", pattern: "\\d{6}", maxLength: 6, autoComplete: "new-password" },
        { name: "confirm", label: "Type it again", type: "password", inputMode: "numeric", pattern: "\\d{6}", maxLength: 6, autoComplete: "new-password" }]}>
        <label className="row small" style={{ justifyContent: "flex-start", fontWeight: 600 }}>
          <input type="checkbox" name="consent" value="yes" required /> I understand and agree to take part
        </label>
      </AuthForm>
    </main>
  );
}
